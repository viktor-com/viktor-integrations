"""Server-Sent Events parsing for Viktor's Chat Completions wire."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import Any

from .errors import ViktorRunFailedError, parse_error_body


def iter_sse_data(lines: Iterator[str]) -> Iterator[str]:
    """Yield ``data:`` payloads. Comment lines (``: keep-alive``) and ``retry:`` lines are dropped."""
    data: list[str] = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            if data:
                yield "\n".join(data)
                data = []
        elif line.startswith(":"):
            continue
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if data:
        yield "\n".join(data)


async def aiter_sse_data(lines: AsyncIterator[str]) -> AsyncIterator[str]:
    data: list[str] = []
    async for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            if data:
                yield "\n".join(data)
                data = []
        elif line.startswith(":"):
            continue
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if data:
        yield "\n".join(data)


@dataclass
class ToolCall:
    index: int
    id: str = ""
    name: str = ""
    arguments: str = ""


@dataclass
class ChatStreamResult:
    """Accumulated state of one Chat Completions stream."""

    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None
    response_id: str | None = None

    @property
    def is_empty(self) -> bool:
        return not self.text and not self.tool_calls


class ChatStreamAccumulator:
    """Feed ``data:`` payloads; get text deltas back and the assembled result at the end.

    Raises ViktorRunFailedError on the in-stream ``{"error":…}`` frame Viktor sends instead of a
    finish chunk when the run fails.
    """

    def __init__(self, request_id: str | None = None) -> None:
        self.result = ChatStreamResult()
        self._calls: dict[int, ToolCall] = {}
        self._request_id = request_id
        self.done = False

    def feed(self, data: str) -> str:
        if data == "[DONE]":
            self.done = True
            self.result.tool_calls = [self._calls[i] for i in sorted(self._calls)]
            return ""
        try:
            chunk = json.loads(data)
        except ValueError:
            return ""
        if isinstance(chunk.get("error"), dict):
            message, detail_code = parse_error_body(chunk)
            raise ViktorRunFailedError(
                message or "unknown error", status=200, request_id=self._request_id, detail_code=detail_code, body=chunk
            )
        if isinstance(chunk.get("id"), str):
            self.result.response_id = chunk["id"]
        if isinstance(chunk.get("usage"), dict):
            self.result.usage = chunk["usage"]
        choices = chunk.get("choices") or []
        if not choices:
            return ""
        choice = choices[0]
        delta = choice.get("delta") or {}
        text = delta.get("content") or ""
        self.result.text += text
        for raw in delta.get("tool_calls") or []:
            index = raw.get("index", 0)
            call = self._calls.setdefault(index, ToolCall(index=index))
            if raw.get("id"):
                call.id = raw["id"]
            fn = raw.get("function") or {}
            if fn.get("name"):
                call.name = fn["name"]
            call.arguments += fn.get("arguments") or ""
        if choice.get("finish_reason"):
            self.result.finish_reason = choice["finish_reason"]
        self.result.tool_calls = [self._calls[i] for i in sorted(self._calls)]
        return text
