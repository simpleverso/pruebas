"""Configuration objects for the VPS map reference database builder.

Everything the pipeline needs is funnelled through :class:`BuildConfig`, so the
CLI, library callers and tests all share one validated source of truth.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Geographic bounding box
# ---------------------------------------------------------------------------

# Web-Mercator (EPSG:3857) cannot represent the poles; slippy-map tiles are
# therefore clamped to this latitude range.
MERCATOR_MAX_LAT = 85.0511287798066


@dataclass(frozen=True)
class BBox:
    """An axis-aligned geographic bounding box in WGS84 degrees."""

    south: float
    west: float
    north: float
    east: float

    def __post_init__(self) -> None:
        if not (-90.0 <= self.south < self.north <= 90.0):
            raise ValueError(
                f"Invalid latitudes: south={self.south} must be < north={self.north} "
                "and both within [-90, 90]."
            )
        if not (-180.0 <= self.west < self.east <= 180.0):
            raise ValueError(
                f"Invalid longitudes: west={self.west} must be < east={self.east} "
                "and both within [-180, 180]. Boxes crossing the antimeridian must "
                "be split into two requests."
            )
        if abs(self.north) > MERCATOR_MAX_LAT or abs(self.south) > MERCATOR_MAX_LAT:
            raise ValueError(
                "Bounding box exceeds the Web Mercator limit of "
                f"+/-{MERCATOR_MAX_LAT:.4f} deg latitude; raster tiles do not exist there."
            )

    # -- constructors -------------------------------------------------------

    @classmethod
    def parse(cls, text: str) -> "BBox":
        """Parse ``"south,west,north,east"`` (the order used by OSM/Overpass)."""
        parts = [p.strip() for p in re.split(r"[,\s]+", text.strip()) if p.strip()]
        if len(parts) != 4:
            raise ValueError(
                "Bounding box must be 'south,west,north,east', e.g. "
                "'40.410,-3.712,40.425,-3.690'."
            )
        try:
            south, west, north, east = (float(p) for p in parts)
        except ValueError as exc:  # pragma: no cover - message clarity only
            raise ValueError(f"Non-numeric value in bounding box {text!r}.") from exc
        return cls(south=south, west=west, north=north, east=east)

    # -- derived values -----------------------------------------------------

    @property
    def center(self) -> Tuple[float, float]:
        """``(lat, lon)`` of the box centre."""
        return ((self.south + self.north) / 2.0, (self.west + self.east) / 2.0)

    def as_osmnx(self) -> Tuple[float, float, float, float]:
        """``(west, south, east, north)`` -- the osmnx >= 2.0 bbox order."""
        return (self.west, self.south, self.east, self.north)

    def as_overpass(self) -> str:
        """``"south,west,north,east"`` -- the Overpass QL bbox filter order."""
        return f"{self.south},{self.west},{self.north},{self.east}"

    def as_geojson_bbox(self) -> List[float]:
        """``[west, south, east, north]`` -- RFC 7946 bbox order."""
        return [self.west, self.south, self.east, self.north]

    def as_polygon_coords(self) -> List[List[float]]:
        """Closed ring of the box, suitable for a GeoJSON Polygon."""
        return [
            [self.west, self.south],
            [self.east, self.south],
            [self.east, self.north],
            [self.west, self.north],
            [self.west, self.south],
        ]

    def slug(self) -> str:
        """Stable, filesystem-safe identifier for this box (used as region id)."""
        raw = f"{self.south:.6f}_{self.west:.6f}_{self.north:.6f}_{self.east:.6f}"
        digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
        lat, lon = self.center
        ns = "N" if lat >= 0 else "S"
        ew = "E" if lon >= 0 else "W"
        return f"bbox_{abs(lat):.4f}{ns}_{abs(lon):.4f}{ew}_{digest}"


# ---------------------------------------------------------------------------
# Build configuration
# ---------------------------------------------------------------------------

# OSM tags harvested for the vector layers. Keys map to a tag filter accepted by
# both osmnx and the Overpass query builder.
DEFAULT_FEATURE_LAYERS: Dict[str, Dict[str, object]] = {
    # Building footprints are the backbone of a VPS reference map.
    "buildings": {"building": True},
    # Vertical structures double as long-range visual landmarks.
    "landmarks": {
        "man_made": ["tower", "mast", "water_tower", "chimney", "obelisk"],
        "tourism": ["attraction", "artwork", "viewpoint"],
        "historic": ["monument", "memorial", "castle"],
    },
    # Street furniture is dense, stable and usually visible from the ground.
    "street_furniture": {
        "highway": ["street_lamp", "traffic_signals", "crossing"],
        "amenity": ["bench", "fountain", "clock"],
        "advertising": ["billboard", "column"],
    },
    # Land cover helps mask non-informative regions during image matching.
    "landuse": {"landuse": True, "natural": True, "leisure": ["park", "pitch"]},
}


@dataclass
class BuildConfig:
    """Validated, fully resolved settings for one database build."""

    bbox: BBox
    output_root: Path = Path("map_data")

    # -- vector (OSM) options ----------------------------------------------
    vector_backend: str = "auto"  # auto | osmnx | overpass | none
    network_type: str = "drive"  # osmnx street-graph flavour
    feature_layers: Dict[str, Dict[str, object]] = field(
        default_factory=lambda: dict(DEFAULT_FEATURE_LAYERS)
    )
    overpass_endpoint: str = "https://overpass-api.de/api/interpreter"
    overpass_timeout_s: int = 180

    # -- raster (imagery) options ------------------------------------------
    imagery_providers: List[str] = field(default_factory=lambda: ["usgs_imagery"])
    # z16 is the highest level the default (public-domain USGS) provider caches.
    zoom_levels: List[int] = field(default_factory=lambda: [16])
    max_tiles_per_provider: int = 4000
    imagery_workers: int = 4

    # -- networking --------------------------------------------------------
    requests_per_second: float = 2.0
    max_retries: int = 4
    connect_timeout_s: float = 10.0
    read_timeout_s: float = 60.0
    user_agent: str = (
        "vps-mapdb/1.0 (local Visual Positioning System reference builder; "
        "contact: set VPS_CONTACT env var)"
    )

    # -- behaviour ---------------------------------------------------------
    overwrite: bool = False
    dry_run: bool = False
    api_keys: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.output_root = Path(self.output_root).expanduser()

        if self.vector_backend not in {"auto", "osmnx", "overpass", "none"}:
            raise ValueError(f"Unknown vector_backend {self.vector_backend!r}.")
        if not self.zoom_levels:
            raise ValueError("At least one zoom level is required.")
        for z in self.zoom_levels:
            if not 0 <= z <= 22:
                raise ValueError(f"Zoom level {z} outside the supported range 0-22.")
        self.zoom_levels = sorted(set(int(z) for z in self.zoom_levels))

        if self.requests_per_second <= 0:
            raise ValueError("requests_per_second must be > 0.")
        self.imagery_workers = max(1, int(self.imagery_workers))

        # A contact address is required by most public tile usage policies.
        contact = os.environ.get("VPS_CONTACT", "").strip()
        if contact:
            self.user_agent = f"vps-mapdb/1.0 (contact: {contact})"

        # Provider credentials are read from the environment, never hard-coded.
        for env_name, key in (
            ("MAPBOX_ACCESS_TOKEN", "mapbox"),
            ("MAPTILER_API_KEY", "maptiler"),
        ):
            value = os.environ.get(env_name, "").strip()
            if value:
                self.api_keys.setdefault(key, value)

    # -- derived paths ------------------------------------------------------

    @property
    def region_id(self) -> str:
        return self.bbox.slug()

    @property
    def region_dir(self) -> Path:
        return self.output_root / self.region_id

    @property
    def timeout(self) -> Tuple[float, float]:
        """``(connect, read)`` tuple in the shape ``requests`` expects."""
        return (self.connect_timeout_s, self.read_timeout_s)

    def describe(self) -> Dict[str, object]:
        """JSON-serialisable snapshot for the run manifest (secrets redacted)."""
        return {
            "region_id": self.region_id,
            "bbox": {
                "south": self.bbox.south,
                "west": self.bbox.west,
                "north": self.bbox.north,
                "east": self.bbox.east,
            },
            "output_root": str(self.output_root),
            "vector_backend": self.vector_backend,
            "network_type": self.network_type,
            "feature_layers": sorted(self.feature_layers),
            "overpass_endpoint": self.overpass_endpoint,
            "imagery_providers": list(self.imagery_providers),
            "zoom_levels": list(self.zoom_levels),
            "max_tiles_per_provider": self.max_tiles_per_provider,
            "requests_per_second": self.requests_per_second,
            "max_retries": self.max_retries,
            "credentials_supplied": sorted(self.api_keys),
        }
