# `vps_complete.py` — Visual Positioning System

Estimates where a photograph was taken by matching it against a local database
of georeferenced reference imagery, returning latitude, longitude, heading and
a confidence score.

- **Input:** a query image (file path or in-memory array) plus a reference
  database built by [Part 1](map_data/README.md).
- **Output:** a `GeoPose` — lat/lon, heading, confidence, and the reference
  image it matched.

---

## Quick start

The venv lives at `map_data/.venv313`. Because venvs are not relocatable, its
`pip` shebang is stale — use `python -m pip` with it if you need to install
anything.

```bash
V=map_data/.venv313/bin/python

# What is in the database?
$V vps_complete.py --db map_data --list

# Locate a photo
$V vps_complete.py --query photo.jpg --db map_data

# Locate it and save the side-by-side match figure
$V vps_complete.py --query photo.jpg --db map_data --visualize match.png

# Machine-readable output
$V vps_complete.py --query photo.jpg --db map_data --json
```

Typical accepted output:

```
ACCEPTED
  Latitude   : 37.7952544
  Longitude  : -122.3991958
  Heading    :  34.98 deg
  Confidence : 0.980 (142 inliers / 148 ratio-test matches)
  Reference  : 18/41943/101305 [esri_world_imagery]
  File       : map_data/reference_db/.../18/41943/101305.jpg
  Searched   : 49 reference(s) in 0.474s
```

Exit codes: `0` accepted, `1` below threshold or no match, `2` bad input or
missing database. A rejected fix is still printed with `accepted=false`, so you
can inspect near-misses instead of being handed a bare failure.

---

## How it works

```
query image
    │
    ├─ 1. preprocess      downscale >1600 px, CLAHE contrast equalisation
    ├─ 2. detect          SIFT (default) or ORB keypoints + descriptors
    ├─ 3. match           k=2 NN against every reference, Lowe's ratio test
    ├─ 4. shortlist       top 10 references by ratio-test match count
    ├─ 5. verify          RANSAC homography per candidate → inlier count
    ├─ 6. gate            reject non-conformal / over-perspective homographies
    ├─ 7. rank            best = most inliers
    ├─ 8. georeference    project query centre through H → WGS84
    └─ 9. score           confidence vs threshold → accept / reject
```

### Stage 5–6 is where correctness is won

Steps 1–4 are cheap but weak: ratio-test match **count** carries no spatial
information, so dense urban texture lets unrelated tiles outrank the correct
one. Measured on live data, the correct tile sometimes ranks only 5th of 49.
That is why the shortlist is 10 wide and why every candidate is geometrically
verified before anything is believed.

### The similarity gate

A nadir view of locally planar ground, matched against north-up orthoimagery,
must map through a **similarity transform** — uniform scale, rotation,
translation. RANSAC will nonetheless happily return a degenerate, strongly
non-conformal homography for a spurious match, and such a fix can carry *high*
confidence. Measured over a 29-step flight:

| metric | correct matches (n=28) | spurious matches |
|---|---|---|
| anisotropy (σ₁/σ₂ of the affine part) | 1.000 – 1.014 | 45.9 / 2350 |
| perspective × image width | 0.000 – 0.018 | 0.97 / 3.59 |
| **confidence** | 0.838 – 0.974 | 0.733 / **0.930** |

Confidence cannot separate them. Conformality separates them by 45–2300×.
So `require_similarity` (default **on**) rejects any homography whose
anisotropy exceeds `max_anisotropy=4.0` or whose perspective term exceeds
`max_perspective=0.20`. A rejected candidate has its inliers zeroed, which
drops it out of the ranking and lets a plausible lower-ranked candidate win.

Without this gate the same flight produced two fixes that were **516 m and
543 m wrong at confidence 0.91 and 0.93** — silent, confident errors. With the
gate, mean error over the route is 0.26 m; with the gate plus a shortlist wide
enough to contain the true tile, all 29 steps resolve correctly. When the gate
fires it costs availability, not correctness: the step reports no fix rather
than a plausible lie.

> **Oblique queries.** A ground-level photo at an angle produces a genuinely
> projective homography and *will* be rejected by this gate. Pass
> `--allow-oblique` (or `VpsConfig(require_similarity=False)`) for that case,
> accepting that spurious degenerate fits are then unfiltered. In that mode,
> heading is also unreliable (see below).

### Geolocation accuracy

