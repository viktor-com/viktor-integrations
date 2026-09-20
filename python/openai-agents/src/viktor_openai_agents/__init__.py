"""OpenAI Agents SDK integration for Viktor, the AI employee."""

from viktor_integrations_core import (  # core ships no py.typed yet
    ViktorAuthError,
    ViktorEmptyReplyError,
    ViktorError,
    ViktorRateLimitError,
    ViktorRunFailedError,
    thread_id_from,
)

from .provider import ViktorModel, ViktorProvider, configure_viktor
from .tools import VIKTOR_HANDOFF_DESCRIPTION, viktor_agent, viktor_delegate_tool

__all__ = [
    "VIKTOR_HANDOFF_DESCRIPTION",
    "ViktorAuthError",
    "ViktorEmptyReplyError",
    "ViktorError",
    "ViktorModel",
    "ViktorProvider",
    "ViktorRateLimitError",
    "ViktorRunFailedError",
    "configure_viktor",
    "thread_id_from",
    "viktor_agent",
    "viktor_delegate_tool",
]
