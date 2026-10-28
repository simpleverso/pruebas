"""Raster imagery acquisition over the XYZ tile grid.

Each provider is declared once in :data:`PROVIDERS` with its URL template,
licence, attribution string and zoom limits. Downloads are parallel but share a
single global rate limiter, resume automatically (existing files are skipped)
and produce a ``tile_index.geojson`` so the VPS can map a camera pose straight
to an image file.

Attribution is not optional: every provider's ``attribution`` string is written
into the manifest and the tile index, and must be surfaced by any product
built on this data.
"""

from __future__ import annotations

import itertools
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .config import BuildConfig
from .net import HttpClient, PermanentHTTPError, TransientHTTPError
from .storage import Storage
from .tiles import Tile, count_tiles, iter_tiles, tile_to_geojson_feature

LOG = logging.getLogger(__name__)

# Content types we accept as real imagery, mapped to a file extension.
IMAGE_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/tiff": "tif",
}

# Below this size a response is almost certainly an error placeholder, not a tile.
MIN_PLAUSIBLE_TILE_BYTES = 300


@dataclass(frozen=True)
class TileProvider:
    """Declarative description of an XYZ raster endpoint."""

    name: str
    url_template: str
    attribution: str
    licence: str
    extension: str = "png"
    min_zoom: int = 0
    max_zoom: int = 19
    subdomains: Sequence[str] = field(default_factory=tuple)
    api_key_name: Optional[str] = None  # key into BuildConfig.api_keys
    coverage: str = "global"
    notes: str = ""

    def requires_key(self) -> bool:
        return self.api_key_name is not None

    def build_url(self, tile: Tile, api_key: Optional[str], subdomain: str = "") -> str:
        """Render the URL template for one tile."""
        url = self.url_template.format(
            z=tile.z, x=tile.x, y=tile.y, s=subdomain, key=api_key or ""
        )
        if self.requires_key() and not api_key:
            raise PermanentHTTPError(
                f"Provider {self.name!r} needs credentials; set the "
                f"{self.api_key_name.upper()} API key environment variable."
            )
        return url

    def describe(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "attribution": self.attribution,
            "licence": self.licence,
            "coverage": self.coverage,
            "min_zoom": self.min_zoom,
            "max_zoom": self.max_zoom,
            "notes": self.notes,
        }


# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

