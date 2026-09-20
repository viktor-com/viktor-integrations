"""Pydantic AI integration for Viktor, the AI employee. Typed errors live in `viktor_integrations_core`."""

from viktor_integrations_core import is_routed_tool_id, thread_id_from

from .model import ViktorModel, viktor_model, viktor_responses_model, viktor_thread_id
from .provider import ViktorProvider
from .toolset import VIKTOR_DELEGATE_TOOL_NAME, ViktorToolset, viktor_agent

__all__ = [
    "VIKTOR_DELEGATE_TOOL_NAME",
    "ViktorModel",
    "ViktorProvider",
    "ViktorToolset",
    "is_routed_tool_id",
    "thread_id_from",
    "viktor_agent",
    "viktor_model",
    "viktor_responses_model",
    "viktor_thread_id",
]
