"""
Shared HTTP and OpenAI helpers with retry/backoff and client-side rate limiting.
"""

import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, Optional


RETRYABLE_STATUS_CODES = {408, 409, 429, 500, 502, 503, 504}
DEFAULT_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}


class TokenBucketRateLimiter:
    """Simple token bucket rate limiter safe for multi-threaded use."""

    def __init__(self, tokens_per_second: float, burst_size: float):
        self.tokens_per_second = max(0.1, float(tokens_per_second))
        self.burst_size = max(1.0, float(burst_size))
        self.tokens = self.burst_size
        self.updated_at = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self, tokens: float = 1.0):
        """Block until enough tokens are available."""
        needed = max(0.1, float(tokens))
        while True:
            wait_time = 0.0
            with self._lock:
                now = time.monotonic()
                elapsed = max(0.0, now - self.updated_at)
                self.tokens = min(self.burst_size, self.tokens + elapsed * self.tokens_per_second)
                self.updated_at = now

                if self.tokens >= needed:
                    self.tokens -= needed
                    return

                deficit = needed - self.tokens
                wait_time = deficit / self.tokens_per_second

            time.sleep(min(max(wait_time, 0.01), 2.0))


def _parse_retry_after(retry_after: Optional[str]) -> Optional[float]:
    if not retry_after:
        return None

    retry_after = retry_after.strip()
    try:
        seconds = float(retry_after)
        return max(0.0, seconds)
    except ValueError:
        pass

    try:
        dt = parsedate_to_datetime(retry_after)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        wait = (dt - now).total_seconds()
        return max(0.0, wait)
    except Exception:
        return None


def _compute_backoff_seconds(
    attempt: int,
    retry_after_seconds: Optional[float] = None,
    base_seconds: float = 1.0,
    max_seconds: float = 60.0,
) -> float:
    backoff = min(max_seconds, base_seconds * (2 ** max(0, attempt - 1)))
    jitter = random.uniform(0.1, 0.8)
    wait = backoff + jitter
    if retry_after_seconds is not None:
        wait = max(wait, retry_after_seconds)
    return round(min(wait, max_seconds), 2)


def _load_json_response(response) -> Any:
    raw = response.read().decode("utf-8")
    return json.loads(raw)


def fetch_json_with_retries(
    url: str,
    timeout: int = 30,
    headers: Optional[Dict[str, str]] = None,
    rate_limiter: Optional[TokenBucketRateLimiter] = None,
    max_retries: int = 5,
    on_retry: Optional[Callable[[int, int, float], None]] = None,
) -> Any:
    """GET JSON URL with retries on transient errors and optional rate limiting."""
    req_headers = dict(DEFAULT_HEADERS)
    if headers:
        req_headers.update(headers)

    for attempt in range(1, max_retries + 1):
        if rate_limiter:
            rate_limiter.acquire()

        req = urllib.request.Request(url, headers=req_headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return _load_json_response(response)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            if exc.code in RETRYABLE_STATUS_CODES and attempt < max_retries:
                retry_after = _parse_retry_after(exc.headers.get("Retry-After"))
                wait = _compute_backoff_seconds(attempt, retry_after)
                if on_retry:
                    on_retry(attempt, max_retries, wait)
                time.sleep(wait)
                continue
            raise RuntimeError(f"HTTP {exc.code} for {url}: {body[:300]}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt < max_retries:
                wait = _compute_backoff_seconds(attempt)
                if on_retry:
                    on_retry(attempt, max_retries, wait)
                time.sleep(wait)
                continue
            raise RuntimeError(f"Request failed for {url}: {exc}") from exc


def _parse_json_chat_content(content: str) -> Dict[str, Any]:
    text = content.strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3:
            candidate = "\n".join(lines[1:-1]).strip()
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        parsed = json.loads(text[start : end + 1])
        if isinstance(parsed, dict):
            return parsed

    raise ValueError("OpenAI response was not a JSON object")


def call_openai_chat_text(
    messages: Any,
    model: str,
    openai_api_key: str,
    timeout: int = 120,
    payload_overrides: Optional[Dict[str, Any]] = None,
    max_retries: int = 6,
    on_retry: Optional[Callable[[int, int, float], None]] = None,
) -> str:
    """Call OpenAI chat completions and return message text."""
    if not openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    payload = {"model": model, "messages": messages}
    if payload_overrides:
        payload.update(payload_overrides)

    for attempt in range(1, max_retries + 1):
        OPENAI_RATE_LIMITER.acquire()

        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {openai_api_key}",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                result = _load_json_response(response)
                return result["choices"][0]["message"]["content"].strip()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            if exc.code in RETRYABLE_STATUS_CODES and attempt < max_retries:
                retry_after = _parse_retry_after(exc.headers.get("Retry-After"))
                wait = _compute_backoff_seconds(attempt, retry_after)
                if on_retry:
                    on_retry(attempt, max_retries, wait)
                time.sleep(wait)
                continue
            raise RuntimeError(f"OpenAI API {exc.code}: {body[:400]}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt < max_retries:
                wait = _compute_backoff_seconds(attempt)
                if on_retry:
                    on_retry(attempt, max_retries, wait)
                time.sleep(wait)
                continue
            raise RuntimeError(f"OpenAI request failed: {exc}") from exc


def call_openai_chat_json(
    messages: Any,
    model: str,
    openai_api_key: str,
    timeout: int = 120,
    payload_overrides: Optional[Dict[str, Any]] = None,
    max_retries: int = 6,
    on_retry: Optional[Callable[[int, int, float], None]] = None,
) -> Dict[str, Any]:
    """Call OpenAI chat completions and parse JSON object content."""
    content = call_openai_chat_text(
        messages=messages,
        model=model,
        openai_api_key=openai_api_key,
        timeout=timeout,
        payload_overrides=payload_overrides,
        max_retries=max_retries,
        on_retry=on_retry,
    )
    return _parse_json_chat_content(content)


OPENAI_RATE_LIMITER = TokenBucketRateLimiter(
    tokens_per_second=float(os.environ.get("OPENAI_REQS_PER_SEC", "8.0")),
    burst_size=float(os.environ.get("OPENAI_BURST_SIZE", "12")),
)

CLOB_RATE_LIMITER = TokenBucketRateLimiter(
    tokens_per_second=float(os.environ.get("CLOB_REQS_PER_SEC", "2.0")),
    burst_size=float(os.environ.get("CLOB_BURST_SIZE", "4")),
)

GAMMA_RATE_LIMITER = TokenBucketRateLimiter(
    tokens_per_second=float(os.environ.get("GAMMA_REQS_PER_SEC", "2.0")),
    burst_size=float(os.environ.get("GAMMA_BURST_SIZE", "4")),
)

