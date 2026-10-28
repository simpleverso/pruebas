"""OSM vector acquisition.

Prefers ``osmnx`` (gives a routable street graph plus clean geometry via
shapely) and transparently falls back to the raw Overpass client when osmnx
is not installed or a particular layer fails. Both osmnx 1.x and 2.x argument
conventions are supported.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from .config import BuildConfig
from .net import HttpClient
from .overpass import OverpassClient, TagFilter
from .storage import Storage, geodataframe_to_features

LOG = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# osmnx compatibility shims
# ---------------------------------------------------------------------------


def load_osmnx() -> Optional[Any]:
    """Import and configure osmnx, or return ``None`` if unavailable."""
    try:
        import osmnx as ox  # noqa: WPS433 (runtime-optional dependency)
    except ImportError:
        LOG.info("osmnx not installed; using the Overpass backend instead.")
        return None
    except Exception as exc:  # pragma: no cover - broken install
        LOG.warning("osmnx failed to import (%s); using Overpass instead.", exc)
        return None
    return ox


def configure_osmnx(ox: Any, config: BuildConfig) -> None:
    """Apply polite-client settings across osmnx 1.x / 2.x."""
    settings = getattr(ox, "settings", None)
    if settings is None:  # pragma: no cover - osmnx < 1.2
        return
    for attr, value in (
        ("overpass_endpoint", config.overpass_endpoint.rsplit("/", 1)[0]),
        ("requests_timeout", int(config.read_timeout_s)),
        ("overpass_rate_limit", True),
        ("log_console", False),
        ("use_cache", True),
        # osmnx defaults to ./cache, which litters the working directory.
        # Keep its response cache alongside the data it belongs to.
        ("cache_folder", str(config.output_root / ".osmnx_cache")),
    ):
        if hasattr(settings, attr):
            try:
                setattr(settings, attr, value)
            except Exception:  # pragma: no cover - defensive
                LOG.debug("Could not set osmnx setting %s", attr)

    # osmnx composes its own User-Agent header; keep ours identifiable.
    for attr in ("http_user_agent", "default_user_agent"):
        if hasattr(settings, attr):
            try:
                setattr(settings, attr, config.user_agent)
            except Exception:  # pragma: no cover - defensive
                pass


def _features_from_bbox(ox: Any, config: BuildConfig, tags: TagFilter) -> Any:
    """Call ``ox.features_from_bbox`` across both argument conventions."""
    west, south, east, north = config.bbox.as_osmnx()
    try:
        # osmnx >= 2.0: bbox=(left, bottom, right, top)
        return ox.features_from_bbox(bbox=(west, south, east, north), tags=tags)
    except TypeError:
        # osmnx 1.x: explicit north/south/east/west keywords
        return ox.features_from_bbox(
            north=north, south=south, east=east, west=west, tags=tags
        )


def _graph_from_bbox(ox: Any, config: BuildConfig) -> Any:
    """Call ``ox.graph_from_bbox`` across both argument conventions."""
    west, south, east, north = config.bbox.as_osmnx()
    kwargs = {"network_type": config.network_type, "retain_all": True, "truncate_by_edge": True}
    try:
        return ox.graph_from_bbox(bbox=(west, south, east, north), **kwargs)
    except TypeError:
        return ox.graph_from_bbox(north=north, south=south, east=east, west=west, **kwargs)


# ---------------------------------------------------------------------------
# Vector pipeline
# ---------------------------------------------------------------------------


class OsmVectorSource:
    """Downloads every vector layer and writes it through :class:`Storage`."""

    def __init__(self, config: BuildConfig, storage: Storage, client: HttpClient) -> None:
        self.config = config
        self.storage = storage
        self.overpass = OverpassClient(client, config)

        self.ox: Optional[Any] = None
        if config.vector_backend in {"auto", "osmnx"}:
            self.ox = load_osmnx()
            if self.ox is not None:
                configure_osmnx(self.ox, config)
            elif config.vector_backend == "osmnx":
                raise RuntimeError(
                    "vector_backend='osmnx' requested but osmnx could not be "
                    "imported. Install it (`pip install osmnx`) or use "
                    "--vector-backend overpass."
                )

    @property
    def backend_name(self) -> str:
        return "osmnx" if self.ox is not None else "overpass"

    # -- feature layers -----------------------------------------------------

    def _fetch_layer_osmnx(self, name: str, tags: TagFilter) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """Fetch one layer via osmnx; returns ``(features, error)``."""
        try:
            gdf = _features_from_bbox(self.ox, self.config, tags)
        except Exception as exc:
            # osmnx raises InsufficientResponseError for genuinely empty areas;
            # treat that as "no data" rather than a failure.
            if type(exc).__name__ in {"InsufficientResponseError", "EmptyOverpassResponse"}:
                LOG.info("Layer %r: no matching OSM features in this bbox.", name)
                return [], None
            LOG.warning("osmnx failed on layer %r (%s); falling back to Overpass.",
                        name, exc)
            return [], f"osmnx: {exc}"
        return geodataframe_to_features(gdf), None

    def fetch_feature_layers(self, progress: Optional[Any] = None) -> Dict[str, Any]:
        """Download every configured tag layer and persist it as GeoJSON."""
        results: Dict[str, Any] = {}
        raw_responses: Dict[str, Any] = {}

        for name, tags in self.config.feature_layers.items():
            if progress is not None:
                progress.set_postfix_str(f"vector:{name}", refresh=True)

            features: List[Dict[str, Any]] = []
            error: Optional[str] = None
            source = self.backend_name

            if self.ox is not None:
                features, error = self._fetch_layer_osmnx(name, tags)

            # Fall back to Overpass when osmnx is absent or errored out.
            if self.ox is None or error is not None:
                outcome = self.overpass.fetch_layer(name, tags)
                if outcome["error"] is None:
                    features = outcome["features"]
                    error = None
                    source = "overpass"
                    if outcome["raw"] is not None:
                        raw_responses[name] = outcome["raw"]
                else:
                    error = error or outcome["error"]

            summary = self.storage.write_geojson(
                self.storage.vector_dir / f"{name}.geojson",
                features,
                extra={"source": source, "osm_tags": {k: _tag_repr(v) for k, v in tags.items()}},
            )
            summary["source"] = source
            if error:
                summary["error"] = error
            results[name] = summary

            if progress is not None:
                progress.update(1)

        if raw_responses:
            # Keeping the raw payload makes re-parsing possible without re-downloading.
            self.storage.write_json(
                self.storage.vector_dir / "overpass_raw.json", raw_responses
            )
            results["overpass_raw"] = {
                "path": self.storage.relative(
                    self.storage.vector_dir / "overpass_raw.json"
                ),
                "layers": sorted(raw_responses),
            }
        return results

    # -- street graph -------------------------------------------------------

    def fetch_street_graph(self, progress: Optional[Any] = None) -> Dict[str, Any]:
        """Download the routable street graph (osmnx only) + node/edge GeoJSON."""
        if progress is not None:
            progress.set_postfix_str("vector:street_graph", refresh=True)

        if self.ox is None:
            # Overpass still yields the road centrelines, just not a graph.
            outcome = self.overpass.fetch_layer(
                "roads", {"highway": True}
            )
            summary = self.storage.write_geojson(
                self.storage.vector_dir / "roads_edges.geojson",
                outcome["features"],
                extra={"source": "overpass", "note": "centrelines only; no routable graph"},
            )
            summary["source"] = "overpass"
            if outcome["error"]:
                summary["error"] = outcome["error"]
            if progress is not None:
                progress.update(1)
            return {"roads_edges": summary}

        result: Dict[str, Any] = {}
        try:
            graph = _graph_from_bbox(self.ox, self.config)
        except Exception as exc:
            if type(exc).__name__ in {"InsufficientResponseError", "EmptyOverpassResponse"}:
                LOG.info("No street network found inside the bounding box.")
                result["street_graph"] = {"error": "no street network in bbox"}
            else:
                LOG.error("Street graph download failed: %s", exc)
                result["street_graph"] = {"error": str(exc)}
            if progress is not None:
                progress.update(1)
            return result

        # GraphML keeps the topology for routing; GeoJSON keeps it inspectable.
        graphml_path = self.storage.vector_dir / "street_graph.graphml"
        try:
            self.ox.save_graphml(graph, filepath=str(graphml_path))
            result["street_graph"] = {
                "path": self.storage.relative(graphml_path),
                "nodes": graph.number_of_nodes(),
                "edges": graph.number_of_edges(),
                "network_type": self.config.network_type,
            }
        except Exception as exc:
            LOG.warning("Could not save GraphML: %s", exc)
            result["street_graph"] = {"error": f"graphml save failed: {exc}"}

        try:
            nodes, edges = self.ox.graph_to_gdfs(graph)
            result["roads_nodes"] = self.storage.write_geojson(
                self.storage.vector_dir / "roads_nodes.geojson",
                geodataframe_to_features(nodes),
                extra={"source": "osmnx"},
            )
            result["roads_edges"] = self.storage.write_geojson(
                self.storage.vector_dir / "roads_edges.geojson",
                geodataframe_to_features(edges),
                extra={"source": "osmnx", "network_type": self.config.network_type},
            )
        except Exception as exc:
            LOG.warning("Could not convert the street graph to GeoJSON: %s", exc)
            result["roads_geojson"] = {"error": str(exc)}

        if progress is not None:
            progress.update(1)
        return result

    # -- orchestration ------------------------------------------------------

    def run(self, progress: Optional[Any] = None) -> Dict[str, Any]:
        """Fetch all vector layers plus the street graph."""
        layers = self.fetch_feature_layers(progress=progress)
        layers.update(self.fetch_street_graph(progress=progress))
        return {"backend": self.backend_name, "layers": layers}

    def step_count(self) -> int:
        """Number of progress-bar units :meth:`run` will consume."""
        return len(self.config.feature_layers) + 1


def _tag_repr(value: Any) -> Any:
    """Make a tag filter value JSON-serialisable for the manifest."""
    if value is True:
        return "*"
    if isinstance(value, (list, tuple, set, frozenset)):
        return sorted(str(v) for v in value)
    return str(value)
