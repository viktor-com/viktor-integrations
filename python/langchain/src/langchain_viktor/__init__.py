"""LangChain integration for Viktor, the AI employee.

The LangGraph helpers live in ``langchain_viktor.agents`` so that ``langgraph`` stays an optional dependency.
"""

from viktor_integrations_core import (  # type: ignore[import-untyped]  # core ships no py.typed yet
    ViktorAuthError,
    ViktorEmptyReplyError,
    ViktorError,
    ViktorInvalidRequestError,
    ViktorRateLimitError,
    ViktorRunFailedError,
    ViktorServerError,
)

from langchain_viktor.chat_models import ChatViktor
from langchain_viktor.tools import DelegateToViktorInput, ViktorDelegateTool

__all__ = [
    "ChatViktor",
    "DelegateToViktorInput",
    "ViktorAuthError",
    "ViktorDelegateTool",
    "ViktorEmptyReplyError",
    "ViktorError",
    "ViktorInvalidRequestError",
    "ViktorRateLimitError",
    "ViktorRunFailedError",
    "ViktorServerError",
]
