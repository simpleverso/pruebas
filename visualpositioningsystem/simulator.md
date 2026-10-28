# `simulator.py` — Drone flight simulator

Flies a virtual multirotor over the reference imagery, synthesises a camera
frame at each step, localises it with [`vps_complete.py`](vps_complete.md), and
reports tracking error against ground truth.

Its job is to **measure** the VPS, not to demo it. The per-step error log and
the aggregate report are the product.

---

## Quick start

```bash
V=map_data/.venv313/bin/python

# Defaults: lawnmower survey at 100 m, 8 m/s, 40 steps
$V simulator.py --db map_data

# A full 3-leg survey with a climb, logs and figures
$V simulator.py --db map_data --path lawnmower --legs 3 \
    --altitude 90 --climb 40 --velocity 25 --dt 4 --steps 36 \
    --csv simulation_log.csv --report sim_report.json --plot flight.png
```

Per-step output (real output, `--seed 42`):

```
step   t(s) |    true X    true Y      Z    hdg |     est X     est Y est hdg |  err(m)   dHdg  conf  inl    ms | note
----------------------------------------------------------------------------------------------------------------------
   0    0.0 |   -337.87   -337.87  100.0   90.0 |   -337.60   -337.82   90.06 |   0.274   0.06 0.933  150  1635 |
   1    4.0 |   -237.87   -337.87  100.0   90.0 |   -237.54   -337.81   90.03 |   0.336   0.03 0.962  244  1521 |
   2    8.0 |   -137.87   -337.87  100.0   90.0 |   -137.53   -337.81   89.98 |   0.341   0.02 0.952  189  1619 |
   3   12.0 |    -37.87   -337.87  100.0   90.0 |    -37.57   -337.85   89.91 |   0.300   0.09 0.925  158  1650 |
   4   16.0 |     62.13   -337.87  100.0   90.0 |     62.38   -337.80   89.99 |   0.253   0.01 0.933   78  1607 |
```

When the VPS cannot trust a match it reports **no fix** rather than a
plausible-looking wrong answer. Forcing a too-narrow shortlist with
`--top-k 5` reproduces that on this route at step 5:

```
   5   20.0 |    162.13   -337.87  100.0   90.0 |    241.60   -362.40 - | - - 0.000    0  1328 | rejected: non-conformal homography (anisotropy 376.7 > 4.0)
```

Before the geometric gate existed, that same step reported a confident fix
**543 m from the truth**. Refusing to answer is the correct outcome.

Exit codes: `0` when the fix rate holds **≥ 80 %**, `1` otherwise, `2` on a
configuration error. This makes the simulator usable as a regression gate in
CI — a change that degrades matching fails the build.

---

## Coordinate frames

| Frame | Definition |
|---|---|
| **WORLD** | Local ENU tangent plane in metres, anchored at the mosaic centre. X = east, Y = north, Z = altitude above ground. Over the few hundred metres a tile set spans, the spherical-to-planar error is millimetric. |
| **GEO** | WGS84 lat/lon — the VPS input and output frame. |
| **MOSAIC** | Pixel coordinates in the stitched north-up Web Mercator raster. |

Heading is a compass bearing: 0° = north, 90° = east. The camera is body-fixed
and nadir-pointing, so the drone's forward direction maps to the top of the
frame — exactly the convention the VPS recovers, which is what makes heading
error a meaningful measurement rather than a convention mismatch.

---

## Pipeline

```
MapMosaic        stitch all tiles at one zoom into one georeferenced raster
    │
    ▼
SimulatedDrone   crab toward the active waypoint, yaw slews to course
    │  true (X, Y, Z) + heading
    ▼
VirtualCamera    crop the mosaic footprint, rotate by heading, degrade
    │  512×512 greyscale frame (in memory, no disk round-trip)
    ▼
VisualPositioningSystem.localize(frame)
    │  GeoPose → lat/lon/heading/confidence
    ▼
StepRecord       true vs estimated, great-circle error, heading error
    │
    ▼
CSV + JSON report + 3-panel figure
```

### Why a mosaic and not a single tile

A realistic camera footprint spans several tiles — at 100 m altitude with a 60°
FOV the footprint is ~115 m, while a z18 tile is ~121 m. Slicing only the tile
directly beneath the drone would clip the field of view. The mosaic is stitched
once, and crops are taken across tile boundaries.