The query centre is projected through the homography into the matched tile's
pixel frame, then converted to WGS84 by **inverting the Mercator projection
analytically**. Interpolating latitude linearly between a tile's north and
south edges would introduce error that grows with latitude; this does not.

Because the transform extrapolates, matching a *neighbouring* tile is not an
error — a match on the tile next door still georeferences correctly. The
correctness criterion is great-circle distance, never "did it pick the tile
directly underneath".

### Heading

The reference raster is north-up, so image `-y` points to true north. The
bearing of the query's up-vector after transformation is therefore its heading.
Returned as a compass bearing: 0° = north, 90° = east.

This is valid for nadir / near-nadir views. For an oblique ground photo the
planarity assumption breaks: the tile match may still be right, but treat
`heading_deg` as unreliable and the position as a tile centroid rather than a
metric fix.

### Confidence score

```python
confidence = min(1, inliers / 50) * (0.5 + 0.5 * inliers / good_matches)
```

A saturating count term times an inlier-ratio term. Count alone rewards
texture-rich images that match everything; ratio alone saturates on a handful
of coincidental matches. The product penalises both failure modes.

Acceptance requires **all** of: `confidence >= confidence_threshold`,
`inliers >= min_inliers`, and a homography that survived the gate.

---

## Reference metadata

Each reference image needs a location. Resolved in order of decreasing
precision:

1. **`tile_index.geojson`** written by Part 1 — exact footprint, provider and
   attribution. Preferred.
2. **The `<z>/<x>/<y>.ext` path itself**, inverted through the tile maths.
   Verified to agree with (1) to 7 decimal places.
3. **EXIF GPS tags**, so a directory of ordinary geotagged photos also works.
   Requires Pillow; silently skipped if absent.

Discovery is recursive from `--db`, skipping `.venv*`, `__pycache__` and the
feature cache. Paths are resolved so the two passes cannot double-index a file.

---

## Performance

Descriptors for every reference are computed once and cached as `.npz` under
`<db>/.vps_feature_cache/`, keyed by file identity (path, mtime, size) and
detector settings, so changing the detector or re-downloading a tile
invalidates the entry automatically. `cv2.KeyPoint` is not picklable, so
keypoints are stored as an `(N, 7)` float array and rebuilt on load.

- Cold (first run, 49 tiles): descriptors computed for every reference.
- Warm: **~0.47 s** per query against 49 references.

Stage 3 is a linear scan that builds a matcher index per reference, so query
time grows linearly with database size. For thousands of tiles you would want
a coarse pre-filter (a global vocabulary/BoW index, or a GPS prior to restrict
candidates). Warm this cache ahead of time with `--build-index`.

---

## CLI reference

| Flag | Default | Purpose |
|---|---|---|
| `--query PATH` | — | Query photograph. Required unless `--list`/`--build-index`. |
| `--db PATH` | `map_data` | Reference database root, scanned recursively. |
| `--detector {sift,orb}` | `sift` | Local feature detector. |
| `--matcher {auto,flann,bruteforce}` | `auto` | `auto` = FLANN for SIFT, Brute-Force Hamming for ORB. |
| `--ratio FLOAT` | `0.70` | Lowe's ratio-test threshold. |
| `--threshold FLOAT` | `0.30` | Minimum confidence to accept a fix. |
| `--min-inliers INT` | `10` | Minimum RANSAC inliers to accept a fix. |
| `--max-features INT` | `4000` | Feature budget per image. |
| `--top-k INT` | `10` | Candidates sent to geometric verification. |
| `--allow-oblique` | off | Disable the similarity gate (for oblique queries). |
| `--max-anisotropy FLOAT` | `4.0` | Conformality limit; correct nadir matches sit at ~1.0. |
| `--visualize [PATH]` | `vps_match.png` | Save the side-by-side match figure. |
| `--show` | off | Open the figure interactively. |
| `--json` | off | Emit the result as JSON on stdout. |
| `--list` | off | Summarise the database and exit. |
| `--build-index` | off | Pre-compute and cache reference descriptors, then exit. |
| `--no-cache` | off | Bypass the feature cache. |
| `--log-level` | `INFO` | `DEBUG` prints per-candidate rejection reasons. |

### Why ORB does not use FLANN by default

FLANN's LSH index is the only option for binary descriptors and is unreliable
in practice: `knnMatch` can return fewer than `k` neighbours, which silently
breaks Lowe's ratio test. ORB therefore defaults to Brute-Force Hamming, which
is exact and fast enough at this scale. `--matcher flann` still forces it, and
the ratio test guards against short neighbour lists either way.

