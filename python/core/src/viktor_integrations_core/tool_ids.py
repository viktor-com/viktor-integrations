"""Viktor tool-call ids are routing tokens that embed the durable thread id. Never rewrite them."""

from __future__ import annotations

import re
from dataclasses import dataclass

_PATTERN = re.compile(r"^call_vk1_([A-Za-z0-9]{20,24})_([ctb])_([A-Za-z0-9_-]{1,64})$")
_THREAD_ID = re.compile(r"^[A-Za-z0-9]{20,24}$")


@dataclass(frozen=True)
class RoutedToolId:
    thread_id: str
    kind: str
    suffix: str


def parse_routed_tool_id(value: str | None) -> RoutedToolId | None:
    if not value:
        return None
    normalized = "call_" + value[6:] if value.startswith("toolu_") else value
    m = _PATTERN.fullmatch(normalized)
    return RoutedToolId(m.group(1), m.group(2), m.group(3)) if m else None


def is_routed_tool_id(value: str | None) -> bool:
    return parse_routed_tool_id(value) is not None


def thread_id_from(value: str | None) -> str | None:
    """Thread id from a routed tool-call id or a Responses API response id; ``None`` otherwise."""
    if not value:
        return None
    routed = parse_routed_tool_id(value)
    if routed:
        return routed.thread_id
    return value if _THREAD_ID.fullmatch(value) else None
