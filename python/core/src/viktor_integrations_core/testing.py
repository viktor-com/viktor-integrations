"""Replay the repo's language-neutral fixtures through httpx, so adapters are tested via their public API."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx

LIVE_SKIP_MESSAGE = (
    "LIVE CONTRACT TEST SKIPPED: set VIKTOR_API_KEY (scope chat:completions) and optionally VIKTOR_BASE_URL to run it."
)


def has_live_key() -> bool:
    return bool(os.environ.get("VIKTOR_API_KEY"))


def fixtures_dir() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "fixtures"
        if candidate.is_dir() and any(candidate.glob("*.json")):
            return candidate
    raise FileNotFoundError("fixtures/ directory not found")


def load_fixture(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((fixtures_dir() / f"{name}.json").read_text())
    return data


def list_fixtures() -> list[str]:
    return sorted(p.stem for p in fixtures_dir().glob("*.json"))


class _DualStream(httpx.SyncByteStream, httpx.AsyncByteStream):
    """A byte stream usable by both httpx.Client and httpx.AsyncClient."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    def __iter__(self):
        yield from self._chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


class FixtureTransport(httpx.MockTransport):
    """An httpx transport that answers requests with recorded fixtures, in order, and records the requests.

    Works for both ``httpx.Client`` and ``httpx.AsyncClient`` (and therefore for the ``openai`` SDK
    via ``http_client=``).
    """

    def __init__(self, *names: str) -> None:
        self._fixtures = [load_fixture(n) for n in names]
        self._i = 0
        self.requests: list[dict[str, Any]] = []
        super().__init__(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        raw = request.content.decode() if request.content else ""
        try:
            body: Any = json.loads(raw) if raw else None
        except ValueError:
            body = raw
        self.requests.append(
            {"url": str(request.url), "method": request.method, "headers": dict(request.headers), "body": body}
        )
        fx = self._fixtures[min(self._i, len(self._fixtures) - 1)]["response"]
        self._i += 1
        if "sse" in fx:
            payload = "".join(f"{frame}\n\n" for frame in fx["sse"]).encode()
            # Split mid-frame on purpose so parsers must buffer correctly.
            cut = max(1, len(payload) // 3)
            return httpx.Response(
                fx["status"], headers=fx["headers"], stream=_DualStream([payload[:cut], payload[cut:]])
            )
        return httpx.Response(fx["status"], headers=fx["headers"], json=fx.get("body"))
