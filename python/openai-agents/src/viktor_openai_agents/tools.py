"""Viktor as a tool and as a handoff target for OpenAI Agents SDK agents."""

from __future__ import annotations

import json
from typing import Any

from agents import Agent
from agents.exceptions import ModelBehaviorError
from agents.models.interface import ModelProvider
from agents.tool import FunctionTool
from agents.tool_context import ToolContext
from viktor_integrations_core import (  # core ships no py.typed yet
    AsyncViktorClient,
    ViktorError,
    adelegate_to_viktor,
    delegate_tool_spec,
)

from .provider import ViktorProvider

VIKTOR_HANDOFF_DESCRIPTION = (
    "Viktor, an AI employee that works inside the team's tools (Slack, connected integrations, files, a code "
    "sandbox). Hand off multi-step or long-running work and anything that needs the team's systems. "
    "Viktor can take minutes."
)


def viktor_delegate_tool(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    client: AsyncViktorClient | None = None,
    poll_interval: float = 2.5,
    needs_approval: bool = False,
) -> FunctionTool:
    """A ``delegate_to_viktor`` function tool backed by Viktor's native task API (no 600 s cap, files, follow-ups).

    Give it to an agent running on any model. Name, description and parameters come from the shared Viktor
    spec. Failures are returned to the model as text, like the SDK's default tool error handling.
    """

    async def on_invoke_tool(ctx: ToolContext[Any], arguments: str) -> str:
        try:
            args = json.loads(arguments) if arguments else {}
            task = args["task"]
        except (ValueError, KeyError, TypeError) as exc:
            raise ModelBehaviorError(f"Invalid JSON input for tool delegate_to_viktor: {arguments}") from exc
        viktor = client or AsyncViktorClient(api_key=api_key, base_url=base_url)
        try:
            result = await adelegate_to_viktor(
                viktor,
                task,
                thread_id=args.get("thread_id"),
                response_schema=args.get("response_schema"),
                speed=args.get("speed"),
                timeout_seconds=args.get("timeout_seconds") or 600,
                poll_interval=poll_interval,
            )
        except ViktorError as exc:
            return f"Delegating to Viktor failed ({exc.code}): {exc.message}"
        finally:
            if client is None:
                await viktor.aclose()
        return result.to_text()

    return FunctionTool(
        name=delegate_tool_spec["name"],
        description=delegate_tool_spec["description"],
        params_json_schema=delegate_tool_spec["input_schema"],
        on_invoke_tool=on_invoke_tool,
        strict_json_schema=False,  # strict mode would rewrite the shared schema (every property required)
        needs_approval=needs_approval,
    )


def viktor_agent(
    name: str = "Viktor",
    instructions: str | None = None,
    *,
    provider: ModelProvider | None = None,
    handoff_description: str = VIKTOR_HANDOFF_DESCRIPTION,
    **agent_kwargs: Any,
) -> Agent[Any]:
    """An ``Agent`` that runs on Viktor, for ``handoffs=[viktor_agent()]`` or ``viktor_agent().as_tool(...)``.

    ``instructions`` are added to Viktor's own instructions; they do not replace its identity. Pass a
    ``ViktorProvider`` to choose the key, host or Responses wire; by default the environment is used.
    """
    model = (provider or ViktorProvider()).get_model(None)
    return Agent(
        name=name,
        instructions=instructions,
        handoff_description=handoff_description,
        model=model,
        **agent_kwargs,
    )
