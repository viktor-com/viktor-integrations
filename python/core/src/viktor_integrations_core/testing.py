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


def make_fixture_transport(httpx_module: Any, *names: str) -> Any:
    """Build a fixture-replay transport for any httpx-compatible module.

    The ``openai`` SDK 3.x is built on ``httpx2``; LangChain, Pydantic AI and the OpenAI Agents SDK
    therefore need ``make_fixture_transport(httpx2, ...)`` and ``httpx2.AsyncClient(transport=...)``.
    The returned transport records requests on ``.requests`` and answers with the fixtures in order
    (the last one repeats). SSE fixtures are split mid-frame so parsers must buffer correctly.
    """
    fixtures = [load_fixture(n) for n in names]

    class _DualStream(httpx_module.SyncByteStream, httpx_module.AsyncByteStream):  # type: ignore[misc,name-defined]
        def __init__(self, chunks: list[bytes]) -> None:
            self._chunks = chunks

        def __iter__(self):  # type: ignore[no-untyped-def]
            yield from self._chunks

        async def __aiter__(self):  # type: ignore[no-untyped-def]
            for chunk in self._chunks:
                yield chunk

    class _Transport(httpx_module.MockTransport):  # type: ignore[misc,name-defined]
        def __init__(self) -> None:
            self.requests: list[dict[str, Any]] = []
            self._i = 0
            super().__init__(self._handle)

        def _handle(self, request: Any) -> Any:
            raw = request.content.decode() if request.content else ""
            try:
                body: Any = json.loads(raw) if raw else None
            except ValueError:
                body = raw
            self.requests.append(
                {"url": str(request.url), "method": request.method, "headers": dict(request.headers), "body": body}
            )
            fx = fixtures[min(self._i, len(fixtures) - 1)]["response"]
            self._i += 1
            if "sse" in fx:
                payload = "".join(f"{frame}\n\n" for frame in fx["sse"]).encode()
                cut = max(1, len(payload) // 3)
                return httpx_module.Response(
                    fx["status"], headers=fx["headers"], stream=_DualStream([payload[:cut], payload[cut:]])
                )
            return httpx_module.Response(fx["status"], headers=fx["headers"], json=fx.get("body"))

    return _Transport()


def FixtureTransport(*names: str) -> Any:  # noqa: N802 - kept as a class-like factory
    """Fixture-replay transport for ``httpx`` clients (the core's own client)."""
    return make_fixture_transport(httpx, *names)


def make_rest_script(httpx_module: Any, script: list[tuple[str, int, Any]]) -> Any:
    """Scripted transport for the native REST API: ``[("GET /api/public/v1/runs/run_1", 200, {...}), ...]``.

    Each entry answers one matching request (first match wins, then it is consumed), so a run can be
    polled through several states. Requests are recorded on ``.calls`` as ``"METHOD /path"``.
    """
    remaining = list(script)

    class _Script(httpx_module.MockTransport):  # type: ignore[misc,name-defined]
        def __init__(self) -> None:
            self.calls: list[str] = []
            super().__init__(self._handle)

        def _handle(self, request: Any) -> Any:
            key = f"{request.method} {request.url.path}"
            self.calls.append(key)
            for i, (k, status, body) in enumerate(remaining):
                if k == key:
                    del remaining[i]
                    return httpx_module.Response(status, json=body)
            raise AssertionError(f"unexpected request {key}")

    return _Script()


# A complete happy-path delegate run: create thread, poll twice, fetch result, resolve one artifact.
DELEGATE_COMPLETED_SCRIPT: list[tuple[str, int, Any]] = [
    (
        "POST /api/public/v1/threads",
        202,
        {"thread": {"id": "thr_1"}, "message": {"id": "m"}, "run": {"id": "run_1", "status": "queued"}},
    ),
    (
        "GET /api/public/v1/runs/run_1",
        200,
        {"id": "run_1", "thread_id": "thr_1", "status": "in_progress", "error": None},
    ),
    ("GET /api/public/v1/runs/run_1", 200, {"id": "run_1", "thread_id": "thr_1", "status": "completed", "error": None}),
    (
        "GET /api/public/v1/runs/run_1/result",
        200,
        {
            "run_id": "run_1",
            "status": "completed",
            "markdown": "Done.",
            "json": None,
            "artifacts": [{"id": "ftok", "display_name": "report.pdf", "content_type": "application/pdf"}],
        },
    ),
    (
        "GET /api/public/v1/files/ftok/download-url",
        200,
        {"run_id": "run_1", "url": "/api/public/v1/files/downloads/signed", "expires_at": "2026-09-20T12:00:00Z"},
    ),
]
