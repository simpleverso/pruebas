#!/usr/bin/env python3
"""Drone flight simulator driving the Part 2 Visual Positioning System.

A virtual multirotor flies a predefined path over the reference imagery
downloaded in Part 1. At each step the simulator synthesises a nadir camera
frame by cropping the georeferenced mosaic beneath the drone's true position,
degrades it the way a real sensor would, hands it to the Part 2 VPS, and
reports the tracking error against ground truth.

Coordinate frames
-----------------
WORLD   Local ENU tangent plane in metres, anchored at the mosaic centre.
        X = east, Y = north, Z = altitude above ground. Over the few hundred
        metres a tile set spans, the spherical-to-planar error is millimetric.
GEO     WGS84 latitude/longitude, the VPS input and output frame.
MOSAIC  Pixel coordinates in the stitched north-up Web Mercator raster.

Heading is a compass bearing in degrees: 0 = north, 90 = east. The camera is
body-fixed and nadir-pointing, so the drone's forward direction maps to the
top of the frame, which is exactly the convention the VPS recovers.

Fidelity caveat
---------------
Query frames are cut from the same orthoimagery that populates the reference
database, so this measures the geometric and scoring accuracy of the matching
pipeline, not its robustness to a genuinely different sensor. Seasonal change,
oblique viewing angles, shadow movement, and lens distortion are not modelled.
Treat the error figures as a lower bound on real-world error.

Usage
-----
    python simulator.py --db map_data
    python simulator.py --db map_data --path lawnmower --steps 40 --altitude 120
    python simulator.py --db map_data --plot flight.png --save-frames frames/
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from vps_complete import (
    GeoPose,
    ReferenceDatabase,
    ReferenceImage,
    VisualPositioningSystem,
    VpsConfig,
    haversine_m,
)

LOG = logging.getLogger("sim")

EARTH_RADIUS_M = 6378137.0
TILE_PIXELS = 256


# ===========================================================================
# Geographic helpers
# ===========================================================================


def lonlat_to_global_px(lon: float, lat: float, zoom: int) -> Tuple[float, float]:
    """Forward Web Mercator: ``(lon, lat)`` to fractional global pixel."""
    lat = max(-85.0511287798066, min(85.0511287798066, lat))
    world = TILE_PIXELS * (2.0 ** zoom)
    x = (lon + 180.0) / 360.0 * world
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * world
    return (x, y)


def global_px_to_lonlat(px: float, py: float, zoom: int) -> Tuple[float, float]:
    """Inverse Web Mercator: fractional global pixel to ``(lon, lat)``."""
    world = TILE_PIXELS * (2.0 ** zoom)
    lon = px / world * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * py / world))))
    return (lon, lat)


@dataclass(frozen=True)
class LocalFrame:
    """Local ENU tangent plane anchored at ``(lat0, lon0)``."""

    lat0: float
    lon0: float

    def to_xy(self, lat: float, lon: float) -> Tuple[float, float]:
        """Geographic to local metres (east, north)."""
        x = math.radians(lon - self.lon0) * EARTH_RADIUS_M * math.cos(math.radians(self.lat0))
        y = math.radians(lat - self.lat0) * EARTH_RADIUS_M
        return (x, y)

    def to_latlon(self, x: float, y: float) -> Tuple[float, float]:
        """Local metres (east, north) back to geographic."""
        lat = self.lat0 + math.degrees(y / EARTH_RADIUS_M)
        lon = self.lon0 + math.degrees(
            x / (EARTH_RADIUS_M * math.cos(math.radians(self.lat0)))
        )
        return (lat, lon)


# ===========================================================================
# Georeferenced mosaic
# ===========================================================================


class MapMosaic:
    """Stitches the reference tiles into one north-up georeferenced raster.

    Cropping from a mosaic rather than a single tile matters: a camera
    footprint of any realistic size straddles tile boundaries, and slicing
    only the tile directly beneath the drone would clip the field of view.
    """

    def __init__(self, references: Sequence[ReferenceImage], zoom: Optional[int] = None) -> None:
        tiled = [r for r in references if r.is_tiled]
        if not tiled:
            raise RuntimeError(
                "No tiled references available; the simulator needs XYZ tiles "
                "with known footprints (build them with Part 1)."
            )

        zooms = sorted({int(r.tile_z) for r in tiled})  # type: ignore[arg-type]
        self.zoom = int(zoom) if zoom is not None else zooms[-1]
        if self.zoom not in zooms:
            raise ValueError(f"Zoom z{self.zoom} not in the database (have {zooms}).")

        level = [r for r in tiled if int(r.tile_z) == self.zoom]  # type: ignore[arg-type]
        self.tile_x_min = min(int(r.tile_x) for r in level)  # type: ignore[arg-type]
        self.tile_x_max = max(int(r.tile_x) for r in level)  # type: ignore[arg-type]
        self.tile_y_min = min(int(r.tile_y) for r in level)  # type: ignore[arg-type]
        self.tile_y_max = max(int(r.tile_y) for r in level)  # type: ignore[arg-type]

        probe = cv2.imread(str(level[0].path), cv2.IMREAD_GRAYSCALE)
        if probe is None:
            raise RuntimeError(f"Cannot read reference tile {level[0].path}")
        self.tile_px = int(probe.shape[0])

        cols = self.tile_x_max - self.tile_x_min + 1
        rows = self.tile_y_max - self.tile_y_min + 1
        self.image = np.zeros((rows * self.tile_px, cols * self.tile_px), np.uint8)
        self.coverage = np.zeros((rows, cols), bool)

        placed = 0
        for ref in level:
            tile = cv2.imread(str(ref.path), cv2.IMREAD_GRAYSCALE)
            if tile is None:
                LOG.warning("Unreadable tile skipped: %s", ref.path)
                continue
            if tile.shape[0] != self.tile_px or tile.shape[1] != self.tile_px:
                tile = cv2.resize(tile, (self.tile_px, self.tile_px), interpolation=cv2.INTER_AREA)
            col = int(ref.tile_x) - self.tile_x_min  # type: ignore[arg-type]
            row = int(ref.tile_y) - self.tile_y_min  # type: ignore[arg-type]
            y0, x0 = row * self.tile_px, col * self.tile_px
            self.image[y0:y0 + self.tile_px, x0:x0 + self.tile_px] = tile
            self.coverage[row, col] = True
            placed += 1

        self.tiles_placed = placed
        self.tiles_expected = rows * cols
        self.provider = level[0].provider
        self.attribution = level[0].attribution

        # Geographic extent and the local frame anchored at the centre.
        west, north = global_px_to_lonlat(
            self.tile_x_min * TILE_PIXELS, self.tile_y_min * TILE_PIXELS, self.zoom
        )
        east, south = global_px_to_lonlat(
            (self.tile_x_max + 1) * TILE_PIXELS,
            (self.tile_y_max + 1) * TILE_PIXELS,
            self.zoom,
        )
        self.west, self.east, self.north, self.south = west, east, north, south
        self.frame = LocalFrame(lat0=(north + south) / 2.0, lon0=(west + east) / 2.0)

        # Ground sampling distance of the mosaic at its centre latitude.
        self.gsd = (
            2.0 * math.pi * EARTH_RADIUS_M * math.cos(math.radians(self.frame.lat0))
            / (TILE_PIXELS * 2.0 ** self.zoom)
        ) * (TILE_PIXELS / self.tile_px)

        LOG.info(
            "Mosaic z%d: %dx%d px from %d/%d tiles, gsd %.3f m/px, "
            "extent %.5f..%.5f lat, %.5f..%.5f lon",
            self.zoom, self.image.shape[1], self.image.shape[0],
            placed, self.tiles_expected, self.gsd, south, north, west, east,
        )

    # -- conversions --------------------------------------------------------

    def lonlat_to_pixel(self, lon: float, lat: float) -> Tuple[float, float]:
        gx, gy = lonlat_to_global_px(lon, lat, self.zoom)
        scale = self.tile_px / TILE_PIXELS
        return (
            (gx - self.tile_x_min * TILE_PIXELS) * scale,
            (gy - self.tile_y_min * TILE_PIXELS) * scale,
        )

    def pixel_to_lonlat(self, px: float, py: float) -> Tuple[float, float]:
        scale = TILE_PIXELS / self.tile_px
        return global_px_to_lonlat(
            self.tile_x_min * TILE_PIXELS + px * scale,
            self.tile_y_min * TILE_PIXELS + py * scale,
            self.zoom,
        )

    def xy_to_pixel(self, x: float, y: float) -> Tuple[float, float]:
        lat, lon = self.frame.to_latlon(x, y)
        return self.lonlat_to_pixel(lon, lat)

    # -- extent helpers -----------------------------------------------------

    def world_bounds(self) -> Tuple[float, float, float, float]:
        """Mosaic extent in local metres as ``(x_min, y_min, x_max, y_max)``."""
        x0, y0 = self.frame.to_xy(self.south, self.west)
        x1, y1 = self.frame.to_xy(self.north, self.east)
        return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))

    def sample_patch(
        self, centre_px: Tuple[float, float], size_px: float, rotation_deg: float
    ) -> Optional[np.ndarray]:
        """Extract a rotated square patch centred on ``centre_px``.

        Rotating by ``+heading`` maps the drone's forward direction to image
        up: the bearing vector ``(sin h, -cos h)`` in north-up mosaic
        coordinates transforms to ``(0, -1)`` under OpenCV's rotation matrix.
        """
        half = size_px / 2.0
        # Pull a margin large enough that rotation cannot sample outside it.
        pad = int(math.ceil(half * math.sqrt(2.0))) + 2
        cx, cy = centre_px
        x0, y0 = int(math.floor(cx)) - pad, int(math.floor(cy)) - pad
        x1, y1 = int(math.ceil(cx)) + pad, int(math.ceil(cy)) + pad
        if x0 < 0 or y0 < 0 or x1 >= self.image.shape[1] or y1 >= self.image.shape[0]:
            return None  # footprint leaves the mosaic

        window = self.image[y0:y1, x0:x1]
        local = (cx - x0, cy - y0)
        matrix = cv2.getRotationMatrix2D(local, rotation_deg, 1.0)
        # Re-centre the rotated result on the output canvas.
        side = int(math.ceil(size_px))
        matrix[0, 2] += side / 2.0 - local[0]
        matrix[1, 2] += side / 2.0 - local[1]
        return cv2.warpAffine(
            window, matrix, (side, side),
            flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT,
        )


# ===========================================================================
# Camera model
# ===========================================================================


@dataclass
class CameraConfig:
    """Nadir camera intrinsics and sensor degradation parameters."""

    fov_deg: float = 60.0          # horizontal field of view
    sensor_px: int = 512           # output frame is sensor_px square
    blur_sigma: float = 0.8        # defocus / optical softness
    noise_sigma: float = 4.0       # additive sensor noise, 8-bit DN
    jpeg_quality: int = 85         # compression artefacts; 0 disables
    vignette: float = 0.25         # corner falloff, 0..1
    exposure_s: float = 0.004      # drives motion blur length
    brightness_jitter: float = 0.08
    motion_blur: bool = True


class VirtualCamera:
    """Synthesises a degraded nadir frame from the mosaic."""

    def __init__(self, mosaic: MapMosaic, config: CameraConfig, rng: np.random.Generator) -> None:
        self.mosaic = mosaic
        self.config = config
        self.rng = rng

    def footprint_m(self, altitude_m: float) -> float:
        """Ground width covered by the frame at ``altitude_m``."""
        return 2.0 * altitude_m * math.tan(math.radians(self.config.fov_deg) / 2.0)

    def ground_sample_distance(self, altitude_m: float) -> float:
        return self.footprint_m(altitude_m) / self.config.sensor_px

    def footprint_px(self, altitude_m: float) -> float:
        """Footprint width in mosaic pixels."""
        return self.footprint_m(altitude_m) / self.mosaic.gsd

    def required_margin_m(self, altitude_m: float) -> float:
        """Stand-off from the mosaic edge needed for a rotated capture.

        Derived from the same padding ``MapMosaic.sample_patch`` applies, plus
        a few pixels of slack for rounding, so a path built with this margin
        can never fall outside coverage.
        """
        pad_px = math.ceil(self.footprint_px(altitude_m) / 2.0 * math.sqrt(2.0)) + 2
        return (pad_px + 4) * self.mosaic.gsd

    def capture(
        self, lat: float, lon: float, altitude_m: float, heading_deg: float,
        speed_mps: float = 0.0,
    ) -> Optional[np.ndarray]:
        """Return a simulated frame, or ``None`` if outside mosaic coverage."""
        footprint = self.footprint_m(altitude_m)
        size_px = footprint / self.mosaic.gsd
        if size_px < 16:
            LOG.warning("Altitude %.1f m yields a %.1f px footprint; too small.",
                        altitude_m, size_px)
            return None

        centre = self.mosaic.lonlat_to_pixel(lon, lat)
        patch = self.mosaic.sample_patch(centre, size_px, heading_deg)
        if patch is None:
            return None

        frame = cv2.resize(
            patch, (self.config.sensor_px, self.config.sensor_px),
            interpolation=cv2.INTER_AREA if size_px > self.config.sensor_px else cv2.INTER_CUBIC,
        )
        return self._degrade(frame, altitude_m, speed_mps)

    # -- sensor degradation -------------------------------------------------

    def _degrade(self, frame: np.ndarray, altitude_m: float, speed_mps: float) -> np.ndarray:
        """Apply motion blur, defocus, vignetting, noise and compression."""
        cfg = self.config
        work = frame.astype(np.float32)

        # Motion blur: forward travel during exposure, in output pixels. The
        # camera is body-fixed, so travel is along image -y (frame up).
        if cfg.motion_blur and speed_mps > 0 and cfg.exposure_s > 0:
            gsd = self.ground_sample_distance(altitude_m)
            smear_px = (speed_mps * cfg.exposure_s) / max(gsd, 1e-6)
            length = int(round(smear_px))
            if length >= 2:
                kernel = np.zeros((length, length), np.float32)
                kernel[:, length // 2] = 1.0 / length  # vertical streak
                work = cv2.filter2D(work, -1, kernel, borderType=cv2.BORDER_REFLECT)

        if cfg.blur_sigma > 0:
            work = cv2.GaussianBlur(work, (0, 0), cfg.blur_sigma)

        if cfg.vignette > 0:
            work *= self._vignette_mask(work.shape)

        if cfg.brightness_jitter > 0:
            gain = 1.0 + self.rng.normal(0.0, cfg.brightness_jitter)
            offset = self.rng.normal(0.0, 255.0 * cfg.brightness_jitter * 0.25)
            work = work * gain + offset

        if cfg.noise_sigma > 0:
            work += self.rng.normal(0.0, cfg.noise_sigma, work.shape)

        out = np.clip(work, 0, 255).astype(np.uint8)

        if 0 < cfg.jpeg_quality < 100:
            ok, buffer = cv2.imencode(
                ".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), int(cfg.jpeg_quality)]
            )
            if ok:
                out = cv2.imdecode(buffer, cv2.IMREAD_GRAYSCALE)
        return out

    def _vignette_mask(self, shape: Tuple[int, ...]) -> np.ndarray:
        """Cached radial falloff mask."""
        key = (shape[0], shape[1], self.config.vignette)
        cached = getattr(self, "_vignette_cache", None)
        if cached is not None and cached[0] == key:
            return cached[1]
        h, w = shape[0], shape[1]
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        cy, cx = (h - 1) / 2.0, (w - 1) / 2.0
        radius = np.sqrt(((xx - cx) / cx) ** 2 + ((yy - cy) / cy) ** 2) / math.sqrt(2.0)
        mask = 1.0 - self.config.vignette * radius ** 2
        self._vignette_cache = (key, mask)  # type: ignore[attr-defined]
        return mask


# ===========================================================================
# Flight path and drone dynamics
# ===========================================================================


def build_flight_path(
    mosaic: MapMosaic, pattern: str, altitude_m: float, margin_m: float,
    legs: int = 4, climb_m: float = 0.0,
) -> List[np.ndarray]:
    """Generate waypoints in local ENU metres, inset to keep the FOV covered."""
    x_min, y_min, x_max, y_max = mosaic.world_bounds()
    x_min += margin_m
    x_max -= margin_m
    y_min += margin_m
    y_max -= margin_m
    if x_max <= x_min or y_max <= y_min:
        raise RuntimeError(
            f"Mosaic too small for a {margin_m:.0f} m camera margin. Lower "
            "--altitude, narrow --fov, or download a larger area."
        )

    waypoints: List[np.ndarray] = []
    pattern = pattern.lower()

    if pattern == "lawnmower":
        # Classic survey boustrophedon: the standard mapping-mission pattern.
        legs = max(2, legs)
        for i in range(legs):
            y = y_min + (y_max - y_min) * i / (legs - 1)
            xs = (x_min, x_max) if i % 2 == 0 else (x_max, x_min)
            waypoints.append(np.array([xs[0], y, altitude_m]))
            waypoints.append(np.array([xs[1], y, altitude_m]))
    elif pattern == "circle":
        cx, cy = (x_min + x_max) / 2.0, (y_min + y_max) / 2.0
        radius = min(x_max - x_min, y_max - y_min) / 2.0
        for i in range(37):  # closes the loop
            angle = 2.0 * math.pi * i / 36.0
            waypoints.append(
                np.array([cx + radius * math.sin(angle), cy + radius * math.cos(angle), altitude_m])
            )
    elif pattern == "diagonal":
        waypoints = [
            np.array([x_min, y_min, altitude_m]),
            np.array([x_max, y_max, altitude_m]),
        ]
    else:
        raise ValueError(f"Unknown flight pattern {pattern!r}.")

    # Optional linear climb, so scale changes are exercised during the run.
    if abs(climb_m) > 1e-6 and len(waypoints) > 1:
        for i, wp in enumerate(waypoints):
            wp[2] = altitude_m + climb_m * i / (len(waypoints) - 1)
    return waypoints


@dataclass
class SimulatedDrone:
    """Virtual multirotor with ground-truth state.

    The airframe crabs directly toward the active waypoint while the yaw axis
    slews to the course at a bounded rate, which is how a multirotor flies a
    survey grid and keeps the ground track exactly on the planned path.
    """

    current_true_position: np.ndarray          # (X east, Y north, Z up) metres
    current_heading: float                     # compass bearing, degrees
    velocity: float                            # ground speed, m/s
    waypoints: List[np.ndarray] = field(default_factory=list)
    max_yaw_rate_dps: float = 45.0
    waypoint_radius_m: float = 2.0
    waypoint_index: int = 0
    distance_travelled_m: float = 0.0
    finished: bool = False

    @classmethod
    def from_path(
        cls, waypoints: Sequence[np.ndarray], velocity: float,
        max_yaw_rate_dps: float = 45.0,
    ) -> "SimulatedDrone":
        """Spawn at the first waypoint, already pointing at the second."""
        if len(waypoints) < 2:
            raise ValueError("A flight path needs at least two waypoints.")
        start = np.array(waypoints[0], dtype=float)
        heading = cls._bearing(start, np.array(waypoints[1], dtype=float))
        return cls(
            current_true_position=start,
            current_heading=heading,
            velocity=float(velocity),
            waypoints=[np.array(w, dtype=float) for w in waypoints],
            max_yaw_rate_dps=max_yaw_rate_dps,
            waypoint_index=1,
        )

    # -- kinematics ---------------------------------------------------------

    @staticmethod
    def _bearing(origin: np.ndarray, target: np.ndarray) -> float:
        """Compass bearing from ``origin`` to ``target`` (x east, y north)."""
        dx, dy = target[0] - origin[0], target[1] - origin[1]
        return math.degrees(math.atan2(dx, dy)) % 360.0

    @staticmethod
    def _wrap180(angle: float) -> float:
        return (angle + 180.0) % 360.0 - 180.0

    @property
    def altitude(self) -> float:
        return float(self.current_true_position[2])

    def update(self, dt: float) -> None:
        """Advance one timestep along the path."""
        if self.finished or self.waypoint_index >= len(self.waypoints):
            self.finished = True
            return

        target = self.waypoints[self.waypoint_index]
        delta = target[:2] - self.current_true_position[:2]
        distance = float(np.hypot(*delta))

        # Arrived: latch onto the next leg (and keep any leftover travel).
        if distance <= max(self.waypoint_radius_m, self.velocity * dt):
            self.current_true_position = target.copy()
            self.waypoint_index += 1
            if self.waypoint_index >= len(self.waypoints):
                self.finished = True
            return

        course = self._bearing(self.current_true_position, target)
        # Bounded yaw slew toward the course.
        error = self._wrap180(course - self.current_heading)
        max_turn = self.max_yaw_rate_dps * dt
        self.current_heading = (
            self.current_heading + max(-max_turn, min(max_turn, error))
        ) % 360.0

        step = self.velocity * dt
        direction = delta / distance
        self.current_true_position[0] += direction[0] * step
        self.current_true_position[1] += direction[1] * step

        # Linear altitude capture toward the waypoint's commanded height.
        dz = target[2] - self.current_true_position[2]
        climb_limit = 3.0 * dt  # m/s vertical rate cap
        self.current_true_position[2] += max(-climb_limit, min(climb_limit, dz))

        self.distance_travelled_m += step


# ===========================================================================
# Simulation
# ===========================================================================


@dataclass
class StepRecord:
    """One simulation step's ground truth, estimate and error."""

    step: int
    t_s: float
    true_x: float
    true_y: float
    true_z: float
    true_lat: float
    true_lon: float
    true_heading: float
    fix: bool
    est_lat: Optional[float] = None
    est_lon: Optional[float] = None
    est_x: Optional[float] = None
    est_y: Optional[float] = None
    est_heading: Optional[float] = None
    confidence: float = 0.0
    inliers: int = 0
    matched_tile: str = "-"
    error_m: Optional[float] = None
    error_east_m: Optional[float] = None
    error_north_m: Optional[float] = None
    error_heading_deg: Optional[float] = None
    vps_ms: float = 0.0
    note: str = ""

    def as_row(self) -> Dict[str, Any]:
        return {k: ("" if v is None else v) for k, v in self.__dict__.items()}