---

## Library use

```python
from pathlib import Path
from vps_complete import (ReferenceDatabase, VisualPositioningSystem,
                          VpsConfig, visualize_match)

db = ReferenceDatabase(Path("map_data"))
db.load()

vps = VisualPositioningSystem(db, VpsConfig(detector="sift", confidence_threshold=0.35))
vps.build_index()                      # optional: warm the descriptor cache

pose, debug = vps.localize("photo.jpg", return_debug=True)

if pose and pose.accepted:
    print(pose.latitude, pose.longitude, pose.heading_deg, pose.confidence)
    visualize_match(pose, debug, save_path=Path("match.png"), show=False)
else:
    print("no usable fix:", debug.get("best_rejected_reason"))
```

`localize()` accepts a path **or** a NumPy array (greyscale, BGR or BGRA), so a
live frame source can skip the filesystem. Path, greyscale-array and BGR-array
inputs agree to ~1 cm; the residual is RANSAC's internal randomness.

### Key objects

| Object | Notes |
|---|---|
| `ReferenceDatabase(root)` | `.load()` discovers references; `.summary()` reports coverage. |
| `VpsConfig(...)` | All tunables. See the table above plus `max_perspective`, `inlier_saturation`, `min_good_matches`, `ransac_reproj_threshold`, `max_query_dimension`, `cache_dir`. |
| `VisualPositioningSystem(db, cfg)` | `.localize(query, return_debug=False)`, `.build_index()`. |
| `GeoPose` | `latitude`, `longitude`, `heading_deg`, `confidence`, `inliers`, `good_matches`, `reference`, `scale_ref_per_query`, `est_gsd_m_per_px`, `accepted`, `homography`, `anisotropy`. `.as_dict()` for JSON. |
| `visualize_match(pose, debug, ...)` | Needs `return_debug=True`. Draws inliers only. |

The `debug` dict carries `query_keypoints`, `references_scanned`, `elapsed_s`,
a ranked `candidates` list (with per-candidate `anisotropy`, `perspective` and
`rejected_reason`), `geometrically_rejected`, and `best_rejected_reason`.

---

## Measured accuracy

Synthetic queries built from known tiles with a known rotation, scale and crop
offset; expected pose derived independently of the module.

| Detector / matcher | Tile ID | Position error | Heading error | Confidence |
|---|---|---|---|---|
| SIFT / FLANN | 5/5 correct | 0.01 – 0.31 m | ≤ 0.02° | 0.95 – 1.00 |
| ORB / Brute-Force | 5/5 correct | 0.02 – 0.36 m | ≤ 0.16° | 0.98 – 1.00 |

Position error is sub-pixel at z18 (0.47 m/px). Recovered scale matched applied
scale to three decimals. Random-noise and flat-grey inputs are rejected, not
crashed.

**These figures are a lower bound.** Query images were cut from the same
orthoimagery that populates the reference database. Real-world matching must
also survive seasonal change, different sun angles, shadow movement, lens
distortion and a different sensor — none of which are represented here.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No geolocated reference images under <path>` | Database empty or lacks tile metadata. Build it — see [map_data/README.md](map_data/README.md). |
| `--list` shows 0 images | Pointing at the wrong root, or imagery is outside the skipped-directory rules. |
| Accepted fix, obviously wrong location | Lower `--threshold` will not help. Run `--log-level DEBUG` and read the candidate list; if the true tile is absent, raise `--top-k`. |
| Everything rejected, query is oblique | Expected. Use `--allow-oblique` and distrust the heading. |
| Everything rejected, query is nadir | Too little texture or wrong scale. Check the database covers the area and the zoom is comparable to the query's ground resolution. |
| `This OpenCV build has no SIFT` | `pip install 'opencv-python>=4.4'` or use `--detector orb`. |
| Slow queries | Run `--build-index` once. Query cost is linear in database size. |

---

## Dependencies

`opencv-python`, `numpy` (required) · `matplotlib` (only for `--visualize`/`--show`)
· `Pillow` (only for the EXIF metadata fallback).

Verified with OpenCV 5.0.0, NumPy 2.5.4, matplotlib 3.11.2 on Python 3.13.

---

## Attribution

Reference imagery carries licence obligations that propagate to anything built
on it. The attribution string travels with every reference through
`tile_index.geojson` into `GeoPose.reference.attribution` and onto the
visualisation figure. Keep it visible in derived products. See
[map_data/README.md](map_data/README.md) for per-provider licence terms.
