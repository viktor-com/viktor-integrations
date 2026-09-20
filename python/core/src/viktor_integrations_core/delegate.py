"""Delegate a task to Viktor over the native REST API (no 600 s cap, explicit requires_action, files)."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Any
from urllib.parse import quote

from ._spec import DELEGATE_TOOL_SPEC
from .client import AsyncViktorClient, ViktorClient
from .errors import ViktorError, ViktorRateLimitError

delegate_tool_spec: dict[str, Any] = DELEGATE_TOOL_SPEC
_ACTIVE = {"queued", "in_progress", "cancellation_requested"}
_REST = "/api/public/v1"


@dataclass
class DelegateResult:
    status: str
    thread_id: str
    run_id: str
    markdown: str | None = None
    json: Any = None
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    error: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_text(self) -> str:
        """The text a model should read as the tool result."""
        lines: list[str] = []
        if self.status == "requires_action":
            lines.append(
                "Viktor needs input before it can continue. Answer by calling this tool again with the same thread_id."
            )
        if self.status == "timed_out":
            lines.append(
                "Viktor is still working. Call this tool again later with the same thread_id to ask for the result."
            )
        if self.status in ("failed", "cancelled"):
            lines.append(f"Viktor run {self.status}" + (f": {self.error['message']}" if self.error else "."))
        if self.markdown:
            lines.append(self.markdown)
        if self.json is not None:
            lines.append("```json\n" + json.dumps(self.json, indent=2) + "\n```")
        for a in self.artifacts:
            lines.append(f"File: {a['display_name']} ({a.get('content_type') or 'unknown type'}) {a['download_url']}")
        lines.append(f"(status: {self.status}, thread_id: {self.thread_id}, run_id: {self.run_id})")
        return "\n\n".join(lines)


def _create_request(task: str, thread_id: str | None, response_schema: dict[str, Any] | None, speed: str | None):
    body: dict[str, Any] = {
        "message": task,
        "response_format": (
            {"type": "json_schema", "json_schema": {"name": "result", "schema": response_schema}}
            if response_schema
            else {"type": "text"}
        ),
    }
    if speed:
        body["speed"] = speed
    path = f"{_REST}/threads/{quote(thread_id, safe='')}/messages" if thread_id else f"{_REST}/threads"
    return path, body


def _final_status(run_status: str) -> str:
    if run_status in ("completed", "requires_action", "cancelled", "timed_out"):
        return run_status
    return "failed"


def delegate_to_viktor(
    client: ViktorClient,
    task: str,
    *,
    thread_id: str | None = None,
    response_schema: dict[str, Any] | None = None,
    speed: str | None = None,
    timeout_seconds: float = 600,
    poll_interval: float = 2.5,
    idempotency_key: str | None = None,
    on_status: Callable[[str], None] | None = None,
    resolve_artifacts: bool = True,
) -> DelegateResult:
    path, body = _create_request(task, thread_id, response_schema, speed)
    created = client.request("POST", path, body, idempotency_key=idempotency_key)
    tid = thread_id or created["thread"]["id"]
    rid = created["run"]["id"]
    started = time.monotonic()
    while True:
        try:
            run = client.request("GET", f"{_REST}/runs/{quote(rid, safe='')}")
        except ViktorRateLimitError as exc:
            time.sleep(min(exc.retry_after_seconds or 5, 30))
            continue
        if on_status:
            on_status(run["status"])
        if run["status"] not in _ACTIVE:
            break
        if time.monotonic() - started >= timeout_seconds:
            return DelegateResult("timed_out", tid, rid)
        time.sleep(poll_interval)
    if run["status"] == "cancelled":
        return DelegateResult("cancelled", tid, rid, error=run.get("error"))
    try:
        result = client.request("GET", f"{_REST}/runs/{quote(rid, safe='')}/result")
    except ViktorError as exc:
        if exc.status == 409:
            error = run.get("error") or {"code": exc.detail_code or "result_not_available", "message": exc.message}
            return DelegateResult(
                _final_status(run["status"]) if run["status"] == "timed_out" else "failed", tid, rid, error=error
            )
        raise
    artifacts = []
    for a in result.get("artifacts") or []:
        url, expires = f"{client.base_url}{_REST}/files/{quote(a['id'], safe='')}/download-url", None
        if resolve_artifacts:
            try:
                dl = client.request("GET", f"{_REST}/files/{quote(a['id'], safe='')}/download-url")
                url = dl["url"] if dl["url"].startswith("http") else f"{client.base_url}{dl['url']}"
                expires = dl.get("expires_at")
            except ViktorError:
                pass
        artifacts.append(
            {
                "display_name": a.get("display_name") or a["id"],
                "content_type": a.get("content_type"),
                "download_url": url,
                "expires_at": expires,
            }
        )
    return DelegateResult(
        _final_status(run["status"]),
        tid,
        rid,
        markdown=result.get("markdown"),
        json=result.get("json"),
        artifacts=artifacts,
        error=run.get("error"),
    )


async def adelegate_to_viktor(
    client: AsyncViktorClient,
    task: str,
    *,
    thread_id: str | None = None,
    response_schema: dict[str, Any] | None = None,
    speed: str | None = None,
    timeout_seconds: float = 600,
    poll_interval: float = 2.5,
    idempotency_key: str | None = None,
    on_status: Callable[[str], None] | None = None,
    resolve_artifacts: bool = True,
) -> DelegateResult:
    path, body = _create_request(task, thread_id, response_schema, speed)
    created = await client.request("POST", path, body, idempotency_key=idempotency_key)
    tid = thread_id or created["thread"]["id"]
    rid = created["run"]["id"]
    started = time.monotonic()
    while True:
        try:
            run = await client.request("GET", f"{_REST}/runs/{quote(rid, safe='')}")
        except ViktorRateLimitError as exc:
            await asyncio.sleep(min(exc.retry_after_seconds or 5, 30))
            continue
        if on_status:
            on_status(run["status"])
        if run["status"] not in _ACTIVE:
            break
        if time.monotonic() - started >= timeout_seconds:
            return DelegateResult("timed_out", tid, rid)
        await asyncio.sleep(poll_interval)
    if run["status"] == "cancelled":
        return DelegateResult("cancelled", tid, rid, error=run.get("error"))
    try:
        result = await client.request("GET", f"{_REST}/runs/{quote(rid, safe='')}/result")
    except ViktorError as exc:
        if exc.status == 409:
            error = run.get("error") or {"code": exc.detail_code or "result_not_available", "message": exc.message}
            return DelegateResult("timed_out" if run["status"] == "timed_out" else "failed", tid, rid, error=error)
        raise
    artifacts = []
    for a in result.get("artifacts") or []:
        url, expires = f"{client.base_url}{_REST}/files/{quote(a['id'], safe='')}/download-url", None
        if resolve_artifacts:
            try:
                dl = await client.request("GET", f"{_REST}/files/{quote(a['id'], safe='')}/download-url")
                url = dl["url"] if dl["url"].startswith("http") else f"{client.base_url}{dl['url']}"
                expires = dl.get("expires_at")
            except ViktorError:
                pass
        artifacts.append(
            {
                "display_name": a.get("display_name") or a["id"],
                "content_type": a.get("content_type"),
                "download_url": url,
                "expires_at": expires,
            }
        )
    return DelegateResult(
        _final_status(run["status"]),
        tid,
        rid,
        markdown=result.get("markdown"),
        json=result.get("json"),
        artifacts=artifacts,
        error=run.get("error"),
    )
