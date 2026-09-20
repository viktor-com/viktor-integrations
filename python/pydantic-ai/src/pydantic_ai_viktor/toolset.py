"""Make Viktor a teammate of your own agent: a delegate toolset and a ready-made Viktor agent."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import viktor_integrations_core as _viktor  # core ships no py.typed yet
from pydantic_ai import Agent, FunctionToolset, ModelRetry, Tool
from pydantic_ai.models import Model

from .model import ViktorModel

VIKTOR_DELEGATE_TOOL_NAME: str = _viktor.delegate_tool_spec["name"]


class ViktorToolset(FunctionToolset[Any]):
    """A toolset with one tool, `delegate_to_viktor`, that hands a task to Viktor and waits for the result.

    It uses Viktor's native task API rather than the chat API: no 600 s cap, files come back as download URLs,
    and a `requires_action` result tells the model to answer by calling the tool again with the same `thread_id`.
    The tool name, description and JSON schema are the ones shared by every Viktor integration.
    Use it as `Agent('openai:gpt-5.2', toolsets=[ViktorToolset()])`.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        http_client: httpx.AsyncClient | None = None,
        description: str | None = None,
        poll_interval: float = 2.5,
        on_status: Callable[[str], None] | None = None,
        max_retries: int | None = None,
        id: str | None = None,
    ):
        """Build the toolset.

        Args:
            api_key: The Viktor API key; defaults to the `VIKTOR_API_KEY` environment variable. It needs the
                scopes `threads:create`, `runs:create`, `runs:read`, `messages:create`, `files:read`.
            base_url: The Viktor host; defaults to the `VIKTOR_BASE_URL` environment variable.
            http_client: An `httpx.AsyncClient` for the REST calls (the Viktor client uses `httpx`, not `httpx2`).
            description: Override the tool description shown to the model.
            poll_interval: Seconds between polls of the Viktor run.
            on_status: Called with each observed run status (`queued`, `in_progress`, ...).
            max_retries: The maximum number of retries for the tool when the model sends invalid arguments.
            id: An optional unique ID for the toolset, required for durable execution.
        """
        super().__init__(max_retries=max_retries, id=id)
        self._client_kwargs: dict[str, Any] = {"api_key": api_key, "base_url": base_url, "http_client": http_client}
        self._delegate_kwargs: dict[str, Any] = {"poll_interval": poll_interval, "on_status": on_status}
        spec = _viktor.delegate_tool_spec
        tool = Tool.from_schema(
            self._delegate, spec["name"], description or spec["description"], json_schema=spec["input_schema"]
        )
        # Not strict: strict mode would close the free-form `response_schema` object (`additionalProperties: false`).
        tool.strict = False
        self.add_tool(tool)

    async def _delegate(self, task: str | None = None, timeout_seconds: float = 600, **options: Any) -> str:
        # `Tool.from_schema` does not validate arguments against the schema, so check the one required field.
        if not isinstance(task, str) or not task.strip():
            raise ModelRetry("`task` is required: describe what Viktor should do, with all the context it needs.")
        options = {k: options.get(k) for k in ("thread_id", "response_schema", "speed")}
        client = _viktor.AsyncViktorClient(**self._client_kwargs)
        try:
            result = await _viktor.adelegate_to_viktor(
                client, task, timeout_seconds=timeout_seconds, **options, **self._delegate_kwargs
            )
        finally:
            if self._client_kwargs["http_client"] is None:
                await client.aclose()
        text: str = result.to_text()
        return text


def viktor_agent(model: Model | None = None, *, name: str = "viktor", **agent_kwargs: Any) -> Agent[None, str]:
    """An `Agent` named `viktor` that runs on `ViktorModel`, ready for agent delegation.

    Call `await viktor.run(task, usage=ctx.usage)` inside a tool of the lead agent. `Agent` arguments pass
    through; `instructions` are appended to Viktor's own identity, they never replace it.
    """
    return Agent(model or ViktorModel(), name=name, **agent_kwargs)
