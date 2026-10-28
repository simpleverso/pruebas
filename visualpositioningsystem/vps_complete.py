#!/usr/bin/env python3
"""Visual Positioning System -- estimate a photo's geolocation by image matching.

Pipeline
--------
1.  Load the query photo and detect local features (SIFT or ORB).
2.  Match against every reference tile in the local database built by Part 1,
    using FLANN (SIFT) or Brute-Force Hamming (ORB) with Lowe's ratio test.
3.  Geometrically verify the top candidates with a RANSAC homography, keeping
    only inlier correspondences.
4.  Convert the query's projected image centre into WGS84 via the reference
    tile's XYZ coordinates, and recover heading from the homography rotation.
5.  Score the result and return a GeoPose when confidence clears the threshold.

Geometry assumptions
--------------------
Reference tiles are north-up Web Mercator rasters of a (locally) planar scene,
so a homography is the correct query->reference model and its rotation gives a
compass bearing directly. This holds for nadir / near-nadir aerial queries.
A ground-level oblique photo violates the planarity assumption: matches may
still localise the tile, but ``heading`` becomes unreliable and the estimate
should be treated as the tile centroid rather than a metric fix.

Usage
-----
    python vps_complete.py --query photo.jpg --db map_data
    python vps_complete.py --query photo.jpg --db map_data --detector orb \
        --threshold 0.25 --visualize match.png
    python vps_complete.py --db map_data --list
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np

LOG = logging.getLogger("vps")

# --- FLANN algorithm identifiers (OpenCV does not expose these as constants) --
FLANN_INDEX_KDTREE = 1
FLANN_INDEX_LSH = 6

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
TILE_PIXELS = 256
CACHE_DIRNAME = ".vps_feature_cache"
CACHE_VERSION = 2


# ===========================================================================
# Slippy-map inverse projection
# ===========================================================================


def tile_pixel_to_lonlat(
    tile_z: int, tile_x: int, tile_y: int, px: float, py: float,
    img_w: int, img_h: int,
) -> Tuple[float, float]:
    """Convert a pixel inside an XYZ tile image to ``(lon, lat)`` in WGS84.

    The latitude axis of a Web Mercator tile is non-linear, so interpolating
    latitude directly between the tile's north and south edges is wrong. This
    maps the pixel into the global Mercator pixel plane and inverts the
    projection analytically instead.

    ``img_w``/``img_h`` let the function accept rescaled tiles; the nominal
    tile is 256x256.
    """
    world_px = TILE_PIXELS * (2.0 ** tile_z)
    global_px = tile_x * TILE_PIXELS + (px / max(img_w, 1)) * TILE_PIXELS
    global_py = tile_y * TILE_PIXELS + (py / max(img_h, 1)) * TILE_PIXELS

    lon = global_px / world_px * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * global_py / world_px))))
    return (lon, lat)


def ground_resolution_m_per_px(lat: float, zoom: int, img_w: int = TILE_PIXELS) -> float:
    """Metres per pixel for a tile raster at ``lat``, accounting for rescaling."""
    equatorial = 2.0 * math.pi * 6378137.0 / (TILE_PIXELS * 2.0 ** zoom)
    return equatorial * math.cos(math.radians(lat)) * (TILE_PIXELS / max(img_w, 1))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres, used for accuracy reporting."""
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


# ===========================================================================
# Data model
# ===========================================================================


@dataclass
class ReferenceImage:
    """One geolocated reference raster plus its provenance."""

    path: Path
    center_lat: float
    center_lon: float
    tile_z: Optional[int] = None
    tile_x: Optional[int] = None
    tile_y: Optional[int] = None
    provider: str = "unknown"
    source: str = "tile_index"  # tile_index | tile_path | exif
    attribution: str = ""
    gsd_m_per_px: Optional[float] = None

    @property
    def is_tiled(self) -> bool:
        """True when the raster has a known XYZ footprint (metric capable)."""
        return None not in (self.tile_z, self.tile_x, self.tile_y)

    @property
    def tile_key(self) -> str:
        if self.is_tiled:
            return f"{self.tile_z}/{self.tile_x}/{self.tile_y}"
        return self.path.name


@dataclass
class GeoPose:
    """Final localisation estimate."""

    latitude: float
    longitude: float
    heading_deg: Optional[float]
    confidence: float
    inliers: int
    good_matches: int
    reference: ReferenceImage
    scale_ref_per_query: Optional[float] = None
    est_gsd_m_per_px: Optional[float] = None
    accepted: bool = False
    homography: Optional[np.ndarray] = None
    anisotropy: Optional[float] = None

    def as_dict(self) -> Dict[str, Any]:
        """JSON-serialisable summary (no numpy types, no image arrays)."""
        return {
            "accepted": self.accepted,
            "latitude": round(self.latitude, 8),
            "longitude": round(self.longitude, 8),
            "heading_deg": None if self.heading_deg is None else round(self.heading_deg, 2),
            "confidence": round(self.confidence, 4),
            "inliers": self.inliers,
            "good_matches": self.good_matches,
            "inlier_ratio": round(self.inliers / max(1, self.good_matches), 4),
            "scale_ref_per_query": (
                None if self.scale_ref_per_query is None else round(self.scale_ref_per_query, 4)
            ),
            "est_gsd_m_per_px": (
                None if self.est_gsd_m_per_px is None else round(self.est_gsd_m_per_px, 4)
            ),
            "anisotropy": None if self.anisotropy is None else round(self.anisotropy, 4),
            "reference": {
                "file": str(self.reference.path),
                "tile_key": self.reference.tile_key,
                "provider": self.reference.provider,
                "center_lat": round(self.reference.center_lat, 8),
                "center_lon": round(self.reference.center_lon, 8),
                "metadata_source": self.reference.source,
                "attribution": self.reference.attribution,
            },
        }

    def __str__(self) -> str:
        head = "n/a" if self.heading_deg is None else f"{self.heading_deg:6.2f} deg"
        verdict = "ACCEPTED" if self.accepted else "REJECTED (below threshold)"
        return (
            f"{verdict}\n"
            f"  Latitude   : {self.latitude:.7f}\n"
            f"  Longitude  : {self.longitude:.7f}\n"
            f"  Heading    : {head}\n"
            f"  Confidence : {self.confidence:.3f} "
            f"({self.inliers} inliers / {self.good_matches} ratio-test matches)\n"
            f"  Reference  : {self.reference.tile_key} [{self.reference.provider}]\n"
            f"  File       : {self.reference.path}"
        )