A consequence worth knowing: the VPS often matches a *neighbouring* tile rather
than the one under the drone, and that is correct — the homography extrapolates
the geolocation accurately. Error is therefore measured as great-circle
distance between true and estimated lat/lon, never by comparing tile IDs.

### Camera model

Altitude is physically meaningful, not cosmetic:

```
footprint_m = 2 · altitude · tan(fov / 2)
crop_px     = footprint_m / mosaic_gsd          → resized to sensor_px
query_gsd   = footprint_m / sensor_px
```

So `--climb` genuinely exercises the VPS's scale invariance during a run.

The crop is rotated by `+heading` so the drone's forward direction lands at
image up: the bearing vector `(sin h, −cos h)` in north-up mosaic coordinates
maps to `(0, −1)` under OpenCV's rotation matrix.

Degradations applied in order, all seeded by `--seed` for reproducibility:

| Stage | Control | Notes |
|---|---|---|
| Motion blur | `exposure_s`, velocity | Vertical streak of `speed · exposure / gsd` px, along travel. Disable with `--no-motion-blur`. |
| Defocus | `--blur` (σ=0.8) | Gaussian. |
| Vignetting | `vignette` (0.25) | Radial falloff, mask cached. |
| Brightness/gain jitter | `brightness_jitter` (0.08) | Per-frame exposure variation. |
| Sensor noise | `--noise` (σ=4 DN) | Additive Gaussian. |
| Compression | `--jpeg-quality` (85) | Real JPEG encode/decode round-trip. |

### Drone dynamics

`SimulatedDrone` crabs directly toward the active waypoint while the yaw axis
slews to the course at `max_yaw_rate_dps` (45°/s), with vertical rate capped at
3 m/s. This is how a multirotor actually flies a survey grid, and it keeps the
ground track exactly on the planned path so position error is attributable to
the VPS rather than to path-following overshoot.

### Flight paths

| `--path` | Shape |
|---|---|
| `lawnmower` | Boustrophedon survey, `--legs` parallel passes. The standard mapping-mission pattern. |
| `circle` | 37-point closed orbit, continuously varying heading. |
| `diagonal` | Single corner-to-corner transect. Useful for a fast smoke test. |

Waypoints are inset from the mosaic edge by a margin derived from the camera
itself (`VirtualCamera.required_margin_m`), sized for the **highest** altitude
flown, so a rotated footprint can never fall outside coverage. If the area is
too small for the requested altitude you get an actionable error rather than a
run of empty captures:

```
ERROR sim: Mosaic too small for a 738 m camera margin.
           Lower --altitude, narrow --fov, or download a larger area.
```

---

## Metrics report

```
==============================================================================
TRACKING METRICS REPORT
==============================================================================
Steps              : 29   Fixes: 29 (100.0%)
Flight distance    : 2400.0 m over 116 s simulated
Mosaic             : z18 1792x1792 px, 0.4719 m/px, tiles 49/49 [esri_world_imagery]
Position error (m) : mean 0.256  median 0.3  p95 0.349  max 0.358  rmse 0.274  sd 0.098
Error bias (m)     : east +0.116  north -0.017
Error in pixels    : mean 0.54 mosaic px
Heading error (deg): mean 0.032  max 0.086
VPS confidence     : mean 0.9301  min 0.7241
VPS latency (ms)   : mean 1616.8  max 2055.1
==============================================================================
```

A `Failure notes` line appears only when some step produced no fix.

Reading it:

- **Median vs mean.** A single confidently-wrong fix wrecks the mean while the
  median stays clean. Both are reported for exactly that reason — if they
  diverge, you have outliers, not noise.
- **Error bias.** A consistent east/north offset indicates a georeferencing
  shift (projection or tile-origin bug); scattered signs indicate matching
  noise.
- **Error in pixels.** Normalises error by mosaic GSD. Below 1.0 means
  sub-pixel, i.e. you are at the resolution limit of the reference imagery and
  only higher-zoom tiles will improve it.
- **Fix rate.** Drives the exit code. A rejected step is a *success* for
  safety, a *failure* for availability.

Per-step CSV columns (`--csv`): `step, t_s, true_x, true_y, true_z, true_lat,
true_lon, true_heading, fix, est_lat, est_lon, est_x, est_y, est_heading,
confidence, inliers, matched_tile, error_m, error_east_m, error_north_m,
error_heading_deg, vps_ms, note`.

`--report` writes the aggregate block as JSON for trend tracking.

---

## Figure (`--plot`)

Three panels:

