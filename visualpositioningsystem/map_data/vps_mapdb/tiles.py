"""Slippy-map (XYZ / Web Mercator) tile mathematics.

Pure functions with no I/O, so the tile grid used to lay out the on-disk cache
can be unit-tested and reused by the VPS runtime to look tiles back up.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterator, List, Tuple

from .config import MERCATOR_MAX_LAT, BBox

EARTH_RADIUS_M = 6378137.0
EARTH_CIRCUMFERENCE_M = 2.0 * math.pi * EARTH_RADIUS_M
TILE_PIXELS = 256


@dataclass(frozen=True)
class Tile:
    """A single XYZ tile plus its geographic footprint."""

    z: int
    x: int
    y: int

    @property
    def key(self) -> str:
        return f"{self.z}/{self.x}/{self.y}"

    def bounds(self) -> BBox:
        """Geographic extent of this tile (north-west origin convention)."""
        north, west = num2deg(self.x, self.y, self.z)
        south, east = num2deg(self.x + 1, self.y + 1, self.z)
        # Clamp to the Mercator limit so BBox validation never trips at z<=1.
        north = min(north, MERCATOR_MAX_LAT)
        south = max(south, -MERCATOR_MAX_LAT)
        return BBox(south=south, west=west, north=north, east=east)

    def center(self) -> Tuple[float, float]:
        return self.bounds().center


# ---------------------------------------------------------------------------
# Coordinate conversions
# ---------------------------------------------------------------------------


def deg2num(lat: float, lon: float, zoom: int) -> Tuple[int, int]:
    """Convert ``(lat, lon)`` to integer tile ``(x, y)`` at ``zoom``."""
    lat = max(-MERCATOR_MAX_LAT, min(MERCATOR_MAX_LAT, lat))
    lat_rad = math.radians(lat)
    n = 2.0 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    # Guard against the right/bottom edge landing one tile out of range.
    max_index = int(n) - 1
    return (min(max(x, 0), max_index), min(max(y, 0), max_index))


def num2deg(x: float, y: float, zoom: int) -> Tuple[float, float]:
    """Convert tile ``(x, y)`` to the ``(lat, lon)`` of its north-west corner."""
    n = 2.0 ** zoom
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    return (lat, lon)


def ground_resolution_m_per_px(lat: float, zoom: int) -> float:
    """Metres per pixel at ``lat`` and ``zoom`` -- the VPS scale reference."""
    lat = max(-MERCATOR_MAX_LAT, min(MERCATOR_MAX_LAT, lat))
    return (
        math.cos(math.radians(lat))
        * EARTH_CIRCUMFERENCE_M
        / (TILE_PIXELS * 2.0 ** zoom)
    )


# ---------------------------------------------------------------------------
# Grid enumeration
# ---------------------------------------------------------------------------


def tile_range(bbox: BBox, zoom: int) -> Tuple[int, int, int, int]:
    """Return ``(x_min, y_min, x_max, y_max)`` covering ``bbox`` at ``zoom``."""
    x_min, y_min = deg2num(bbox.north, bbox.west, zoom)  # NW corner
    x_max, y_max = deg2num(bbox.south, bbox.east, zoom)  # SE corner
    return (min(x_min, x_max), min(y_min, y_max), max(x_min, x_max), max(y_min, y_max))


def count_tiles(bbox: BBox, zoom: int) -> int:
    """Tile count for ``bbox`` at ``zoom`` without materialising the list."""
    x_min, y_min, x_max, y_max = tile_range(bbox, zoom)
    return (x_max - x_min + 1) * (y_max - y_min + 1)


def iter_tiles(bbox: BBox, zoom: int) -> Iterator[Tile]:
    """Yield every tile intersecting ``bbox`` at ``zoom``, row-major."""
    x_min, y_min, x_max, y_max = tile_range(bbox, zoom)
    for y in range(y_min, y_max + 1):
        for x in range(x_min, x_max + 1):
            yield Tile(z=zoom, x=x, y=y)


def tiles_for_zooms(bbox: BBox, zooms: List[int]) -> List[Tile]:
    """Flatten :func:`iter_tiles` across several zoom levels."""
    tiles: List[Tile] = []
    for zoom in sorted(set(zooms)):
        tiles.extend(iter_tiles(bbox, zoom))
    return tiles


def tile_to_geojson_feature(tile: Tile, properties: dict) -> dict:
    """Build a GeoJSON Polygon feature for a tile footprint.

    The resulting index lets the VPS resolve "which image covers this camera
    pose?" with a cheap spatial lookup instead of re-deriving tile maths.
    """
    bounds = tile.bounds()
    lat, lon = bounds.center
    props = {
        "tile_key": tile.key,
        "z": tile.z,
        "x": tile.x,
        "y": tile.y,
        "south": bounds.south,
        "west": bounds.west,
        "north": bounds.north,
        "east": bounds.east,
        "center_lat": lat,
        "center_lon": lon,
        "ground_resolution_m_per_px": round(
            ground_resolution_m_per_px(lat, tile.z), 6
        ),
    }
    props.update(properties)
    return {
        "type": "Feature",
        "bbox": bounds.as_geojson_bbox(),
        "geometry": {"type": "Polygon", "coordinates": [bounds.as_polygon_coords()]},
        "properties": props,
    }