class FlightSimulation:
    """Wires the mosaic, camera, drone and VPS into one closed-loop run."""

    def __init__(
        self,
        mosaic: MapMosaic,
        vps: VisualPositioningSystem,
        camera: VirtualCamera,
        drone: SimulatedDrone,
        dt: float = 1.0,
        max_steps: int = 60,
        frame_dir: Optional[Path] = None,
    ) -> None:
        self.mosaic = mosaic
        self.vps = vps
        self.camera = camera
        self.drone = drone
        self.dt = dt
        self.max_steps = max_steps
        self.frame_dir = frame_dir
        self.records: List[StepRecord] = []
        if frame_dir is not None:
            frame_dir.mkdir(parents=True, exist_ok=True)

    # -- one step -----------------------------------------------------------

    def step(self, index: int) -> StepRecord:
        """Capture, localise and score a single timestep."""
        true_xyz = self.drone.current_true_position
        true_lat, true_lon = self.mosaic.frame.to_latlon(float(true_xyz[0]), float(true_xyz[1]))
        record = StepRecord(
            step=index,
            t_s=round(index * self.dt, 3),
            true_x=round(float(true_xyz[0]), 3),
            true_y=round(float(true_xyz[1]), 3),
            true_z=round(float(true_xyz[2]), 3),
            true_lat=true_lat,
            true_lon=true_lon,
            true_heading=round(self.drone.current_heading, 2),
            fix=False,
        )

        frame = self.camera.capture(
            true_lat, true_lon, self.drone.altitude,
            self.drone.current_heading, self.drone.velocity,
        )
        if frame is None:
            record.note = "camera outside mosaic coverage"
            return record

        if self.frame_dir is not None:
            cv2.imwrite(str(self.frame_dir / f"frame_{index:04d}.jpg"), frame)

        started = time.perf_counter()
        pose, debug = self.vps.localize(frame)
        record.vps_ms = round((time.perf_counter() - started) * 1000.0, 1)

        if pose is None:
            record.note = "no match"
            return record

        record.confidence = round(pose.confidence, 4)
        record.inliers = pose.inliers
        record.matched_tile = pose.reference.tile_key
        record.est_lat = pose.latitude
        record.est_lon = pose.longitude
        est_x, est_y = self.mosaic.frame.to_xy(pose.latitude, pose.longitude)
        record.est_x = round(est_x, 3)
        record.est_y = round(est_y, 3)
        record.est_heading = None if pose.heading_deg is None else round(pose.heading_deg, 2)

        if not pose.accepted:
            # Prefer the geometric reason over the bare score: "confidence
            # 0.000" hides the fact that a degenerate homography was filtered.
            reason = debug.get("best_rejected_reason")
            record.note = (
                f"rejected: {reason}" if reason
                else f"rejected (confidence {pose.confidence:.3f})"
            )
            return record

        record.fix = True
        # Great-circle error is the honest scalar; components aid diagnosis.
        record.error_m = round(
            haversine_m(true_lat, true_lon, pose.latitude, pose.longitude), 4
        )
        record.error_east_m = round(est_x - float(true_xyz[0]), 4)
        record.error_north_m = round(est_y - float(true_xyz[1]), 4)
        if pose.heading_deg is not None:
            record.error_heading_deg = round(
                abs(SimulatedDrone._wrap180(pose.heading_deg - self.drone.current_heading)), 3
            )
        return record

    # -- loop ---------------------------------------------------------------

    def run(self) -> List[StepRecord]:
        """Fly the path, localising at every timestep."""
        header = (
            f"{'step':>4} {'t(s)':>6} | {'true X':>9} {'true Y':>9} {'Z':>6} {'hdg':>6} | "
            f"{'est X':>9} {'est Y':>9} {'est hdg':>7} | {'err(m)':>7} {'dHdg':>6} "
            f"{'conf':>5} {'inl':>4} {'ms':>5} | note"
        )
        print(header)
        print("-" * len(header))

        for index in range(self.max_steps):
            record = self.step(index)
            self.records.append(record)
            self._print_step(record)
            LOG.debug("step %d: %s", index, record.as_row())

            self.drone.update(self.dt)
            if self.drone.finished:
                LOG.info("Flight path completed after %d step(s).", index + 1)
                break
        return self.records

    @staticmethod
    def _print_step(r: StepRecord) -> None:
        est_x = "-" if r.est_x is None else f"{r.est_x:9.2f}"
        est_y = "-" if r.est_y is None else f"{r.est_y:9.2f}"
        est_h = "-" if r.est_heading is None else f"{r.est_heading:7.2f}"
        err = "-" if r.error_m is None else f"{r.error_m:7.3f}"
        dhdg = "-" if r.error_heading_deg is None else f"{r.error_heading_deg:6.2f}"
        print(
            f"{r.step:>4} {r.t_s:>6.1f} | {r.true_x:9.2f} {r.true_y:9.2f} "
            f"{r.true_z:6.1f} {r.true_heading:6.1f} | {est_x} {est_y} {est_h} | "
            f"{err} {dhdg} {r.confidence:5.3f} {r.inliers:>4} {r.vps_ms:>5.0f} | "
            f"{r.note}"
        )

    # -- reporting ----------------------------------------------------------

    def summary(self) -> Dict[str, Any]:
        """Aggregate tracking metrics across the run."""
        total = len(self.records)
        fixes = [r for r in self.records if r.fix and r.error_m is not None]
        errors = [float(r.error_m) for r in fixes]  # type: ignore[arg-type]
        headings = [
            float(r.error_heading_deg) for r in fixes if r.error_heading_deg is not None
        ]

        def pct(values: List[float], q: float) -> Optional[float]:
            if not values:
                return None
            ordered = sorted(values)
            idx = min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))
            return ordered[idx]

        report: Dict[str, Any] = {
            "steps": total,
            "fixes": len(fixes),
            "fix_rate": round(len(fixes) / total, 4) if total else 0.0,
            "flight_distance_m": round(self.drone.distance_travelled_m, 2),
            "sim_duration_s": round(total * self.dt, 2),
            "mosaic": {
                "zoom": self.mosaic.zoom,
                "size_px": [int(self.mosaic.image.shape[1]), int(self.mosaic.image.shape[0])],
                "gsd_m_per_px": round(self.mosaic.gsd, 4),
                "tiles": f"{self.mosaic.tiles_placed}/{self.mosaic.tiles_expected}",
                "provider": self.mosaic.provider,
            },
        }
        if errors:
            report["position_error_m"] = {
                "mean": round(statistics.fmean(errors), 3),
                "median": round(statistics.median(errors), 3),
                "p95": round(pct(errors, 0.95) or 0.0, 3),
                "max": round(max(errors), 3),
                "rmse": round(math.sqrt(statistics.fmean([e * e for e in errors])), 3),
                "stdev": round(statistics.stdev(errors), 3) if len(errors) > 1 else 0.0,
            }
            report["error_bias_m"] = {
                "east": round(statistics.fmean(
                    [float(r.error_east_m) for r in fixes if r.error_east_m is not None]
                ), 3),
                "north": round(statistics.fmean(
                    [float(r.error_north_m) for r in fixes if r.error_north_m is not None]
                ), 3),
            }
        if headings:
            report["heading_error_deg"] = {
                "mean": round(statistics.fmean(headings), 3),
                "max": round(max(headings), 3),
            }
        confidences = [r.confidence for r in self.records if r.confidence > 0]
        if confidences:
            report["confidence"] = {
                "mean": round(statistics.fmean(confidences), 4),
                "min": round(min(confidences), 4),
            }
        timings = [r.vps_ms for r in self.records if r.vps_ms > 0]
        if timings:
            report["vps_latency_ms"] = {
                "mean": round(statistics.fmean(timings), 1),
                "max": round(max(timings), 1),
            }
        failures = [r.note for r in self.records if not r.fix and r.note]
        if failures:
            report["failure_notes"] = sorted(set(failures))
        return report

    def write_csv(self, path: Path) -> Path:
        """Persist the per-step log for offline analysis."""
        path.parent.mkdir(parents=True, exist_ok=True)
        fields = list(StepRecord(0, 0, 0, 0, 0, 0, 0, 0, False).__dict__.keys())
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            for record in self.records:
                writer.writerow(record.as_row())
        LOG.info("Per-step log written to %s", path)
        return path


