"""Networking primitives: polite rate limiting and resilient HTTP retrieval.

Public OSM/Overpass/tile endpoints are donated infrastructure. Every outbound
request in this project goes through :class:`HttpClient`, which enforces a
global request rate, honours ``Retry-After`` and backs off exponentially on
transient failures instead of hammering the server.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from typing import Dict, Optional

import requests
from requests.adapters import HTTPAdapter

LOG = logging.getLogger(__name__)

# Status codes worth retrying: throttling plus the usual transient gateway set.
RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504, 509, 598, 599})


class RateLimiter:
    """Thread-safe minimum-interval limiter shared by all workers.

    A token bucket would allow short bursts; for donated endpoints a strict
    minimum spacing between requests is the friendlier behaviour.
    """

    def __init__(self, requests_per_second: float) -> None:
        if requests_per_second <= 0:
            raise ValueError("requests_per_second must be > 0.")
        self._min_interval = 1.0 / float(requests_per_second)
        self._lock = threading.Lock()
        self._next_allowed = 0.0

    def acquire(self) -> None:
        """Block until the caller is allowed to issue its request."""
        while True:
            with self._lock:
                now = time.monotonic()
                if now >= self._next_allowed:
                    # Claim this slot and reserve the following one.
                    self._next_allowed = max(now, self._next_allowed) + self._min_interval
                    return
                wait_for = self._next_allowed - now
            time.sleep(wait_for)

    def penalise(self, seconds: float) -> None:
        """Push the next allowed request into the future (used after a 429)."""
        with self._lock:
            self._next_allowed = max(self._next_allowed, time.monotonic() + seconds)


class TransientHTTPError(RuntimeError):
    """A request failed in a way that may succeed on a later run."""


class PermanentHTTPError(RuntimeError):
    """A request failed in a way that retrying cannot fix (404, 401, ...)."""


class HttpClient:
    """Small wrapper around :class:`requests.Session` with retry + throttling."""

    def __init__(
        self,
        user_agent: str,
        rate_limiter: RateLimiter,
        timeout: "tuple[float, float]" = (10.0, 60.0),
        max_retries: int = 4,
        pool_size: int = 16,
    ) -> None:
        self.timeout = timeout
        self.max_retries = max(0, int(max_retries))
        self._limiter = rate_limiter

        self.session = requests.Session()
        self.session.headers.update(
            {
                # Identifying the client is a hard requirement of the OSM
                # Foundation tile usage policy.
                "User-Agent": user_agent,
                "Accept-Encoding": "gzip, deflate",
            }
        )
        # urllib3 retries are disabled on purpose: retry policy lives in
        # :meth:`request` so we can inspect Retry-After and log each attempt.
        adapter = HTTPAdapter(
            pool_connections=pool_size, pool_maxsize=pool_size, max_retries=0
        )
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

    # -- internals ----------------------------------------------------------

    @staticmethod
    def _retry_after_seconds(response: requests.Response) -> Optional[float]:
        """Parse a ``Retry-After`` header expressed in seconds."""
        raw = response.headers.get("Retry-After")
        if not raw:
            return None
        try:
            return max(0.0, float(raw.strip()))
        except ValueError:
            # HTTP-date form; a conservative fixed pause is good enough here.
            return 30.0

    def _backoff(self, attempt: int, retry_after: Optional[float]) -> float:
        """Exponential backoff with jitter, floored by any server hint."""
        base = min(60.0, 2.0 ** attempt)
        jittered = base * (0.5 + random.random() / 2.0)
        return max(jittered, retry_after or 0.0)

    # -- public API ---------------------------------------------------------

    def request(
        self,
        method: str,
        url: str,
        *,
        params: Optional[Dict[str, object]] = None,
        data: Optional[object] = None,
        headers: Optional[Dict[str, str]] = None,
        stream: bool = False,
    ) -> requests.Response:
        """Issue a throttled request, retrying transient failures.

        Raises:
            PermanentHTTPError: non-retryable HTTP status.
            TransientHTTPError: still failing after ``max_retries`` attempts.
        """
        last_error: Optional[str] = None

        for attempt in range(self.max_retries + 1):
            self._limiter.acquire()
            try:
                response = self.session.request(
                    method.upper(),
                    url,
                    params=params,
                    data=data,
                    headers=headers,
                    timeout=self.timeout,
                    stream=stream,
                )
            except requests.exceptions.SSLError as exc:
                # A TLS handshake failure is a client/network configuration
                # problem, not a transient one: retrying it just wastes time.
                # The usual cause on macOS is the system Python being linked
                # against LibreSSL 2.8.3, which cannot negotiate with servers
                # that require modern ciphers.
                raise PermanentHTTPError(
                    f"TLS handshake with {url} failed: {exc}. "
                    "If this Python is linked against LibreSSL (check "
                    "ssl.OPENSSL_VERSION), install a build using OpenSSL "
                    "1.1.1+ (python.org, Homebrew or pyenv), or point "
                    "--overpass-endpoint at a reachable mirror."
                ) from exc
            except (requests.Timeout, requests.ConnectionError) as exc:
                # Network-level failure: always worth another attempt.
                last_error = f"{type(exc).__name__}: {exc}"
                if attempt >= self.max_retries:
                    break
                delay = self._backoff(attempt, None)
                LOG.warning(
                    "%s on %s (attempt %d/%d); retrying in %.1fs",
                    type(exc).__name__, url, attempt + 1, self.max_retries + 1, delay,
                )
                time.sleep(delay)
                continue
            except requests.RequestException as exc:
                raise PermanentHTTPError(f"Malformed request to {url}: {exc}") from exc

            if response.status_code in RETRYABLE_STATUS:
                retry_after = self._retry_after_seconds(response)
                last_error = f"HTTP {response.status_code}"
                response.close()
                if attempt >= self.max_retries:
                    break
                delay = self._backoff(attempt, retry_after)
                if response.status_code == 429:
                    # Slow the whole client down, not just this one call.
                    self._limiter.penalise(delay)
                LOG.warning(
                    "HTTP %d from %s (attempt %d/%d); retrying in %.1fs",
                    response.status_code, url, attempt + 1, self.max_retries + 1, delay,
                )
                time.sleep(delay)
                continue

            if not response.ok:
                detail = response.text[:200].replace("\n", " ") if not stream else ""
                response.close()
                raise PermanentHTTPError(
                    f"HTTP {response.status_code} from {url}. {detail}".strip()
                )

            return response

        raise TransientHTTPError(
            f"Giving up on {url} after {self.max_retries + 1} attempts ({last_error})."
        )

    def get(self, url: str, **kwargs: object) -> requests.Response:
        return self.request("GET", url, **kwargs)  # type: ignore[arg-type]

    def post(self, url: str, **kwargs: object) -> requests.Response:
        return self.request("POST", url, **kwargs)  # type: ignore[arg-type]

    def close(self) -> None:
        self.session.close()

    def __enter__(self) -> "HttpClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