@dataclass
class VpsConfig:
    """Tunable parameters for detection, matching and acceptance."""

    # -- feature detection -------------------------------------------------
    detector: str = "sift"              # sift | orb
    max_features: int = 4000
    max_query_dimension: int = 1600     # downscale huge photos before detection

    # -- matching ----------------------------------------------------------
    matcher: str = "auto"               # auto | flann | bruteforce
    ratio_threshold: float = 0.70       # Lowe's ratio test
    flann_checks: int = 50
    flann_trees: int = 5

    # -- geometric verification --------------------------------------------
    min_good_matches: int = 12          # needed before attempting a homography
    ransac_reproj_threshold: float = 5.0
    min_inliers: int = 10
    top_k_verify: int = 10              # candidates sent to RANSAC

    # -- homography plausibility -------------------------------------------
    # A nadir view of locally planar ground matched against north-up
    # orthoimagery must map through a similarity transform: uniform scale,
    # rotation, translation. RANSAC will happily return a degenerate,
    # strongly non-conformal homography for a spurious match that is
    # nonetheless self-consistent, and such a fix can carry high confidence
    # (measured anisotropy 46-2350 on bad matches versus 1.00-1.01 on good
    # ones, while confidence failed to separate them). Gate on conformality
    # rather than trusting the score alone. Disable for oblique queries,
    # where a genuinely projective transform is expected.
    require_similarity: bool = True
    max_anisotropy: float = 4.0         # ratio of the affine part's singular values
    max_perspective: float = 0.20       # |h31|,|h32| normalised by image size

    # -- scoring -----------------------------------------------------------
    confidence_threshold: float = 0.30
    inlier_saturation: int = 50         # inlier count that scores a full 1.0

    # -- plumbing ----------------------------------------------------------
    use_cache: bool = True
    cache_dir: Optional[Path] = None

    def __post_init__(self) -> None:
        self.detector = self.detector.lower()
        if self.detector not in {"sift", "orb"}:
            raise ValueError("detector must be 'sift' or 'orb'.")
        self.matcher = self.matcher.lower()
        if self.matcher not in {"auto", "flann", "bruteforce"}:
            raise ValueError("matcher must be 'auto', 'flann' or 'bruteforce'.")
        if not 0.0 < self.ratio_threshold < 1.0:
            raise ValueError("ratio_threshold must lie in (0, 1).")
        if not 0.0 <= self.confidence_threshold <= 1.0:
            raise ValueError("confidence_threshold must lie in [0, 1].")

    @property
    def signature(self) -> str:
        """Identity of the detector settings, for cache invalidation."""
        return f"v{CACHE_VERSION}:{self.detector}:{self.max_features}"


# ===========================================================================
# Feature extraction
# ===========================================================================