PROVIDERS: Dict[str, TileProvider] = {
    # --- open / public-domain aerial imagery (best default for a VPS) ------
    "usgs_imagery": TileProvider(
        name="usgs_imagery",
        url_template=(
            "https://basemap.nationalmap.gov/arcgis/rest/services/"
            "USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"
        ),
        attribution="USGS The National Map: Orthoimagery",
        licence="Public domain (U.S. Government work)",
        extension="jpg",
        # The service advertises LODs up to 23, but the cache is only seeded to
        # level 16; z17+ returns HTTP 404. Verified 2026-10 over San Francisco.
        max_zoom=16,
        coverage="United States and territories",
        notes=(
            "Cache is populated to z16 only; higher zooms 404. Returns a blank "
            "tile outside U.S. coverage. Use esri_world_imagery or "
            "mapbox_satellite for sub-metre resolution."
        ),
    ),
    "usgs_topo": TileProvider(
        name="usgs_topo",
        url_template=(
            "https://basemap.nationalmap.gov/arcgis/rest/services/"
            "USGSTopo/MapServer/tile/{z}/{y}/{x}"
        ),
        attribution="USGS The National Map: National Boundaries Dataset",
        licence="Public domain (U.S. Government work)",
        extension="jpg",
        max_zoom=16,
        coverage="United States and territories",
    ),
    # --- open topographic raster (global) ---------------------------------
    "opentopomap": TileProvider(
        name="opentopomap",
        url_template="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
        attribution="Map data: (c) OpenStreetMap contributors, SRTM | "
                    "Rendering: (c) OpenTopoMap (CC-BY-SA)",
        licence="CC-BY-SA 3.0",
        subdomains=("a", "b", "c"),
        max_zoom=17,
        notes="Volunteer-funded. Keep the request rate low and cache locally.",
    ),
    "osm_standard": TileProvider(
        name="osm_standard",
        url_template="https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution="(c) OpenStreetMap contributors",
        licence="ODbL 1.0 (data) / CC-BY-SA (tiles)",
        max_zoom=19,
        notes=(
            "The OSMF tile usage policy forbids bulk downloading. Use only for "
            "small areas, or run your own renderer for production workloads."
        ),
    ),
    # --- commercial providers (credentials required) ----------------------
    "mapbox_satellite": TileProvider(
        name="mapbox_satellite",
        url_template=(
            "https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90"
            "?access_token={key}"
        ),
        attribution="(c) Mapbox (c) Maxar",
        licence="Mapbox Terms of Service",
        extension="jpg",
        max_zoom=22,
        api_key_name="mapbox",
        notes="Set MAPBOX_ACCESS_TOKEN. Billed per tile request.",
    ),
    "maptiler_satellite": TileProvider(
        name="maptiler_satellite",
        url_template="https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}",
        attribution="(c) MapTiler (c) OpenStreetMap contributors",
        licence="MapTiler Terms of Service",
        extension="jpg",
        max_zoom=20,
        api_key_name="maptiler",
        notes="Set MAPTILER_API_KEY.",
    ),
    "esri_world_imagery": TileProvider(
        name="esri_world_imagery",
        url_template=(
            "https://server.arcgisonline.com/ArcGIS/rest/services/"
            "World_Imagery/MapServer/tile/{z}/{y}/{x}"
        ),
        attribution="Esri, Maxar, Earthstar Geographics and the GIS User Community",
        licence="Esri Terms of Use -- verify before redistribution",
        extension="jpg",
        max_zoom=19,
        notes=(
            "Needs no API key and serves true aerial imagery to z19, so it is "
            "the practical high-resolution option. Free for evaluation; review "
            "Esri's terms before production use."
        ),
    ),
}


def resolve_provider(name: str) -> TileProvider:
    try:
        return PROVIDERS[name]
    except KeyError:
        raise ValueError(
            f"Unknown imagery provider {name!r}. Available: {', '.join(sorted(PROVIDERS))}"
        ) from None


# ---------------------------------------------------------------------------
# Download results
# ---------------------------------------------------------------------------


@dataclass
class TileResult:
    """Outcome of a single tile download."""

    tile: Tile
    status: str  # downloaded | cached | skipped | failed
    path: Optional[Path] = None
    size_bytes: int = 0
    error: Optional[str] = None


