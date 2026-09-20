"""Delegate a task to Viktor from any LangChain agent."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from langchain_core.callbacks import AsyncCallbackManagerForToolRun, CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from langchain_core.tools.base import ArgsSchema
from langchain_core.utils import secret_from_env
from pydantic import BaseModel, Field, SecretStr, WithJsonSchema
from viktor_integrations_core import (  # core ships no py.typed yet
    AsyncViktorClient,
    ViktorClient,
    adelegate_to_viktor,
    delegate_to_viktor,
    delegate_tool_spec,
)

_PROPERTIES: dict[str, dict[str, Any]] = delegate_tool_spec["input_schema"]["properties"]


def _spec(name: str) -> WithJsonSchema:  # publish the shared spec's schema so every Viktor integration matches
    return WithJsonSchema(_PROPERTIES[name])


class DelegateToViktorInput(BaseModel):
    """Input for ``delegate_to_viktor``. Descriptions and limits come from ``spec/delegate-tool.json``."""

    task: Annotated[str, Field(min_length=1, max_length=100_000), _spec("task")]
    thread_id: Annotated[str | None, _spec("thread_id")] = None
    response_schema: Annotated[dict[str, Any] | None, _spec("response_schema")] = None
    speed: Annotated[Literal["faster", "smarter"] | None, _spec("speed")] = None
    timeout_seconds: Annotated[int | None, Field(ge=1, le=1800), _spec("timeout_seconds")] = None


class ViktorDelegateTool(BaseTool):
    """Hand a task to Viktor over the native REST API and wait for the result.

    Makes Viktor a teammate of your own agent: the model decides when to delegate. Unlike ``ChatViktor``
    there is no 600 s cap. The tool message holds Viktor's answer as text; the ``artifact`` is the full
    result dict (``status``, ``thread_id``, ``run_id``, ``markdown``, ``json``, ``artifacts``, ``error``).
    A ``requires_action`` result asks the calling model to call the tool again with the same ``thread_id``.
    """

    name: str = delegate_tool_spec["name"]
    description: str = delegate_tool_spec["description"]
    args_schema: ArgsSchema | None = DelegateToViktorInput
    response_format: Literal["content", "content_and_artifact"] = "content_and_artifact"

    api_key: SecretStr | None = Field(default_factory=secret_from_env("VIKTOR_API_KEY", default=None))
    """Viktor API key. Read from ``VIKTOR_API_KEY`` when not passed."""
    base_url: str | None = None
    """Viktor host. Read from ``VIKTOR_BASE_URL`` when not passed."""
    poll_interval: float = 2.5
    """Seconds between run status polls."""
    client: ViktorClient | None = Field(default=None, exclude=True)
    """Pre-built core client (tests, custom HTTP settings)."""
    async_client: AsyncViktorClient | None = Field(default=None, exclude=True)

    def _client_kwargs(self) -> dict[str, Any]:
        return {"api_key": self.api_key.get_secret_value() if self.api_key else None, "base_url": self.base_url}

    def _options(self, args: dict[str, Any]) -> dict[str, Any]:
        return {**{k: v for k, v in args.items() if v is not None}, "poll_interval": self.poll_interval}

    def _run(
        self, task: str, run_manager: CallbackManagerForToolRun | None = None, **kwargs: Any
    ) -> tuple[str, dict[str, Any]]:
        client = self.client or ViktorClient(**self._client_kwargs())
        try:
            result = delegate_to_viktor(client, task, **self._options(kwargs))
        finally:
            if client is not self.client:
                client.close()
        return result.to_text(), result.to_dict()

    async def _arun(
        self, task: str, run_manager: AsyncCallbackManagerForToolRun | None = None, **kwargs: Any
    ) -> tuple[str, dict[str, Any]]:
        client = self.async_client or AsyncViktorClient(**self._client_kwargs())
        try:
            result = await adelegate_to_viktor(client, task, **self._options(kwargs))
        finally:
            if client is not self.async_client:
                await client.aclose()
        return result.to_text(), result.to_dict()
