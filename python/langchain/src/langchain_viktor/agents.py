"""LangGraph helpers: Viktor as an agent node and as a handoff target. Needs ``langchain`` and ``langgraph``."""

# No `from __future__ import annotations`: the tool decorator resolves `ToolRuntime` from the real annotation.
from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import BaseTool, tool

from langchain_viktor.chat_models import ChatViktor

try:
    from langchain.agents import create_agent
    from langgraph.prebuilt import ToolRuntime
    from langgraph.types import Command
except ImportError as exc:  # pragma: no cover - only without the optional dependencies
    raise ImportError(
        "langchain_viktor.agents needs the optional dependencies: pip install langchain langgraph"
    ) from exc

HANDOFF_DESCRIPTION = (
    "Hand the conversation over to Viktor, an AI employee that works inside the team's tools (Slack, "
    "integrations, files, code sandbox). Use it when the request needs the team's connected systems or "
    "multi-step work. Viktor may take minutes."
)


def create_viktor_agent(
    tools: Sequence[BaseTool | Callable[..., Any] | dict[str, Any]] | None = None,
    *,
    model: ChatViktor | None = None,
    name: str = "viktor",
    **kwargs: Any,
) -> Any:
    """``langchain.agents.create_agent`` with Viktor as the model.

    ``tools`` run on your side; Viktor keeps its own server-side tools. Other keyword arguments
    (``system_prompt``, ``middleware``, ``checkpointer``, …) go to ``create_agent``.
    """
    return create_agent(model=model or ChatViktor(), tools=tools, name=name, **kwargs)


def create_viktor_handoff_tool(
    *, agent_name: str = "viktor", name: str | None = None, description: str | None = None, **update: Any
) -> BaseTool:
    """A tool that returns ``Command(goto=agent_name, graph=Command.PARENT, update=...)``.

    The update carries the calling agent's last ``AIMessage`` and the matching ``ToolMessage`` so the parent
    history stays valid, plus any extra keyword arguments (for example ``active_agent="viktor"``).
    """
    tool_name = name or f"transfer_to_{agent_name}"

    @tool(tool_name, description=description or HANDOFF_DESCRIPTION)
    def handoff(runtime: ToolRuntime) -> Command:  # type: ignore[type-arg]
        messages = runtime.state["messages"] if "messages" in runtime.state else []
        last_ai = [m for m in messages if isinstance(m, AIMessage)][-1:]
        transfer = ToolMessage(f"Transferred to {agent_name}.", name=tool_name, tool_call_id=runtime.tool_call_id)
        return Command(goto=agent_name, graph=Command.PARENT, update={**update, "messages": [*last_ai, transfer]})

    return handoff
