"""Direct Overpass API client.

Used both as a standalone vector source (no heavy geospatial stack required)
and as the fallback when ``osmnx`` is unavailable. Queries use ``out geom`` so
the response already carries coordinates and no second round trip is needed to
resolve way nodes.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional, Sequence, Union

from .config import BBox, BuildConfig
from .net import HttpClient, PermanentHTTPError, TransientHTTPError

LOG = logging.getLogger(__name__)

TagFilter = Dict[str, Union[bool, str, Sequence[str]]]


# ---------------------------------------------------------------------------
# Query construction
# ---------------------------------------------------------------------------


def _escape(value: str) -> str:
    """Escape a tag value for an Overpass QL regex/equality literal."""
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def tag_filter_to_ql(tags: TagFilter) -> List[str]:
    """Translate an osmnx-style tag dict into Overpass QL tag selectors.

    ``{"building": True}``                -> ``["building"]``
    ``{"highway": ["street_lamp", ...]}`` -> ``["highway"~"^(street_lamp|...)$"]``
    """
    selectors: List[str] = []
    for key, value in tags.items():
        safe_key = _escape(key)
        if value is True:
            selectors.append(f'["{safe_key}"]')
        elif isinstance(value, str):
            selectors.append(f'["{safe_key}"="{_escape(value)}"]')
        elif isinstance(value, Iterable):
            alternatives = "|".join(_escape(v) for v in value)
            if alternatives:
                selectors.append(f'["{safe_key}"~"^({alternatives})$"]')
        else:
            raise ValueError(f"Unsupported tag filter value for {key!r}: {value!r}")
    return selectors


def build_query(
    bbox: BBox,
    tags: TagFilter,
    timeout_s: int = 180,
    element_types: Sequence[str] = ("node", "way", "relation"),
) -> str:
    """Build an Overpass QL query returning geometry for every matching tag."""
    bbox_str = bbox.as_overpass()
    statements: List[str] = []
    for selector in tag_filter_to_ql(tags):
        # One statement per element type per selector; the union is implicit.
        for element in element_types:
            statements.append(f"  {element}{selector}({bbox_str});")

    if not statements:
        raise ValueError("Tag filter produced no Overpass selectors.")

    body = "\n".join(statements)
    # 'out geom' inlines coordinates; 'qt' sorts by quadtile for fast parsing.
    return (
        f"[out:json][timeout:{timeout_s}];\n"
        f"(\n{body}\n);\n"
        "out geom tags qt;\n"
    )


# ---------------------------------------------------------------------------
# Response -> GeoJSON
# ---------------------------------------------------------------------------


def _ring_is_closed(points: List[List[float]]) -> bool:
    return len(points) >= 4 and points[0] == points[-1]


def _geometry_from_element(element: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Convert one Overpass element into a GeoJSON geometry (lon, lat order)."""
    kind = element.get("type")

    if kind == "node":
        lat, lon = element.get("lat"), element.get("lon")
        if lat is None or lon is None:
            return None
        return {"type": "Point", "coordinates": [float(lon), float(lat)]}

    if kind == "way":
        geom = element.get("geometry") or []
        coords = [
            [float(p["lon"]), float(p["lat"])]
            for p in geom
            if p and p.get("lat") is not None and p.get("lon") is not None
        ]
        if len(coords) < 2:
            return None
        if _ring_is_closed(coords):
            # Closed ways that carry an area tag are polygons (buildings etc.).
            tags = element.get("tags") or {}
            area_keys = {"building", "building:part", "landuse", "natural", "leisure", "area"}
            if area_keys & set(tags):
                return {"type": "Polygon", "coordinates": [coords]}
        return {"type": "LineString", "coordinates": coords}

    if kind == "relation":
        # Multipolygon relations are emitted as a MultiLineString of their outer
        # members; full ring assembly is deliberately out of scope here.
        parts: List[List[List[float]]] = []
        for member in element.get("members") or []:
            geom = member.get("geometry") or []
            coords = [
                [float(p["lon"]), float(p["lat"])]
                for p in geom
                if p and p.get("lat") is not None and p.get("lon") is not None
            ]
            if len(coords) >= 2:
                parts.append(coords)
        if not parts:
            return None
        return {"type": "MultiLineString", "coordinates": parts}

    return None


def elements_to_features(elements: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert an Overpass ``elements`` array into GeoJSON features."""
    features: List[Dict[str, Any]] = []
    for element in elements:
        geometry = _geometry_from_element(element)
        if geometry is None:
            continue  # untagged helper nodes, geometry-less relations
        props: Dict[str, Any] = dict(element.get("tags") or {})
        props["osm_type"] = element.get("type")
        props["osm_id"] = element.get("id")
        features.append(
            {
                "type": "Feature",
                "id": f"{element.get('type')}/{element.get('id')}",
                "geometry": geometry,
                "properties": props,
            }
        )
    return features


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class OverpassClient:
    """Thin, retry-aware Overpass wrapper built on :class:`HttpClient`."""

    def __init__(self, client: HttpClient, config: BuildConfig) -> None:
        self.client = client
        self.config = config

    def run(self, query: str) -> Dict[str, Any]:
        """POST a QL query and return the decoded JSON response."""
        LOG.debug("Overpass query:\n%s", query)
        response = self.client.post(
            self.config.overpass_endpoint,
            data=query.encode("utf-8"),
            headers={"Content-Type": "text/plain; charset=utf-8"},
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise TransientHTTPError(
                f"Overpass returned non-JSON content: {response.text[:200]!r}"
            ) from exc
        finally:
            response.close()

        remark = payload.get("remark")
        if remark and ("error" in remark.lower() or "timed out" in remark.lower()):
            # Overpass reports server-side failures in-band with HTTP 200.
            raise TransientHTTPError(f"Overpass remark: {remark}")
        return payload

    def fetch_layer(self, name: str, tags: TagFilter) -> Dict[str, Any]:
        """Fetch one named layer, returning ``{features, raw, error}``."""
        query = build_query(
            self.config.bbox, tags, timeout_s=self.config.overpass_timeout_s
        )
        try:
            payload = self.run(query)
        except (TransientHTTPError, PermanentHTTPError) as exc:
            LOG.error("Overpass layer %r failed: %s", name, exc)
            return {"features": [], "raw": None, "error": str(exc)}

        elements = payload.get("elements") or []
        features = elements_to_features(elements)
        LOG.info("Overpass layer %r: %d elements -> %d features",
                 name, len(elements), len(features))
        return {"features": features, "raw": payload, "error": None}
