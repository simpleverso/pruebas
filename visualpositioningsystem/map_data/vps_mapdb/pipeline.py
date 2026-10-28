"""End-to-end orchestration: vector download, imagery download, manifest.

``MapDatabaseBuilder`` is the single entry point used by the CLI and the one to
import from other code::

    from vps_mapdb import BBox, BuildConfig, MapDatabaseBuilder

    cfg = BuildConfig(bbox=BBox.parse("40.410,-3.712,40.425,-3.690"))
    manifest = MapDatabaseBuilder(cfg).build()
"""

from __future__ import annotations

import logging
import platform
import sys
import time
from typing import Any, Dict, Optional

from .config import BuildConfig
from .imagery import ImageryDownloader, PROVIDERS, resolve_provider
from .net import HttpClient, RateLimiter
from .osm_source import OsmVectorSource
from .storage import Storage, utc_now_iso
from .tiles import count_tiles, ground_resolution_m_per_px

LOG = logging.getLogger(__name__)

try:  # tqdm is a hard requirement in practice, but never break on import.
    from tqdm.auto import tqdm
except ImportError:  # pragma: no cover
    tqdm = None  # type: ignore[assignment]


class _NullProgress:
    """No-op stand-in used when tqdm is unavailable."""

    def update(self, _n: int = 1) -> None:
        pass

    def set_postfix_str(self, _s: str, refresh: bool = False) -> None:
        pass

    def close(self) -> None:
        pass

    def __enter__(self) -> "_NullProgress":
        return self

    def __exit__(self, *exc_info: object) -> None:
        pass


def _make_progress(total: int, description: str) -> Any:
    if tqdm is None or total <= 0:
        return _NullProgress()
    return tqdm(
        total=total,
        desc=description,
        unit="item",
        dynamic_ncols=True,
        smoothing=0.1,
    )


class MapDatabaseBuilder:
    """Builds (or incrementally refreshes) one region of the map database."""

    def __init__(self, config: BuildConfig) -> None:
        self.config = config
        self.storage = Storage(config)
        self.rate_limiter = RateLimiter(config.requests_per_second)

    # -- planning -----------------------------------------------------------

    def estimate(self) -> Dict[str, Any]:
        """Dry-run report: tile counts, disk estimate, provider validity."""
        bbox = self.config.bbox
        lat, _ = bbox.center

        zoom_report = []
        for zoom in self.config.zoom_levels:
            tiles = count_tiles(bbox, zoom)
            zoom_report.append(
                {
                    "zoom": zoom,
                    "tiles": tiles,
                    "ground_resolution_m_per_px": round(
                        ground_resolution_m_per_px(lat, zoom), 4
                    ),
                }
            )

        providers = []
        for name in self.config.imagery_providers:
            try:
                provider = resolve_provider(name)
            except ValueError as exc:
                providers.append({"name": name, "error": str(exc)})
                continue
            entry = provider.describe()
            entry["credentials_ok"] = (
                not provider.requires_key()
                or bool(self.config.api_keys.get(provider.api_key_name or ""))
            )
            providers.append(entry)

        total_tiles = sum(z["tiles"] for z in zoom_report) * max(1, len(providers))
        capped = min(
            total_tiles,
            self.config.max_tiles_per_provider * max(1, len(providers)),
        )
        return {
            "region_id": self.config.region_id,
            "zoom_levels": zoom_report,
            "providers": providers,
            "tiles_uncapped": total_tiles,
            "tiles_after_cap": capped,
            # ~25 kB/tile is a realistic average for 256 px aerial JPEG tiles.
            "estimated_imagery_mb": round(capped * 25 / 1024, 1),
            "estimated_minutes_at_current_rate": round(
                capped / max(self.config.requests_per_second, 0.01) / 60.0, 1
            ),
            "vector_layers": sorted(self.config.feature_layers),
        }

    # -- build --------------------------------------------------------------

    def build(self) -> Dict[str, Any]:
        """Run the full pipeline and return the manifest that was written."""
        started = time.time()
        self.storage.prepare()

        manifest: Dict[str, Any] = {
            "schema_version": "1.0",
            "generated_utc": utc_now_iso(),
            "generator": "vps-mapdb",
            "environment": {
                "python": sys.version.split()[0],
                "platform": platform.platform(),
            },
            "config": self.config.describe(),
            "estimate": self.estimate(),
        }

        if self.config.dry_run:
            LOG.info("Dry run: no data will be downloaded.")
            manifest["dry_run"] = True
            self.storage.write_manifest(manifest)
            return manifest

        manifest["area"] = self.storage.write_bbox_geojson()

        with HttpClient(
            user_agent=self.config.user_agent,
            rate_limiter=self.rate_limiter,
            timeout=self.config.timeout,
            max_retries=self.config.max_retries,
            pool_size=max(8, self.config.imagery_workers * 2),
        ) as client:

            # -- vector ----------------------------------------------------
            if self.config.vector_backend != "none":
                vector_source = OsmVectorSource(self.config, self.storage, client)
                progress = _make_progress(vector_source.step_count(), "OSM vector layers")
                try:
                    manifest["vector"] = vector_source.run(progress=progress)
                finally:
                    progress.close()
            else:
                manifest["vector"] = {"skipped": True}

            # -- raster ----------------------------------------------------
            if self.config.imagery_providers:
                downloader = ImageryDownloader(self.config, self.storage, client)
                total_tiles = downloader.step_count()
                LOG.info("Imagery plan: %d tile request(s).", total_tiles)
                progress = _make_progress(total_tiles, "Imagery tiles")
                try:
                    manifest["imagery"] = downloader.run(progress=progress)
                finally:
                    progress.close()
            else:
                manifest["imagery"] = {"skipped": True}

        manifest["duration_seconds"] = round(time.time() - started, 1)
        manifest["attributions"] = sorted(
            {
                PROVIDERS[name].attribution
                for name in self.config.imagery_providers
                if name in PROVIDERS
            }
            | {"Map data (c) OpenStreetMap contributors, ODbL 1.0"}
        )
        self.storage.write_manifest(manifest)
        LOG.info(
            "Database ready at %s (%.1fs).",
            self.storage.region_dir, manifest["duration_seconds"],
        )
        return manifest