def format_summary(report: Dict[str, Any]) -> str:
    """Render the aggregate report as a console block."""
    lines = ["", "=" * 78, "TRACKING METRICS REPORT", "=" * 78]
    lines.append(
        f"Steps              : {report['steps']}   "
        f"Fixes: {report['fixes']} ({report['fix_rate'] * 100:.1f}%)"
    )
    lines.append(
        f"Flight distance    : {report['flight_distance_m']:.1f} m over "
        f"{report['sim_duration_s']:.0f} s simulated"
    )
    mosaic = report["mosaic"]
    lines.append(
        f"Mosaic             : z{mosaic['zoom']} {mosaic['size_px'][0]}x{mosaic['size_px'][1]} px, "
        f"{mosaic['gsd_m_per_px']} m/px, tiles {mosaic['tiles']} [{mosaic['provider']}]"
    )
    if "position_error_m" in report:
        err = report["position_error_m"]
        lines.append(
            f"Position error (m) : mean {err['mean']}  median {err['median']}  "
            f"p95 {err['p95']}  max {err['max']}  rmse {err['rmse']}  sd {err['stdev']}"
        )
        bias = report["error_bias_m"]
        lines.append(
            f"Error bias (m)     : east {bias['east']:+.3f}  north {bias['north']:+.3f}  "
            f"(a consistent offset indicates a georeferencing shift, not noise)"
        )
        gsd = mosaic["gsd_m_per_px"]
        lines.append(f"Error in pixels    : mean {err['mean'] / gsd:.2f} mosaic px")
    else:
        lines.append("Position error     : no accepted fixes")
    if "heading_error_deg" in report:
        head = report["heading_error_deg"]
        lines.append(f"Heading error (deg): mean {head['mean']}  max {head['max']}")
    if "confidence" in report:
        conf = report["confidence"]
        lines.append(f"VPS confidence     : mean {conf['mean']}  min {conf['min']}")
    if "vps_latency_ms" in report:
        lat = report["vps_latency_ms"]
        lines.append(f"VPS latency (ms)   : mean {lat['mean']}  max {lat['max']}")
    if "failure_notes" in report:
        lines.append("Failure notes      : " + "; ".join(report["failure_notes"]))
    lines.append("=" * 78)
    return "\n".join(lines)