class FeatureExtractor:
    """Wraps SIFT or ORB behind one interface, with matcher-aware defaults."""

    def __init__(self, config: VpsConfig) -> None:
        self.config = config
        if config.detector == "sift":
            if not hasattr(cv2, "SIFT_create"):
                raise RuntimeError(
                    "This OpenCV build has no SIFT. Install opencv-python>=4.4 "
                    "or run with --detector orb."
                )
            self._detector = cv2.SIFT_create(nfeatures=config.max_features)
            self.norm = cv2.NORM_L2
            self.binary = False
        else:
            self._detector = cv2.ORB_create(nfeatures=config.max_features)
            self.norm = cv2.NORM_HAMMING
            self.binary = True

    # -- image loading ------------------------------------------------------

    @staticmethod
    def to_grayscale(image: np.ndarray) -> np.ndarray:
        """Coerce an in-memory array to 8-bit single-channel.

        Lets callers (e.g. a simulator) feed frames straight from RAM without
        a disk round-trip.
        """
        array = np.asarray(image)
        if array.ndim == 3:
            channels = array.shape[2]
            if channels == 3:
                array = cv2.cvtColor(array, cv2.COLOR_BGR2GRAY)
            elif channels == 4:
                array = cv2.cvtColor(array, cv2.COLOR_BGRA2GRAY)
            else:
                array = array[:, :, 0]
        elif array.ndim != 2:
            raise ValueError(f"Expected a 2D or 3D image array, got shape {array.shape}.")
        if array.dtype != np.uint8:
            array = np.clip(array, 0, 255).astype(np.uint8)
        return np.ascontiguousarray(array)

    @staticmethod
    def load_grayscale(path: Path) -> np.ndarray:
        """Read an image as 8-bit greyscale, raising a clear error if absent."""
        # np.fromfile + imdecode handles non-ASCII paths that imread rejects.
        try:
            buffer = np.fromfile(str(path), dtype=np.uint8)
        except OSError as exc:
            raise FileNotFoundError(f"Cannot read {path}: {exc}") from exc
        if buffer.size == 0:
            raise ValueError(f"Empty image file: {path}")
        image = cv2.imdecode(buffer, cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise ValueError(f"Unsupported or corrupt image: {path}")
        return image

    def preprocess_query(self, image: np.ndarray) -> Tuple[np.ndarray, float]:
        """Downscale very large photos and equalise local contrast.

        Returns the prepared image and the scale factor applied, so pixel
        coordinates can be mapped back to the original if needed.
        """
        scale = 1.0
        longest = max(image.shape[:2])
        limit = self.config.max_query_dimension
        if limit and longest > limit:
            scale = limit / float(longest)
            image = cv2.resize(
                image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA
            )
        # CLAHE stabilises keypoint counts across exposure differences between
        # a handheld photo and a satellite raster.
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        return clahe.apply(image), scale

    def detect(self, image: np.ndarray) -> Tuple[List[cv2.KeyPoint], Optional[np.ndarray]]:
        """Detect keypoints and compute descriptors."""
        keypoints, descriptors = self._detector.detectAndCompute(image, None)
        if descriptors is None or len(keypoints) == 0:
            return [], None
        if not self.binary:
            descriptors = np.asarray(descriptors, dtype=np.float32)
        return list(keypoints), descriptors


# ===========================================================================
# Descriptor cache
# ===========================================================================


class DescriptorCache:
    """Persists reference descriptors so repeat queries skip re-detection.

    ``cv2.KeyPoint`` cannot be pickled, so keypoints are stored as a plain
    ``(N, 7)`` float array and rebuilt on load.
    """

    def __init__(self, cache_dir: Path, signature: str, enabled: bool = True) -> None:
        self.cache_dir = cache_dir
        self.signature = signature
        self.enabled = enabled
        if enabled:
            try:
                cache_dir.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                LOG.warning("Feature cache disabled (%s)", exc)
                self.enabled = False

    def _key(self, path: Path) -> Optional[Path]:
        """Cache filename bound to the file's identity and detector settings."""
        try:
            stat = path.stat()
        except OSError:
            return None
        raw = f"{path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|{self.signature}"
        return self.cache_dir / f"{hashlib.sha1(raw.encode()).hexdigest()}.npz"

    @staticmethod
    def _pack(keypoints: Sequence[cv2.KeyPoint]) -> np.ndarray:
        return np.array(
            [
                (k.pt[0], k.pt[1], k.size, k.angle, k.response, k.octave, k.class_id)
                for k in keypoints
            ],
            dtype=np.float32,
        ).reshape(-1, 7)

    @staticmethod
    def _unpack(packed: np.ndarray) -> List[cv2.KeyPoint]:
        return [
            cv2.KeyPoint(
                float(r[0]), float(r[1]), float(r[2]), float(r[3]),
                float(r[4]), int(r[5]), int(r[6]),
            )
            for r in packed
        ]

    def load(self, path: Path) -> Optional[Tuple[List[cv2.KeyPoint], np.ndarray, Tuple[int, int]]]:
        if not self.enabled:
            return None
        key = self._key(path)
        if key is None or not key.is_file():
            return None
        try:
            with np.load(key, allow_pickle=False) as data:
                shape = tuple(int(v) for v in data["shape"])
                return (self._unpack(data["keypoints"]), data["descriptors"], shape)  # type: ignore[return-value]
        except (OSError, ValueError, KeyError) as exc:
            LOG.debug("Discarding unreadable cache entry %s: %s", key, exc)
            return None

    def store(
        self, path: Path, keypoints: Sequence[cv2.KeyPoint],
        descriptors: np.ndarray, shape: Tuple[int, int],
    ) -> None:
        if not self.enabled or descriptors is None:
            return
        key = self._key(path)
        if key is None:
            return
        try:
            np.savez_compressed(
                key,
                keypoints=self._pack(keypoints),
                descriptors=descriptors,
                shape=np.asarray(shape, dtype=np.int32),
            )
        except OSError as exc:
            LOG.debug("Could not write cache entry %s: %s", key, exc)


# ===========================================================================
# Reference database
# ===========================================================================


class ReferenceDatabase:
    """Discovers geolocated reference rasters under a database root.

    Metadata is resolved in order of decreasing precision:
      1. ``tile_index.geojson`` written by Part 1 (exact footprint + provider),
      2. the ``<z>/<x>/<y>.ext`` path itself, inverted through the tile maths,
      3. EXIF GPS tags, for arbitrary geotagged photo directories.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root).expanduser()
        if not self.root.exists():
            raise FileNotFoundError(f"Reference database not found: {self.root}")
        self.references: List[ReferenceImage] = []

    # -- discovery ----------------------------------------------------------

    def load(self) -> List[ReferenceImage]:
        """Populate and return the reference list, de-duplicated by path."""
        found: Dict[Path, ReferenceImage] = {}

        for index_path in sorted(self.root.rglob("tile_index.geojson")):
            for ref in self._from_tile_index(index_path):
                found.setdefault(ref.path, ref)
        LOG.info("Loaded %d reference(s) from tile_index.geojson files.", len(found))

        for image_path in self._iter_images():
            if image_path in found:
                continue
            ref = self._from_tile_path(image_path) or self._from_exif(image_path)
            if ref is not None:
                found[image_path] = ref

        self.references = sorted(found.values(), key=lambda r: str(r.path))
        if not self.references:
            raise RuntimeError(
                f"No geolocated reference images under {self.root}. Build the "
                "database first (see build_map_db.py in Part 1)."
            )
        LOG.info("Reference database ready: %d image(s).", len(self.references))
        return self.references

    def _iter_images(self) -> Iterable[Path]:
        for path in sorted(self.root.rglob("*")):
            if path.suffix.lower() in IMAGE_SUFFIXES and path.is_file():
                # Skip virtualenvs and caches that may sit under the root.
                if any(part.startswith((".venv", CACHE_DIRNAME, "__pycache__"))
                       for part in path.parts):
                    continue
                # Resolve so these keys match the absolute paths produced by
                # _from_tile_index; otherwise every tile is indexed twice.
                yield path.resolve()

    def _from_tile_index(self, index_path: Path) -> List[ReferenceImage]:
        """Parse one Part 1 ``tile_index.geojson``."""
        try:
            with index_path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            LOG.warning("Skipping unreadable tile index %s: %s", index_path, exc)
            return []

        # tile_index.geojson lives at <region>/imagery/<provider>/, and its
        # 'file' properties are relative to <region>.
        region_dir = index_path.parent.parent.parent
        provider_meta = (payload.get("provider") or {})
        refs: List[ReferenceImage] = []

        for feature in payload.get("features") or []:
            props = feature.get("properties") or {}
            rel = props.get("file")
            if not rel:
                continue
            image_path = (region_dir / rel).resolve()
            if not image_path.is_file():
                LOG.debug("Indexed tile missing on disk: %s", image_path)
                continue
            refs.append(
                ReferenceImage(
                    path=image_path,
                    center_lat=float(props.get("center_lat", 0.0)),
                    center_lon=float(props.get("center_lon", 0.0)),
                    tile_z=_opt_int(props.get("z")),
                    tile_x=_opt_int(props.get("x")),
                    tile_y=_opt_int(props.get("y")),
                    provider=str(props.get("provider") or provider_meta.get("name") or "unknown"),
                    source="tile_index",
                    attribution=str(props.get("attribution") or provider_meta.get("attribution") or ""),
                    gsd_m_per_px=_opt_float(props.get("ground_resolution_m_per_px")),
                )
            )
        return refs

    def _from_tile_path(self, image_path: Path) -> Optional[ReferenceImage]:
        """Recover geometry from an ``.../<z>/<x>/<y>.ext`` directory layout."""
        try:
            tile_y = int(image_path.stem)
            tile_x = int(image_path.parent.name)
            tile_z = int(image_path.parent.parent.name)
        except ValueError:
            return None
        if not 0 <= tile_z <= 24:
            return None
        n = 2 ** tile_z
        if not (0 <= tile_x < n and 0 <= tile_y < n):
            return None

        lon, lat = tile_pixel_to_lonlat(
            tile_z, tile_x, tile_y, TILE_PIXELS / 2, TILE_PIXELS / 2,
            TILE_PIXELS, TILE_PIXELS,
        )
        return ReferenceImage(
            path=image_path,
            center_lat=lat,
            center_lon=lon,
            tile_z=tile_z, tile_x=tile_x, tile_y=tile_y,
            provider=image_path.parent.parent.parent.name,
            source="tile_path",
            gsd_m_per_px=ground_resolution_m_per_px(lat, tile_z),
        )

    def _from_exif(self, image_path: Path) -> Optional[ReferenceImage]:
        """Read EXIF GPS tags, for reference sets that are geotagged photos."""
        try:
            from PIL import Image, ExifTags  # noqa: WPS433 (optional dependency)
        except ImportError:
            return None
        try:
            with Image.open(image_path) as handle:
                exif = handle.getexif()
                gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo) if exif else None
        except Exception:  # pragma: no cover - unreadable/odd EXIF
            return None
        if not gps_ifd:
            return None

        lat = _dms_to_degrees(gps_ifd.get(2), gps_ifd.get(1))
        lon = _dms_to_degrees(gps_ifd.get(4), gps_ifd.get(3))
        if lat is None or lon is None:
            return None
        return ReferenceImage(
            path=image_path, center_lat=lat, center_lon=lon,
            provider="exif", source="exif",
        )

    # -- reporting ----------------------------------------------------------

    def summary(self) -> str:
        if not self.references:
            self.load()
        by_provider: Dict[str, int] = {}
        zooms: Dict[int, int] = {}
        for ref in self.references:
            by_provider[ref.provider] = by_provider.get(ref.provider, 0) + 1
            if ref.tile_z is not None:
                zooms[ref.tile_z] = zooms.get(ref.tile_z, 0) + 1
        lats = [r.center_lat for r in self.references]
        lons = [r.center_lon for r in self.references]
        lines = [
            f"Reference database : {self.root}",
            f"Images             : {len(self.references)}",
            f"Providers          : " + ", ".join(f"{k}={v}" for k, v in sorted(by_provider.items())),
            f"Zoom levels        : " + ", ".join(f"z{k}={v}" for k, v in sorted(zooms.items())),
            f"Coverage           : lat {min(lats):.5f}..{max(lats):.5f}, "
            f"lon {min(lons):.5f}..{max(lons):.5f}",
        ]
        return "\n".join(lines)


def _opt_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _opt_float(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _dms_to_degrees(dms: Any, ref: Any) -> Optional[float]:
    """Convert an EXIF (degrees, minutes, seconds) triple to signed degrees."""
    if not dms or len(dms) != 3:
        return None
    try:
        degrees = float(dms[0]) + float(dms[1]) / 60.0 + float(dms[2]) / 3600.0
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if str(ref).upper() in {"S", "W"}:
        degrees = -degrees
    return degrees


# ===========================================================================
# Matching and localisation
# ===========================================================================


@dataclass
class MatchCandidate:
    """Intermediate per-reference matching result."""

    reference: ReferenceImage
    good_matches: List[cv2.DMatch] = field(default_factory=list)
    ref_keypoints: List[cv2.KeyPoint] = field(default_factory=list)
    ref_shape: Tuple[int, int] = (0, 0)
    inliers: int = 0
    inlier_mask: Optional[np.ndarray] = None
    homography: Optional[np.ndarray] = None
    anisotropy: Optional[float] = None
    perspective: Optional[float] = None
    rejected_reason: Optional[str] = None


class VisualPositioningSystem:
    """Matches a query photo against the reference database and geolocates it."""

    def __init__(self, database: ReferenceDatabase, config: Optional[VpsConfig] = None) -> None:
        self.config = config or VpsConfig()
        self.database = database
        self.extractor = FeatureExtractor(self.config)
        cache_dir = self.config.cache_dir or (database.root / CACHE_DIRNAME)
        self.cache = DescriptorCache(cache_dir, self.config.signature, self.config.use_cache)
        self._matcher = self._build_matcher()
        if not database.references:
            database.load()

    # -- matcher construction ----------------------------------------------

    def _build_matcher(self) -> cv2.DescriptorMatcher:
        """Pick FLANN or Brute-Force appropriately for the descriptor type.

        FLANN's LSH index is the only option for binary descriptors and is
        unreliable in practice (it can return fewer than k neighbours, which
        breaks the ratio test). ORB therefore defaults to Brute-Force Hamming,
        which is exact and fast enough at this scale.
        """
        choice = self.config.matcher
        if choice == "auto":
            choice = "flann" if not self.extractor.binary else "bruteforce"

        if choice == "bruteforce":
            # crossCheck must stay False: knnMatch requires k neighbours.
            LOG.debug("Using BFMatcher (norm=%s).", self.extractor.norm)
            return cv2.BFMatcher(self.extractor.norm, crossCheck=False)

        if self.extractor.binary:
            index_params = dict(
                algorithm=FLANN_INDEX_LSH, table_number=12,
                key_size=20, multi_probe_level=2,
            )
        else:
            index_params = dict(
                algorithm=FLANN_INDEX_KDTREE, trees=self.config.flann_trees
            )
        LOG.debug("Using FlannBasedMatcher (%s).", index_params)
        return cv2.FlannBasedMatcher(index_params, dict(checks=self.config.flann_checks))

    # -- reference features -------------------------------------------------

    def _reference_features(
        self, ref: ReferenceImage
    ) -> Optional[Tuple[List[cv2.KeyPoint], np.ndarray, Tuple[int, int]]]:
        """Load (or compute and cache) descriptors for one reference image."""
        cached = self.cache.load(ref.path)
        if cached is not None:
            return cached
        try:
            image = self.extractor.load_grayscale(ref.path)
        except (FileNotFoundError, ValueError) as exc:
            LOG.warning("Skipping reference %s: %s", ref.path.name, exc)
            return None
        keypoints, descriptors = self.extractor.detect(image)
        if descriptors is None:
            LOG.debug("No descriptors in reference %s", ref.path.name)
            return None
        shape = (image.shape[0], image.shape[1])
        self.cache.store(ref.path, keypoints, descriptors, shape)
        return keypoints, descriptors, shape

    def build_index(self) -> int:
        """Pre-compute descriptors for the whole database (warms the cache)."""
        ready = 0
        for ref in self.database.references:
            if self._reference_features(ref) is not None:
                ready += 1
        LOG.info("Feature index ready for %d/%d reference(s).",
                 ready, len(self.database.references))
        return ready

    # -- Lowe's ratio test --------------------------------------------------

    def _ratio_test(self, query_desc: np.ndarray, ref_desc: np.ndarray) -> List[cv2.DMatch]:
        """k=2 nearest-neighbour match filtered by Lowe's ratio test."""
        if ref_desc is None or len(ref_desc) < 2 or len(query_desc) < 2:
            return []
        try:
            knn = self._matcher.knnMatch(query_desc, ref_desc, k=2)
        except cv2.error as exc:
            LOG.debug("knnMatch failed: %s", exc)
            return []

        good: List[cv2.DMatch] = []
        ratio = self.config.ratio_threshold
        for pair in knn:
            # FLANN-LSH can return 0 or 1 neighbours; such pairs are unusable.
            if len(pair) < 2:
                continue
            best, second = pair[0], pair[1]
            if best.distance < ratio * second.distance:
                good.append(best)
        return good

    # -- geometric verification --------------------------------------------

    def _homography_metrics(
        self, homography: np.ndarray, query_shape: Tuple[int, int]
    ) -> Tuple[float, float]:
        """Return ``(anisotropy, perspective)`` descriptors of a homography.

        ``anisotropy`` is the ratio of the singular values of the affine part:
        1.0 for a pure similarity, large for a sheared or collapsed fit.
        ``perspective`` is the magnitude of the projective row scaled by image
        size, so it is comparable across resolutions.
        """
        matrix = np.asarray(homography, dtype=np.float64)
        if abs(matrix[2, 2]) < 1e-12:
            return (float("inf"), float("inf"))
        matrix = matrix / matrix[2, 2]
        affine = matrix[:2, :2]
        singular = np.linalg.svd(affine, compute_uv=False)
        if singular[1] < 1e-9:
            return (float("inf"), float("inf"))  # collapsed to a line
        anisotropy = float(singular[0] / singular[1])
        extent = float(max(query_shape))
        perspective = float(np.hypot(matrix[2, 0], matrix[2, 1]) * extent)
        return (anisotropy, perspective)

    def _verify(
        self, query_kps: Sequence[cv2.KeyPoint], candidate: MatchCandidate,
        query_shape: Tuple[int, int],
    ) -> MatchCandidate:
        """Fit a RANSAC homography, count inliers and reject degenerate fits."""
        if len(candidate.good_matches) < self.config.min_good_matches:
            candidate.rejected_reason = "too few ratio-test matches"
            return candidate

        src = np.float32(
            [query_kps[m.queryIdx].pt for m in candidate.good_matches]
        ).reshape(-1, 1, 2)
        dst = np.float32(
            [candidate.ref_keypoints[m.trainIdx].pt for m in candidate.good_matches]
        ).reshape(-1, 1, 2)

        homography, mask = cv2.findHomography(
            src, dst, cv2.RANSAC, self.config.ransac_reproj_threshold,
            maxIters=5000, confidence=0.995,
        )
        if homography is None or mask is None:
            candidate.rejected_reason = "RANSAC found no consistent model"
            return candidate

        anisotropy, perspective = self._homography_metrics(homography, query_shape)
        candidate.anisotropy = anisotropy
        candidate.perspective = perspective

        if self.config.require_similarity:
            if anisotropy > self.config.max_anisotropy:
                # Degenerate fit: a spurious match that RANSAC made
                # self-consistent. Zeroing the inliers drops it out of the
                # ranking so a plausible lower-ranked candidate can win.
                candidate.rejected_reason = (
                    f"non-conformal homography (anisotropy {anisotropy:.1f} > "
                    f"{self.config.max_anisotropy})"
                )
                LOG.debug("Rejected %s: %s", candidate.reference.tile_key,
                          candidate.rejected_reason)
                return candidate
            if perspective > self.config.max_perspective:
                candidate.rejected_reason = (
                    f"excessive perspective ({perspective:.3f} > "
                    f"{self.config.max_perspective})"
                )
                LOG.debug("Rejected %s: %s", candidate.reference.tile_key,
                          candidate.rejected_reason)
                return candidate

        candidate.homography = homography
        candidate.inlier_mask = mask.ravel().astype(bool)
        candidate.inliers = int(candidate.inlier_mask.sum())
        return candidate

    # -- scoring ------------------------------------------------------------

    def _confidence(self, inliers: int, good_matches: int) -> float:
        """Blend inlier count with inlier ratio into a 0..1 score.

        Count alone rewards texture-rich images that match everything; ratio
        alone can hit 1.0 on a handful of coincidental matches. The product of
        a saturating count term and a ratio term penalises both failure modes.
        """
        if good_matches <= 0 or inliers <= 0:
            return 0.0
        count_score = min(1.0, inliers / float(self.config.inlier_saturation))
        inlier_ratio = inliers / float(good_matches)
        return float(count_score * (0.5 + 0.5 * inlier_ratio))

    # -- geo-referencing ----------------------------------------------------

    def _pose_from_homography(
        self, candidate: MatchCandidate, query_shape: Tuple[int, int]
    ) -> Tuple[float, float, Optional[float], Optional[float], Optional[float]]:
        """Project the query centre into WGS84 and recover heading and scale.

        Returns ``(lat, lon, heading_deg, scale, gsd)``. Falls back to the
        reference centroid when the raster has no XYZ footprint or the
        homography is degenerate.
        """
        ref = candidate.reference
        if candidate.homography is None or not ref.is_tiled:
            return (ref.center_lat, ref.center_lon, None, None, ref.gsd_m_per_px)

        h, w = query_shape
        ref_h, ref_w = candidate.ref_shape if all(candidate.ref_shape) else (TILE_PIXELS, TILE_PIXELS)

        # Probe the query centre plus unit steps right and up, so one transform
        # yields position, orientation and local scale.
        probes = np.float32([
            [[w / 2.0, h / 2.0]],
            [[w / 2.0 + 1.0, h / 2.0]],
            [[w / 2.0, h / 2.0 - 1.0]],
        ])
        try:
            projected = cv2.perspectiveTransform(probes, candidate.homography)
        except cv2.error as exc:
            LOG.debug("perspectiveTransform failed: %s", exc)
            return (ref.center_lat, ref.center_lon, None, None, ref.gsd_m_per_px)

        centre, right, up = (projected[i][0] for i in range(3))
        if not np.all(np.isfinite(centre)):
            return (ref.center_lat, ref.center_lon, None, None, ref.gsd_m_per_px)

        lon, lat = tile_pixel_to_lonlat(
            int(ref.tile_z), int(ref.tile_x), int(ref.tile_y),
            float(centre[0]), float(centre[1]), ref_w, ref_h,
        )

        # Reference rasters are north-up, so image -y points to true north.
        # The bearing of the query's up-vector is therefore its heading.
        d_up = up - centre
        heading: Optional[float] = None
        if float(np.hypot(*d_up)) > 1e-6:
            heading = math.degrees(math.atan2(float(d_up[0]), float(-d_up[1]))) % 360.0

        # Local scale from the area of the transformed unit square.
        d_right = right - centre
        area = abs(d_right[0] * d_up[1] - d_right[1] * d_up[0])
        scale = float(math.sqrt(area)) if area > 0 else None

        gsd = None
        ref_gsd = ref.gsd_m_per_px or (
            ground_resolution_m_per_px(lat, int(ref.tile_z), ref_w)
            if ref.tile_z is not None else None
        )
        if scale and ref_gsd:
            # Reference metres-per-pixel scaled by reference-px per query-px.
            gsd = ref_gsd * scale
        return (lat, lon, heading, scale, gsd)

    # -- public API ---------------------------------------------------------

    def localize(
        self, query: "Path | str | np.ndarray", return_debug: bool = False
    ) -> Tuple[Optional[GeoPose], Dict[str, Any]]:
        """Locate ``query`` against the database.

        ``query`` is a path to an image file or an already-decoded array, so
        live frame sources can skip the filesystem entirely.

        Returns ``(pose, debug)``. ``pose`` is ``None`` only when nothing
        matched at all; a pose below the confidence threshold comes back with
        ``accepted=False`` so callers can inspect near-misses.
        """
        started = time.time()
        if isinstance(query, np.ndarray):
            query_raw = self.extractor.to_grayscale(query)
            label = f"<array {query_raw.shape[1]}x{query_raw.shape[0]}>"
        else:
            query_raw = self.extractor.load_grayscale(Path(query))
            label = str(query)
        query_image, resize_scale = self.extractor.preprocess_query(query_raw)
        query_kps, query_desc = self.extractor.detect(query_image)

        debug: Dict[str, Any] = {
            "query": label,
            "query_shape": [int(query_image.shape[0]), int(query_image.shape[1])],
            "resize_scale": round(resize_scale, 4),
            "query_keypoints": len(query_kps),
            "detector": self.config.detector,
            "matcher": self.config.matcher,
            "references_scanned": 0,
            "candidates": [],
        }
        if query_desc is None:
            LOG.error("No descriptors found in the query image.")
            return None, debug

        # -- stage 1: cheap ranking by ratio-test match count ---------------
        candidates: List[MatchCandidate] = []
        for ref in self.database.references:
            features = self._reference_features(ref)
            if features is None:
                continue
            ref_kps, ref_desc, ref_shape = features
            debug["references_scanned"] += 1
            good = self._ratio_test(query_desc, ref_desc)
            if not good:
                continue
            candidates.append(
                MatchCandidate(
                    reference=ref, good_matches=good,
                    ref_keypoints=ref_kps, ref_shape=ref_shape,
                )
            )

        if not candidates:
            LOG.warning("No reference produced any ratio-test matches.")
            debug["elapsed_s"] = round(time.time() - started, 3)
            return None, debug

        candidates.sort(key=lambda c: len(c.good_matches), reverse=True)
        shortlist = candidates[: max(1, self.config.top_k_verify)]

        # -- stage 2: geometric verification of the shortlist ---------------
        query_shape = (query_image.shape[0], query_image.shape[1])
        for candidate in shortlist:
            self._verify(query_kps, candidate, query_shape)
        shortlist.sort(key=lambda c: (c.inliers, len(c.good_matches)), reverse=True)

        debug["candidates"] = [
            {
                "tile_key": c.reference.tile_key,
                "provider": c.reference.provider,
                "good_matches": len(c.good_matches),
                "inliers": c.inliers,
                "confidence": round(self._confidence(c.inliers, len(c.good_matches)), 4),
                "anisotropy": None if c.anisotropy is None else round(c.anisotropy, 3),
                "perspective": None if c.perspective is None else round(c.perspective, 4),
                "rejected_reason": c.rejected_reason,
            }
            for c in shortlist
        ]
        rejected = [
            c.reference.tile_key for c in shortlist
            if c.rejected_reason is not None and c.homography is None and c.anisotropy is not None
        ]
        if rejected:
            debug["geometrically_rejected"] = rejected

        best = shortlist[0]
        lat, lon, heading, scale, gsd = self._pose_from_homography(
            best, (query_image.shape[0], query_image.shape[1])
        )
        confidence = self._confidence(best.inliers, len(best.good_matches))
        pose = GeoPose(
            latitude=lat,
            longitude=lon,
            heading_deg=heading,
            confidence=confidence,
            inliers=best.inliers,
            good_matches=len(best.good_matches),
            reference=best.reference,
            scale_ref_per_query=scale,
            est_gsd_m_per_px=gsd,
            accepted=(
                confidence >= self.config.confidence_threshold
                and best.inliers >= self.config.min_inliers
                and best.homography is not None
            ),
            homography=best.homography,
            anisotropy=best.anisotropy,
        )
        if best.rejected_reason:
            debug["best_rejected_reason"] = best.rejected_reason

        debug["elapsed_s"] = round(time.time() - started, 3)
        if return_debug:
            # Arrays needed by the visualiser, kept out of the JSON summary.
            debug["_match"] = {
                "query_image": query_image,
                "query_keypoints": query_kps,
                "candidate": best,
            }
        return pose, debug


# ===========================================================================
# Visualisation
# ===========================================================================


def visualize_match(
    pose: GeoPose,
    debug: Dict[str, Any],
    save_path: Optional[Path] = None,
    max_lines: int = 60,
    show: bool = True,
) -> Optional[Any]:
    """Draw the query and matched reference side by side with match lines.

    Only RANSAC inliers are drawn, so the figure shows the correspondences the
    pose was actually derived from. Requires ``debug`` from
    ``localize(..., return_debug=True)``.
    """
    import matplotlib
    if save_path is not None and not show:
        matplotlib.use("Agg", force=True)  # headless rendering
    import matplotlib.pyplot as plt

    payload = debug.get("_match")
    if not payload:
        raise ValueError("Call localize(..., return_debug=True) before visualising.")

    query_image = payload["query_image"]
    query_kps = payload["query_keypoints"]
    candidate: MatchCandidate = payload["candidate"]

    ref_image = FeatureExtractor.load_grayscale(candidate.reference.path)

    # Prefer inliers; fall back to ratio-test matches if RANSAC found none.
    matches = candidate.good_matches
    if candidate.inlier_mask is not None and candidate.inlier_mask.any():
        matches = [m for m, keep in zip(candidate.good_matches, candidate.inlier_mask) if keep]
    matches = sorted(matches, key=lambda m: m.distance)[:max_lines]

    composite = cv2.drawMatches(
        query_image, query_kps,
        ref_image, candidate.ref_keypoints,
        matches, None,
        matchColor=(0, 255, 0), singlePointColor=(255, 0, 0),
        flags=cv2.DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS,
    )

    figure, axes = plt.subplots(figsize=(14, 7))
    axes.imshow(cv2.cvtColor(composite, cv2.COLOR_BGR2RGB))
    axes.set_axis_off()

    heading = "n/a" if pose.heading_deg is None else f"{pose.heading_deg:.1f} deg"
    verdict = "ACCEPTED" if pose.accepted else "REJECTED"
    axes.set_title(
        f"Query (left)  <->  {candidate.reference.tile_key} "
        f"[{candidate.reference.provider}] (right)\n"
        f"{verdict}  |  lat {pose.latitude:.6f}, lon {pose.longitude:.6f}  |  "
        f"heading {heading}  |  confidence {pose.confidence:.3f}  |  "
        f"{pose.inliers}/{pose.good_matches} inliers  |  {len(matches)} lines shown",
        fontsize=10,
    )
    # Reserve the bottom strip so the attribution never overlaps the imagery.
    figure.tight_layout(rect=(0.0, 0.05, 1.0, 1.0))
    if candidate.reference.attribution:
        figure.text(
            0.5, 0.015, f"Reference imagery: {candidate.reference.attribution}",
            ha="center", fontsize=7, color="#555555",
        )

    if save_path is not None:
        save_path = Path(save_path)
        save_path.parent.mkdir(parents=True, exist_ok=True)
        figure.savefig(save_path, dpi=150, bbox_inches="tight")
        LOG.info("Visualisation written to %s", save_path)
    if show:
        plt.show()
    else:
        plt.close(figure)
    return figure


# ===========================================================================
# CLI
# ===========================================================================


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="vps_complete",
        description="Estimate a photograph's latitude, longitude and heading by "
                    "matching it against a local reference image database.",
    )
    parser.add_argument("--query", type=Path, help="Path to the query photograph.")
    parser.add_argument(
        "--db", type=Path, default=Path("map_data"),
        help="Reference database root, scanned recursively (default: map_data).",
    )
    parser.add_argument(
        "--detector", choices=("sift", "orb"), default="sift",
        help="Local feature detector (default: sift).",
    )
    parser.add_argument(
        "--matcher", choices=("auto", "flann", "bruteforce"), default="auto",
        help="auto = FLANN for SIFT, Brute-Force Hamming for ORB (default: auto).",
    )
    parser.add_argument(
        "--ratio", type=float, default=0.70,
        help="Lowe's ratio-test threshold (default: 0.70).",
    )
    parser.add_argument(
        "--threshold", type=float, default=0.30,
        help="Minimum confidence to accept a fix, 0..1 (default: 0.30).",
    )
    parser.add_argument(
        "--min-inliers", type=int, default=10,
        help="Minimum RANSAC inliers to accept a fix (default: 10).",
    )
    parser.add_argument(
        "--max-features", type=int, default=4000,
        help="Feature budget per image (default: 4000).",
    )
    parser.add_argument(
        "--top-k", type=int, default=10,
        help="Candidates passed to geometric verification (default: 10).",
    )
    parser.add_argument(
        "--allow-oblique", action="store_true",
        help="Disable the similarity-transform gate. Needed for oblique "
             "ground-level queries, where a projective homography is "
             "legitimate; leaves spurious degenerate fits unfiltered.",
    )
    parser.add_argument(
        "--max-anisotropy", type=float, default=4.0,
        help="Reject homographies whose affine part has a singular-value "
             "ratio above this (default: 4.0; correct nadir matches sit at ~1.0).",
    )
    parser.add_argument(
        "--visualize", type=Path, nargs="?", const=Path("vps_match.png"),
        help="Save the side-by-side match figure (default name: vps_match.png).",
    )
    parser.add_argument(
        "--show", action="store_true",
        help="Open the match figure in an interactive window.",
    )
    parser.add_argument(
        "--json", action="store_true", help="Emit the result as JSON on stdout."
    )
    parser.add_argument(
        "--list", action="store_true", help="Summarise the database and exit."
    )
    parser.add_argument(
        "--build-index", action="store_true",
        help="Pre-compute and cache reference descriptors, then exit.",
    )
    parser.add_argument("--no-cache", action="store_true", help="Bypass the feature cache.")
    parser.add_argument(
        "--log-level", default="INFO",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )

    try:
        database = ReferenceDatabase(args.db)
        if args.list:
            print(database.summary())
            return 0

        config = VpsConfig(
            detector=args.detector,
            matcher=args.matcher,
            ratio_threshold=args.ratio,
            confidence_threshold=args.threshold,
            min_inliers=args.min_inliers,
            max_features=args.max_features,
            top_k_verify=args.top_k,
            require_similarity=not args.allow_oblique,
            max_anisotropy=args.max_anisotropy,
            use_cache=not args.no_cache,
        )
        vps = VisualPositioningSystem(database, config)

        if args.build_index:
            vps.build_index()
            return 0
        if args.query is None:
            LOG.error("--query is required unless --list or --build-index is used.")
            return 2

        want_figure = args.visualize is not None or args.show
        pose, debug = vps.localize(args.query, return_debug=want_figure)
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        LOG.error("%s", exc)
        return 2

    if pose is None:
        if args.json:
            print(json.dumps({"accepted": False, "reason": "no matches", "debug": debug}, indent=2))
        else:
            print("No match found: the query shares no reliable features with the database.")
        return 1

    if args.json:
        payload = pose.as_dict()
        payload["debug"] = {k: v for k, v in debug.items() if not k.startswith("_")}
        print(json.dumps(payload, indent=2))
    else:
        print(pose)
        print(f"  Searched   : {debug['references_scanned']} reference(s) "
              f"in {debug.get('elapsed_s', 0)}s")

    if want_figure:
        try:
            visualize_match(pose, debug, save_path=args.visualize, show=args.show)
        except Exception as exc:  # visualisation must never mask a valid fix
            LOG.error("Visualisation failed: %s", exc)

    return 0 if pose.accepted else 1


if __name__ == "__main__":
    sys.exit(main())