1. **Ground track over the mosaic** — true path, VPS fixes coloured by error
   magnitude, red × at steps with no fix.
2. **Error history** — position error over time with the mean and the
   one-mosaic-pixel reference line, plus heading error on a twin axis.
3. **3D flight profile** — the trajectory including altitude, so a `--climb`
   run is visible.

---

## CLI reference

### World
| Flag | Default | Purpose |
|---|---|---|
| `--db PATH` | `map_data` | Reference database root. |
| `--zoom INT` | highest available | Mosaic zoom level. |

### Flight
| Flag | Default | Purpose |
|---|---|---|
| `--path {lawnmower,circle,diagonal}` | `lawnmower` | Flight pattern. |
| `--legs INT` | `4` | Survey legs for the lawnmower pattern. |
| `--altitude FLOAT` | `100` | Altitude above ground, metres. Sets the footprint. |
| `--climb FLOAT` | `0` | Total altitude change over the path, metres. |
| `--velocity FLOAT` | `8` | Ground speed, m/s. Also drives motion blur. |
| `--dt FLOAT` | `2` | Timestep, seconds. |
| `--steps INT` | `40` | Maximum simulation steps. |

### Camera
| Flag | Default | Purpose |
|---|---|---|
| `--fov FLOAT` | `60` | Horizontal field of view, degrees. |
| `--sensor-px INT` | `512` | Square sensor resolution. |
| `--noise FLOAT` | `4.0` | Sensor noise σ in 8-bit DN. |
| `--blur FLOAT` | `0.8` | Defocus blur σ in pixels. |
| `--jpeg-quality INT` | `85` | JPEG quality; compression artefacts. |
| `--no-motion-blur` | off | Disable velocity-driven motion blur. |

### VPS
| Flag | Default | Purpose |
|---|---|---|
| `--detector {sift,orb}` | `sift` | Feature detector used by the VPS. |
| `--threshold FLOAT` | `0.30` | VPS confidence threshold. |
| `--top-k INT` | `10` | Candidates geometrically verified. Keep aligned with `VpsConfig.top_k_verify`; lowering it truncates the shortlist and reintroduces missed true matches. |

### Output
| Flag | Default | Purpose |
|---|---|---|
| `--csv PATH` | `simulation_log.csv` | Per-step CSV log. |
| `--report PATH` | — | Aggregate report as JSON. |
| `--plot [PATH]` | `flight_report.png` | Save the 3-panel figure. |
| `--show` | off | Display the figure interactively. |
| `--save-frames DIR` | — | Dump every simulated camera frame as JPEG. |
| `--seed INT` | `42` | RNG seed for reproducible sensor noise. |
| `--log-level` | `INFO` | Console verbosity. |

---

## Measured results

3-leg lawnmower, 2.4 km over a 49-tile z18 mosaic, SIFT, 29 steps:

| Metric | Flat 100 m (`--seed 42`) | 90→130 m climb (`--seed 7`) |
|---|---|---|
| Fix rate | 29/29 (100 %) | 29/29 (100 %) |
| Position error, mean | 0.256 m | 0.277 m |
| Position error, median | 0.300 m | 0.287 m |
| Position error, p95 / max | 0.349 / 0.358 m | 0.469 / 1.091 m |
| Error in mosaic pixels | 0.54 px | 0.59 px |
| Heading error, mean / max | 0.032° / 0.086° | 0.056° / 0.381° |
| VPS confidence, mean / min | 0.930 / 0.724 | 0.909 / 0.742 |
| VPS latency, mean | 1.62 s/frame | 1.50 s/frame |

Error is sub-pixel against the reference imagery in both cases, so only
higher-zoom tiles would improve it. Also verified across all three flight
patterns and both detectors (`circle` 0.317 m mean, `diagonal` 0.181 m, ORB
0.116 m over short runs).

### What this simulator found

The first run looked healthy on 27 of 29 steps but produced two fixes that were
**516 m and 543 m wrong at confidence 0.91 and 0.93** with ~100 RANSAC inliers.
For a positioning system that is worse than no fix, because downstream code
would trust it.

Root cause: Part 2's shortlist ranked candidates by raw ratio-test match count,
which carries no spatial information. The correct tile ranked only 5th of 49
(75 matches against 118 for an unrelated tile), so a shortlist of 5 truncated
it before verification. Raising `top_k` alone made things *worse* (532 m at
confidence 0.93) — more candidates means more chances for a degenerate
homography to win.