# ===========================================================================
# Visualisation
# ===========================================================================


def plot_flight(
    simulation: FlightSimulation, save_path: Path, show: bool = False
) -> None:
    """Three-panel figure: 2D ground track, error history, 3D trajectory."""
    import matplotlib
    if not show:
        matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d import Axes3D  # noqa: F401 (registers 3D projection)

    records = simulation.records
    mosaic = simulation.mosaic
    true_x = [r.true_x for r in records]
    true_y = [r.true_y for r in records]
    true_z = [r.true_z for r in records]
    fixes = [r for r in records if r.fix]

    figure = plt.figure(figsize=(17, 6))

    # -- panel 1: ground track over the mosaic ------------------------------
    ax1 = figure.add_subplot(1, 3, 1)
    x_min, y_min, x_max, y_max = mosaic.world_bounds()
    ax1.imshow(
        mosaic.image, cmap="gray", origin="upper",
        extent=(x_min, x_max, y_min, y_max),
    )
    ax1.plot(true_x, true_y, "-", color="#00c8ff", lw=2, label="true track")
    if fixes:
        ax1.scatter(
            [r.est_x for r in fixes], [r.est_y for r in fixes],
            c=[r.error_m for r in fixes], cmap="autumn_r", s=40,
            edgecolors="k", linewidths=0.4, zorder=5, label="VPS fix",
        )
    misses = [r for r in records if not r.fix]
    if misses:
        ax1.scatter([r.true_x for r in misses], [r.true_y for r in misses],
                    marker="x", c="red", s=60, zorder=6, label="no fix")
    ax1.set_xlabel("East (m)")
    ax1.set_ylabel("North (m)")
    ax1.set_title(f"Ground track over z{mosaic.zoom} mosaic")
    ax1.legend(loc="upper right", fontsize=8)

    # -- panel 2: error history ---------------------------------------------
    ax2 = figure.add_subplot(1, 3, 2)
    if fixes:
        ax2.plot([r.t_s for r in fixes], [r.error_m for r in fixes],
                 "o-", color="#d62728", label="position error")
        mean_err = statistics.fmean([float(r.error_m) for r in fixes])  # type: ignore[arg-type]
        ax2.axhline(mean_err, ls="--", color="gray", label=f"mean {mean_err:.2f} m")
        ax2.axhline(mosaic.gsd, ls=":", color="green",
                    label=f"1 mosaic px = {mosaic.gsd:.2f} m")
        heading_errors = [(r.t_s, r.error_heading_deg) for r in fixes
                          if r.error_heading_deg is not None]
        if heading_errors:
            twin = ax2.twinx()
            twin.plot([t for t, _ in heading_errors], [e for _, e in heading_errors],
                      "s-", color="#1f77b4", alpha=0.5, ms=4)
            twin.set_ylabel("Heading error (deg)", color="#1f77b4")
    ax2.set_xlabel("Simulated time (s)")
    ax2.set_ylabel("Position error (m)")
    ax2.set_title("Tracking error history")
    ax2.legend(loc="upper right", fontsize=8)
    ax2.grid(alpha=0.3)

    # -- panel 3: 3D trajectory ---------------------------------------------
    ax3 = figure.add_subplot(1, 3, 3, projection="3d")
    ax3.plot(true_x, true_y, true_z, "-", color="#00c8ff", lw=2, label="true")
    if fixes:
        ax3.scatter([r.est_x for r in fixes], [r.est_y for r in fixes],
                    [r.true_z for r in fixes], c="#d62728", s=18, label="VPS fix")
    ax3.set_xlabel("East (m)")
    ax3.set_ylabel("North (m)")
    ax3.set_zlabel("Altitude (m)")
    ax3.set_title("3D flight profile")
    ax3.legend(fontsize=8)

    if mosaic.attribution:
        figure.text(0.5, 0.01, f"Reference imagery: {mosaic.attribution}",
                    ha="center", fontsize=7, color="#555555")
    figure.tight_layout(rect=(0.0, 0.035, 1.0, 1.0))

    save_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(save_path, dpi=140)
    LOG.info("Flight figure written to %s", save_path)
    if show:
        plt.show()
    else:
        plt.close(figure)