class ImageryDownloader:
    """Fetches the raster tile pyramid for one provider."""

    def __init__(self, config: BuildConfig, storage: Storage, client: HttpClient) -> None:
        self.config = config
        self.storage = storage
        self.client = client
        self._index_lock = threading.Lock()

    # -- planning -----------------------------------------------------------

    def effective_zooms(self, provider: TileProvider) -> List[int]:
        """Requested zooms clamped to what the provider actually serves."""
        usable = [z for z in self.config.zoom_levels if provider.min_zoom <= z <= provider.max_zoom]
        dropped = sorted(set(self.config.zoom_levels) - set(usable))
        if dropped:
            LOG.warning(
                "Provider %s serves z%d-z%d; dropping requested zoom(s) %s.",
                provider.name, provider.min_zoom, provider.max_zoom, dropped,
            )
        return usable

    def plan(self, provider: TileProvider) -> Tuple[List[Tile], Dict[int, int]]:
        """Enumerate the tiles to fetch, honouring ``max_tiles_per_provider``."""
        per_zoom: Dict[int, int] = {}
        tiles: List[Tile] = []
        budget = self.config.max_tiles_per_provider

        for zoom in self.effective_zooms(provider):
            total = count_tiles(self.config.bbox, zoom)
            per_zoom[zoom] = total
            if budget <= 0:
                continue
            zoom_tiles = list(itertools.islice(iter_tiles(self.config.bbox, zoom), budget))
            if len(zoom_tiles) < total:
                LOG.warning(
                    "Tile budget reached at z%d: taking %d of %d tiles. "
                    "Raise --max-tiles or shrink the bounding box.",
                    zoom, len(zoom_tiles), total,
                )
            tiles.extend(zoom_tiles)
            budget -= len(zoom_tiles)

        return tiles, per_zoom

    # -- single tile --------------------------------------------------------

    def _fetch_tile(self, provider: TileProvider, tile: Tile, api_key: Optional[str],
                    subdomain: str) -> TileResult:
        """Download one tile, skipping it if a valid file already exists."""
        path = self.storage.tile_path(provider.name, tile, provider.extension)

        # Resume support: a non-trivial existing file is treated as complete.
        if path.is_file() and not self.config.overwrite:
            size = path.stat().st_size
            if size >= MIN_PLAUSIBLE_TILE_BYTES:
                return TileResult(tile=tile, status="cached", path=path, size_bytes=size)

        try:
            url = provider.build_url(tile, api_key, subdomain)
        except PermanentHTTPError as exc:
            return TileResult(tile=tile, status="failed", error=str(exc))

        try:
            response = self.client.get(url, stream=True)
        except PermanentHTTPError as exc:
            # 404 simply means "no tile here" for many providers.
            return TileResult(tile=tile, status="skipped", error=str(exc))
        except TransientHTTPError as exc:
            return TileResult(tile=tile, status="failed", error=str(exc))

        try:
            content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            payload = response.content
        except Exception as exc:  # body read can still time out mid-stream
            return TileResult(tile=tile, status="failed", error=f"body read failed: {exc}")
        finally:
            response.close()

        if content_type and content_type not in IMAGE_EXTENSIONS:
            # An HTML/JSON body here means an error page or a quota message.
            snippet = payload[:120].decode("utf-8", "replace")
            return TileResult(
                tile=tile, status="failed",
                error=f"unexpected content-type {content_type!r}: {snippet}",
            )
        if len(payload) < MIN_PLAUSIBLE_TILE_BYTES:
            return TileResult(
                tile=tile, status="skipped",
                error=f"response too small ({len(payload)} bytes); likely empty coverage",
            )

        # Trust the served content type over the provider's declared extension.
        extension = IMAGE_EXTENSIONS.get(content_type, provider.extension)
        path = self.storage.tile_path(provider.name, tile, extension)
        try:
            self.storage.write_bytes(path, payload)
        except OSError as exc:
            return TileResult(tile=tile, status="failed", error=f"write failed: {exc}")

        return TileResult(tile=tile, status="downloaded", path=path, size_bytes=len(payload))

    # -- provider run -------------------------------------------------------

    def download_provider(self, provider_name: str, progress: Optional[Any] = None) -> Dict[str, Any]:
        """Download every planned tile for one provider and index the results."""
        provider = resolve_provider(provider_name)
        api_key = self.config.api_keys.get(provider.api_key_name or "")
        if provider.requires_key() and not api_key:
            LOG.error(
                "Skipping provider %s: no credentials found (expected %s).",
                provider.name, (provider.api_key_name or "").upper(),
            )
            return {
                **provider.describe(),
                "error": "missing credentials",
                "tiles_requested": 0,
            }

        tiles, per_zoom = self.plan(provider)
        summary: Dict[str, Any] = {
            **provider.describe(),
            "tiles_available_per_zoom": per_zoom,
            "tiles_requested": len(tiles),
            "tiles_downloaded": 0,
            "tiles_cached": 0,
            "tiles_skipped": 0,
            "tiles_failed": 0,
            "bytes_downloaded": 0,
            "directory": self.storage.relative(self.storage.provider_dir(provider.name)),
        }
        if self.config.dry_run or not tiles:
            return summary

        subdomains = list(provider.subdomains) or [""]
        index_features: List[Dict[str, Any]] = []
        failures: List[Dict[str, str]] = []

        # Threads overlap network latency; the shared RateLimiter keeps the
        # aggregate request rate inside the provider's usage policy.
        with ThreadPoolExecutor(max_workers=self.config.imagery_workers) as pool:
            futures = {
                pool.submit(
                    self._fetch_tile, provider, tile, api_key,
                    subdomains[i % len(subdomains)],
                ): tile
                for i, tile in enumerate(tiles)
            }

            for future in as_completed(futures):
                tile = futures[future]
                try:
                    result = future.result()
                except Exception as exc:  # pragma: no cover - worker safety net
                    LOG.exception("Unhandled error on tile %s", tile.key)
                    result = TileResult(tile=tile, status="failed", error=str(exc))

                summary[f"tiles_{result.status}"] = summary.get(f"tiles_{result.status}", 0) + 1
                summary["bytes_downloaded"] += (
                    result.size_bytes if result.status == "downloaded" else 0
                )

                if result.status in {"downloaded", "cached"} and result.path is not None:
                    feature = tile_to_geojson_feature(
                        result.tile,
                        {
                            "provider": provider.name,
                            "file": self.storage.relative(result.path),
                            "size_bytes": result.size_bytes,
                            "attribution": provider.attribution,
                        },
                    )
                    with self._index_lock:
                        index_features.append(feature)
                elif result.error:
                    failures.append({"tile": tile.key, "status": result.status,
                                     "error": result.error[:300]})

                if progress is not None:
                    progress.update(1)

        # Sort for deterministic output, then write the spatial index.
        index_features.sort(key=lambda f: (f["properties"]["z"],
                                           f["properties"]["x"],
                                           f["properties"]["y"]))
        index_summary = self.storage.write_geojson(
            self.storage.provider_dir(provider.name) / "tile_index.geojson",
            index_features,
            extra={
                "provider": provider.describe(),
                "tile_size_px": 256,
                "crs_note": "Tile footprints are WGS84; imagery is Web Mercator (EPSG:3857).",
            },
        )
        summary["tile_index"] = index_summary["path"]

        # A provider that returns nothing usable is a misconfiguration, not a
        # quiet success: surface it instead of letting an empty cache look fine.
        usable = summary["tiles_downloaded"] + summary["tiles_cached"]
        if summary["tiles_requested"] and usable == 0:
            reason = (
                f"no usable tiles from {provider.name}: "
                f"{summary['tiles_skipped']} empty/not-found, "
                f"{summary['tiles_failed']} failed"
            )
            LOG.error(
                "%s. Check that the area is inside '%s' coverage and that the "
                "zoom level is within z%d-z%d.",
                reason, provider.coverage, provider.min_zoom, provider.max_zoom,
            )
            summary["error"] = reason
        if failures:
            # Cap the stored failure list; the log already has the full detail.
            summary["failures"] = failures[:50]
            summary["failure_count"] = len(failures)
        return summary

    def run(self, progress: Optional[Any] = None) -> Dict[str, Any]:
        """Download imagery for every configured provider."""
        results: Dict[str, Any] = {}
        for provider_name in self.config.imagery_providers:
            if progress is not None:
                progress.set_postfix_str(f"imagery:{provider_name}", refresh=True)
            try:
                results[provider_name] = self.download_provider(provider_name, progress)
            except ValueError as exc:  # unknown provider name
                LOG.error("%s", exc)
                results[provider_name] = {"error": str(exc)}
        return results

    def step_count(self) -> int:
        """Total tiles across all providers, for sizing the progress bar."""
        total = 0
        for provider_name in self.config.imagery_providers:
            try:
                provider = resolve_provider(provider_name)
            except ValueError:
                continue
            if provider.requires_key() and not self.config.api_keys.get(provider.api_key_name or ""):
                continue
            tiles, _ = self.plan(provider)
            total += len(tiles)
        return total