Two changes resolved it:

1. **The similarity gate** in `vps_complete.py`
   ([details](vps_complete.md#the-similarity-gate)) — rejects the degenerate
   homographies that confidence could not detect. This alone took mean error
   from 36.8 m to 0.26 m and converted the remaining bad step from a confident
   543 m error into an honest "no fix".
2. **Widening the shortlist to 10** and aligning `simulator.py --top-k` with
   `VpsConfig.top_k_verify`. The simulator had been passing `5`, silently
   clamping Part 2's default back down and truncating the true tile. With both
   changes the fix rate reaches 29/29.

This is the point of the simulator: a failure mode that confidence scores
cannot detect, and a defaults mismatch between two components, both found by
comparing against ground truth over a trajectory rather than on single images.

---

## Fidelity caveat

**Query frames are cut from the same orthoimagery that populates the reference
database.** Sensor degradation is modelled, but these are not:

- seasonal and vegetation change
- different sun angle and shadow direction
- oblique viewing angles and terrain relief (homography assumes a plane)
- lens distortion and rolling shutter
- a genuinely different camera and spectral response
- GNSS-denied drift between fixes (no dead-reckoning fallback is modelled)

Treat the error figures as a **lower bound** on real-world performance, and as
a regression baseline rather than a prediction. The honest use of this number
is "a change made matching worse", not "the drone will land within 0.3 m".

---

## Library use

```python
from pathlib import Path
import numpy as np
from vps_complete import ReferenceDatabase, VisualPositioningSystem, VpsConfig
from simulator import (MapMosaic, VirtualCamera, CameraConfig, SimulatedDrone,
                       FlightSimulation, build_flight_path, format_summary, plot_flight)

db = ReferenceDatabase(Path("map_data")); refs = db.load()
mosaic = MapMosaic(refs)                        # zoom=None → highest available

vps = VisualPositioningSystem(db, VpsConfig())
vps.build_index()

camera = VirtualCamera(mosaic, CameraConfig(fov_deg=60.0), np.random.default_rng(42))
margin = camera.required_margin_m(100.0)
path   = build_flight_path(mosaic, "lawnmower", altitude_m=100.0, margin_m=margin, legs=3)
drone  = SimulatedDrone.from_path(path, velocity=25.0)

sim = FlightSimulation(mosaic, vps, camera, drone, dt=4.0, max_steps=36)
sim.run()
print(format_summary(sim.summary()))
sim.write_csv(Path("log.csv"))
plot_flight(sim, Path("flight.png"))
```

### Key objects

| Object | Notes |
|---|---|
| `MapMosaic(references, zoom=None)` | `.image`, `.gsd`, `.frame` (ENU), `.lonlat_to_pixel()`, `.pixel_to_lonlat()`, `.xy_to_pixel()`, `.world_bounds()`, `.sample_patch()`. |
| `LocalFrame(lat0, lon0)` | `.to_xy(lat, lon)` / `.to_latlon(x, y)`. |
| `CameraConfig` | `fov_deg=60.0`, `sensor_px=512`, `blur_sigma=0.8`, `noise_sigma=4.0`, `jpeg_quality=85`, `vignette=0.25`, `exposure_s=0.004`, `brightness_jitter=0.08`, `motion_blur=True`. |
| `VirtualCamera(mosaic, cfg, rng)` | `.capture(lat, lon, altitude_m, heading_deg, speed_mps)`, `.footprint_m()`, `.ground_sample_distance()`, `.required_margin_m()`. |
| `SimulatedDrone` | `current_true_position` (X, Y, Z), `current_heading`, `velocity`, `max_yaw_rate_dps=45.0`, `waypoint_radius_m=2.0`. Build with `.from_path(waypoints, velocity)`; advance with `.update(dt)`. |
| `FlightSimulation` | `.run()`, `.step(i)`, `.summary()`, `.write_csv(path)`. |
| `StepRecord` | One row of the comparison log; see the CSV columns above. |

Standalone helpers: `lonlat_to_global_px`, `global_px_to_lonlat`,
`build_flight_path`, `format_summary`, `plot_flight`.

---

## Dependencies

`opencv-python`, `numpy`, and `vps_complete.py` in the same directory
· `matplotlib` (only for `--plot`/`--show`).

Needs a reference database with **tiled** imagery — XYZ tiles with known
footprints. EXIF-geotagged photos are not enough to build a mosaic. See
[map_data/README.md](map_data/README.md).