# ===========================================================================
# CLI
# ===========================================================================


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="simulator",
        description="Fly a virtual drone over the Part 1 map data and localise "
                    "it each step with the Part 2 Visual Positioning System.",
    )
    world = parser.add_argument_group("world")
    world.add_argument("--db", type=Path, default=Path("map_data"),
                       help="Reference database root (default: map_data).")
    world.add_argument("--zoom", type=int,
                       help="Mosaic zoom level (default: highest available).")

    flight = parser.add_argument_group("flight")
    flight.add_argument("--path", choices=("lawnmower", "circle", "diagonal"),
                        default="lawnmower", help="Flight pattern (default: lawnmower).")
    flight.add_argument("--legs", type=int, default=4,
                        help="Survey legs for the lawnmower pattern (default: 4).")
    flight.add_argument("--altitude", type=float, default=100.0,
                        help="Altitude above ground in metres (default: 100).")
    flight.add_argument("--climb", type=float, default=0.0,
                        help="Total altitude change over the path in metres (default: 0).")
    flight.add_argument("--velocity", type=float, default=8.0,
                        help="Ground speed in m/s (default: 8).")
    flight.add_argument("--dt", type=float, default=2.0,
                        help="Timestep in seconds (default: 2).")
    flight.add_argument("--steps", type=int, default=40,
                        help="Maximum simulation steps (default: 40).")

    camera = parser.add_argument_group("camera")
    camera.add_argument("--fov", type=float, default=60.0,
                        help="Horizontal field of view in degrees (default: 60).")
    camera.add_argument("--sensor-px", type=int, default=512,
                        help="Square sensor resolution (default: 512).")
    camera.add_argument("--noise", type=float, default=4.0,
                        help="Sensor noise sigma in 8-bit DN (default: 4).")
    camera.add_argument("--blur", type=float, default=0.8,
                        help="Defocus blur sigma in pixels (default: 0.8).")
    camera.add_argument("--jpeg-quality", type=int, default=85,
                        help="JPEG quality for compression artefacts (default: 85).")
    camera.add_argument("--no-motion-blur", action="store_true",
                        help="Disable velocity-driven motion blur.")

    vps_group = parser.add_argument_group("vps")
    vps_group.add_argument("--detector", choices=("sift", "orb"), default="sift",
                           help="Local feature detector used by the VPS (default: sift).")
    vps_group.add_argument("--threshold", type=float, default=0.30,
                           help="VPS confidence threshold (default: 0.30).")
    # Keep this aligned with VpsConfig.top_k_verify; a lower value here would
    # silently truncate the shortlist and reintroduce missed true matches.
    vps_group.add_argument("--top-k", type=int, default=10,
                           help="Candidates geometrically verified (default: 10).")

    output = parser.add_argument_group("output")
    output.add_argument("--csv", type=Path, default=Path("simulation_log.csv"),
                        help="Per-step CSV log (default: simulation_log.csv).")
    output.add_argument("--report", type=Path,
                        help="Write the summary report as JSON to this path.")
    output.add_argument("--plot", type=Path, nargs="?", const=Path("flight_report.png"),
                        help="Save the 2D/3D flight figure (default: flight_report.png).")
    output.add_argument("--show", action="store_true", help="Display the figure interactively.")
    output.add_argument("--save-frames", type=Path,
                        help="Directory to dump every simulated camera frame.")
    output.add_argument("--seed", type=int, default=42,
                        help="RNG seed for reproducible sensor noise (default: 42).")
    output.add_argument("--log-level", default="INFO",
                        choices=("DEBUG", "INFO", "WARNING", "ERROR"))
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S", stream=sys.stderr,
    )
    wall_start = time.perf_counter()

    try:
        # -- world ----------------------------------------------------------
        database = ReferenceDatabase(args.db)
        references = database.load()
        mosaic = MapMosaic(references, zoom=args.zoom)

        # -- VPS ------------------------------------------------------------
        vps = VisualPositioningSystem(
            database,
            VpsConfig(
                detector=args.detector,
                confidence_threshold=args.threshold,
                top_k_verify=args.top_k,
            ),
        )
        LOG.info("Warming the reference feature index...")
        vps.build_index()

        # -- camera and path ------------------------------------------------
        rng = np.random.default_rng(args.seed)
        camera = VirtualCamera(
            mosaic,
            CameraConfig(
                fov_deg=args.fov,
                sensor_px=args.sensor_px,
                noise_sigma=args.noise,
                blur_sigma=args.blur,
                jpeg_quality=args.jpeg_quality,
                motion_blur=not args.no_motion_blur,
            ),
            rng,
        )
        # Size the stand-off for the highest altitude flown, since the
        # footprint (and therefore the required margin) grows with altitude.
        peak_altitude = args.altitude + max(0.0, args.climb)
        footprint = camera.footprint_m(peak_altitude)
        margin = camera.required_margin_m(peak_altitude)
        LOG.info(
            "Camera: %.1f m footprint at %.0f m AGL (%.1f px), %.3f m/px, "
            "mosaic margin %.1f m",
            footprint, args.altitude, camera.footprint_px(peak_altitude),
            camera.ground_sample_distance(args.altitude), margin,
        )

        waypoints = build_flight_path(
            mosaic, args.path, args.altitude, margin, legs=args.legs, climb_m=args.climb,
        )
        drone = SimulatedDrone.from_path(waypoints, args.velocity)
        LOG.info("Flight path '%s': %d waypoint(s), %.1f m/s, dt %.1fs",
                 args.path, len(waypoints), args.velocity, args.dt)

        # -- run ------------------------------------------------------------
        simulation = FlightSimulation(
            mosaic, vps, camera, drone,
            dt=args.dt, max_steps=args.steps, frame_dir=args.save_frames,
        )
        simulation.run()

    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        LOG.error("%s", exc)
        return 2

    report = simulation.summary()
    report["wall_clock_s"] = round(time.perf_counter() - wall_start, 2)
    print(format_summary(report))

    if args.csv:
        simulation.write_csv(args.csv)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
        LOG.info("Summary report written to %s", args.report)
    if args.plot is not None or args.show:
        try:
            plot_flight(simulation, args.plot or Path("flight_report.png"), show=args.show)
        except Exception as exc:  # plotting must not invalidate a good run
            LOG.error("Plotting failed: %s", exc)

    # Non-zero when the VPS failed to hold a usable lock on the ground track.
    return 0 if report["fix_rate"] >= 0.8 else 1


if __name__ == "__main__":
    sys.exit(main())