def summarise(manifest: Dict[str, Any]) -> str:
    """Human-readable one-screen summary of a completed build."""
    lines = [
        "",
        "=" * 68,
        f"Region      : {manifest['config']['region_id']}",
        f"Output      : {manifest['config']['output_root']}",
    ]
    bbox = manifest["config"]["bbox"]
    lines.append(
        "BBox        : {:.5f}{} {:.5f}{} -> {:.5f}{} {:.5f}{}".format(
            abs(bbox["south"]), "N" if bbox["south"] >= 0 else "S",
            abs(bbox["west"]), "E" if bbox["west"] >= 0 else "W",
            abs(bbox["north"]), "N" if bbox["north"] >= 0 else "S",
            abs(bbox["east"]), "E" if bbox["east"] >= 0 else "W",
        )
    )

    if manifest.get("dry_run"):
        est = manifest["estimate"]
        lines.append(f"Dry run     : {est['tiles_after_cap']} tile request(s), "
                     f"~{est['estimated_imagery_mb']} MB, "
                     f"~{est['estimated_minutes_at_current_rate']} min")
        for zoom in est["zoom_levels"]:
            lines.append(
                f"  z{zoom['zoom']:<3}      : {zoom['tiles']:>7} tiles  "
                f"({zoom['ground_resolution_m_per_px']} m/px)"
            )
        lines.append("=" * 68)
        return "\n".join(lines)

    vector = manifest.get("vector") or {}
    if vector.get("skipped"):
        lines.append("Vector      : skipped")
    else:
        lines.append(f"Vector      : backend={vector.get('backend')}")
        for name, info in sorted((vector.get("layers") or {}).items()):
            if not isinstance(info, dict):
                continue
            if "feature_count" in info:
                note = f"  [{info['error'][:40]}]" if info.get("error") else ""
                lines.append(f"  {name:<18}: {info['feature_count']:>7} features{note}")
            elif "nodes" in info:
                lines.append(f"  {name:<18}: {info['nodes']:>7} nodes, {info['edges']} edges")
            elif info.get("error"):
                lines.append(f"  {name:<18}: ERROR {info['error'][:48]}")

    imagery = manifest.get("imagery") or {}
    if imagery.get("skipped"):
        lines.append("Imagery     : skipped")
    else:
        for name, info in sorted(imagery.items()):
            if info.get("error") and "tiles_requested" not in info:
                lines.append(f"  {name:<18}: ERROR {info['error'][:48]}")
                continue
            flag = "  <-- CHECK" if info.get("error") else ""
            lines.append(
                f"  {name:<18}: {info.get('tiles_downloaded', 0)} new, "
                f"{info.get('tiles_cached', 0)} cached, "
                f"{info.get('tiles_skipped', 0)} empty, "
                f"{info.get('tiles_failed', 0)} failed "
                f"({info.get('bytes_downloaded', 0) / 1e6:.1f} MB){flag}"
            )

    if manifest.get("attributions"):
        lines.append("Attribution : " + "; ".join(manifest["attributions"]))
    lines.append(f"Duration    : {manifest.get('duration_seconds', 0)}s")
    lines.append("=" * 68)
    return "\n".join(lines)
