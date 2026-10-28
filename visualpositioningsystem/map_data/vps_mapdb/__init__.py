"""vps_mapdb -- build a local OSM + imagery reference database for a VPS.

Modules
-------
config     : :class:`BBox` and :class:`BuildConfig` (validated settings)
net        : rate limiting and retry-aware HTTP client
tiles      : XYZ / Web Mercator tile mathematics (pure functions)
storage    : on-disk layout, atomic writes, GeoJSON sanitising
overpass   : direct Overpass API client (standalone + osmnx fallback)
osm_source : osmnx-backed vector acquisition with version compatibility
imagery    : raster tile provider registry and parallel downloader
pipeline   : :class:`MapDatabaseBuilder` orchestration + manifest
"""

from __future__ import annotations

from .config import DEFAULT_FEATURE_LAYERS, BBox, BuildConfig
from .imagery import PROVIDERS, ImageryDownloader, TileProvider
from .net import HttpClient, RateLimiter
from .osm_source import OsmVectorSource
from .overpass import OverpassClient
from .pipeline import MapDatabaseBuilder, summarise
from .storage import Storage
from .tiles import Tile, count_tiles, deg2num, iter_tiles, num2deg

__version__ = "1.0.0"

__all__ = [
    "BBox",
    "BuildConfig",
    "DEFAULT_FEATURE_LAYERS",
    "HttpClient",
    "ImageryDownloader",
    "MapDatabaseBuilder",
    "OsmVectorSource",
    "OverpassClient",
    "PROVIDERS",
    "RateLimiter",
    "Storage",
    "Tile",
    "TileProvider",
    "count_tiles",
    "deg2num",
    "iter_tiles",
    "num2deg",
    "summarise",
    "__version__",
]
