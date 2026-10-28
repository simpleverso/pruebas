"""On-disk layout for the VPS map reference database.

Directory contract (stable; the VPS runtime depends on it)::

    map_data/
      <region_id>/
        manifest.json                     run metadata + layer inventory
        bbox.geojson                      the requested area as a polygon
        vector/
          buildings.geojson               OSM building footprints
          landmarks.geojson               towers, monuments, viewpoints, ...
          street_furniture.geojson        lamps, signals, benches, ...
          landuse.geojson                 land cover / masking polygons
          roads_edges.geojson             street-graph edges (osmnx)
          roads_nodes.geojson             street-graph nodes (osmnx)
          street_graph.graphml            routable graph (osmnx)
          overpass_raw.json               unmodified Overpass response
        imagery/
          <provider>/
            tile_index.geojson            tile footprints -> file paths
            <z>/<x>/<y>.<ext>             raw, untouched image bytes
"""

from __future__ import annotations

import json
import logging
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .config import BuildConfig
from .tiles import Tile

LOG = logging.getLogger(__name__)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Storage:
    """Resolves paths and performs atomic, crash-safe writes."""

    def __init__(self, config: BuildConfig) -> None:
        self.config = config
        self.region_dir = config.region_dir
        self.vector_dir = self.region_dir / "vector"
        self.imagery_dir = self.region_dir / "imagery"

    # -- directories --------------------------------------------------------

    def prepare(self) -> None:
        """Create the directory skeleton (no-op if it already exists)."""
        for path in (self.region_dir, self.vector_dir, self.imagery_dir):
            path.mkdir(parents=True, exist_ok=True)

    def provider_dir(self, provider: str) -> Path:
        return self.imagery_dir / provider

    def tile_path(self, provider: str, tile: Tile, extension: str) -> Path:
        """``imagery/<provider>/<z>/<x>/<y>.<ext>`` -- the XYZ convention."""
        ext = extension.lstrip(".")
        return self.provider_dir(provider) / str(tile.z) / str(tile.x) / f"{tile.y}.{ext}"

    def relative(self, path: Path) -> str:
        """POSIX path relative to the region dir, for portable manifests."""
        try:
            return path.relative_to(self.region_dir).as_posix()
        except ValueError:
            return path.as_posix()

    # -- atomic writers -----------------------------------------------------

    @staticmethod
    def _atomic_write(path: Path, payload: bytes) -> None:
        """Write via a temp file + rename so readers never see a partial file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".part")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, path)
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise

    def write_json(self, path: Path, obj: Any) -> Path:
        payload = json.dumps(obj, indent=2, ensure_ascii=False, default=_json_default)
        self._atomic_write(path, payload.encode("utf-8"))
        return path

    def write_bytes(self, path: Path, payload: bytes) -> Path:
        self._atomic_write(path, payload)
        return path

    def write_geojson(
        self, path: Path, features: Iterable[Dict[str, Any]], extra: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Write a FeatureCollection and return a small summary dict."""
        feature_list = [sanitise_feature(f) for f in features]
        collection: Dict[str, Any] = {
            "type": "FeatureCollection",
            "bbox": self.config.bbox.as_geojson_bbox(),
            "features": feature_list,
        }
        if extra:
            collection.update(extra)
        self.write_json(path, collection)
        summary = {
            "path": self.relative(path),
            "feature_count": len(feature_list),
            "geometry_types": sorted(
                {
                    (f.get("geometry") or {}).get("type", "None")
                    for f in feature_list
                }
            ),
        }
        LOG.info("Wrote %d features -> %s", len(feature_list), path)
        return summary

    # -- fixed artefacts ----------------------------------------------------

    def write_bbox_geojson(self) -> Dict[str, Any]:
        """Persist the requested area so downstream tools need no arguments."""
        bbox = self.config.bbox
        lat, lon = bbox.center
        feature = {
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [bbox.as_polygon_coords()]},
            "properties": {
                "region_id": self.config.region_id,
                "center_lat": lat,
                "center_lon": lon,
                "created_utc": utc_now_iso(),
            },
        }
        return self.write_geojson(self.region_dir / "bbox.geojson", [feature])

    def write_manifest(self, manifest: Dict[str, Any]) -> Path:
        return self.write_json(self.region_dir / "manifest.json", manifest)

    def read_manifest(self) -> Dict[str, Any]:
        path = self.region_dir / "manifest.json"
        if not path.is_file():
            return {}
        try:
            with path.open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            LOG.warning("Ignoring unreadable manifest %s: %s", path, exc)
            return {}


# ---------------------------------------------------------------------------
# JSON / GeoJSON sanitising
# ---------------------------------------------------------------------------


def _json_default(value: Any) -> Any:
    """Last-resort encoder for numpy scalars, dates, shapely objects, ..."""
    for attr in ("item", "isoformat"):  # numpy scalars, datetimes
        method = getattr(value, attr, None)
        if callable(method):
            try:
                return method()
            except Exception:  # pragma: no cover - defensive
                pass
    if isinstance(value, (set, frozenset)):
        return sorted(str(v) for v in value)
    return str(value)


def sanitise_value(value: Any) -> Any:
    """Coerce a property value into something strictly JSON-safe.

    OSM tag values arrive from pandas as numpy scalars, ``NaN``, lists or
    shapely geometries. Writing those straight out produces invalid JSON
    (``NaN`` literals) that strict parsers reject, so normalise here.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int,)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, float):
        # NaN/Inf are not valid JSON -- drop them to null.
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple, set, frozenset)):
        cleaned = [sanitise_value(v) for v in value]
        return [v for v in cleaned if v is not None]
    if isinstance(value, dict):
        return {str(k): sanitise_value(v) for k, v in value.items()}

    # numpy / pandas scalars expose .item()
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return sanitise_value(item())
        except Exception:  # pragma: no cover - defensive
            pass
    return str(value)


def sanitise_feature(feature: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of ``feature`` with JSON-safe, null-free properties."""
    props = feature.get("properties") or {}
    clean_props: Dict[str, Any] = {}
    for key, value in props.items():
        cleaned = sanitise_value(value)
        # Empty tags add bulk to every file for no analytical value.
        if cleaned is None or cleaned == "" or cleaned == []:
            continue
        clean_props[str(key)] = cleaned

    out: Dict[str, Any] = {
        "type": "Feature",
        "geometry": feature.get("geometry"),
        "properties": clean_props,
    }
    if feature.get("id") is not None:
        out["id"] = feature["id"]
    if feature.get("bbox") is not None:
        out["bbox"] = feature["bbox"]
    return out


def geodataframe_to_features(gdf: Any) -> List[Dict[str, Any]]:
    """Convert a GeoDataFrame to plain GeoJSON features.

    ``gdf.to_file`` needs a working Fiona/pyogrio stack and ``gdf.to_json``
    chokes on list-valued OSM tags, so go through the lightweight
    ``__geo_interface__`` and sanitise the properties ourselves.
    """
    if gdf is None or len(gdf) == 0:
        return []

    frame = gdf.reset_index()  # osmnx returns a (element_type, osmid) MultiIndex
    features: List[Dict[str, Any]] = []
    for feature in frame.__geo_interface__["features"]:
        if feature.get("geometry") is None:
            continue  # geometry-less rows are useless for positioning
        features.append(sanitise_feature(dict(feature)))
    return features
