"""Viktor as an OpenAI Agents SDK model provider: the SDK's own OpenAI models pointed at Viktor's compat API."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Mapping
from typing import Any

import openai
from agents import set_tracing_disabled
from agents.agent_output import AgentOutputSchemaBase
from agents.exceptions import UserError
from agents.handoffs import Handoff
from agents.items import ModelResponse, TResponseInputItem, TResponseStreamEvent
from agents.model_settings import ModelSettings
from agents.models.interface import Model, ModelProvider, ModelTracing
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
from agents.models.openai_responses import OpenAIResponsesModel
from agents.retry import ModelRetryAdvice, ModelRetryAdviceRequest
from agents.run import RunConfig
from agents.tool import FunctionTool, Tool
from openai import AsyncOpenAI
from openai.types.responses.response_prompt_param import ResponsePromptParam
from viktor_integrations_core import (  # core ships no py.typed yet
    DEFAULT_TIMEOUT_S,
    VIKTOR_MODEL_ID,
    ViktorEmptyReplyError,
    ViktorError,
    ViktorRateLimitError,
    ViktorRunFailedError,
    is_empty_assistant_message,
    openai_base_url,
    parse_error_body,
    resolve_api_key,
    validate_chat_images,
    viktor_error_from_exception,
)

logger = logging.getLogger("viktor")


def _map_error(exc: Exception) -> Exception:
    """Translate an ``openai`` SDK exception into the matching ViktorError; anything else passes through."""
    mapped = viktor_error_from_exception(exc)
    if mapped is not None:
        return mapped
    body = getattr(exc, "body", None)
    if isinstance(exc, openai.APIError) and isinstance(body, Mapping):
        # An `{"error": …}` frame inside a 200 stream: the openai SDK raises a status-less APIError.
        message, code = parse_error_body({"error": body})
        return ViktorRunFailedError(message or str(exc), detail_code=code, body=body)
    return exc


def _reject_unsupported_tools(tools: list[Tool]) -> None:
    hosted = sorted({type(t).__name__ for t in tools if not isinstance(t, FunctionTool)})
    if hosted:
        raise UserError(
            f"Viktor cannot run hosted or built-in tools ({', '.join(hosted)}). Pass function tools and handoffs "
            "only; Viktor already has its own web search, code sandbox and integrations server-side."
        )


def _validate_images(input: str | list[TResponseInputItem]) -> None:
    """Run the core's image checks over Responses-shaped ``input_image`` parts before any request."""
    if isinstance(input, str):
        return
    parts: list[dict[str, Any]] = []
    for item in input:
        content = item.get("content") if isinstance(item, Mapping) else None
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, Mapping) and part.get("type") == "input_image":
                parts.append({"type": "image_url", "image_url": {"url": part.get("image_url")}})
    validate_chat_images([{"content": parts}])


def _is_empty_output(output: list[Any]) -> bool:
    text, calls = "", []
    for item in output:
        kind = getattr(item, "type", None)
        if kind == "message":
            for part in getattr(item, "content", None) or []:
                text += getattr(part, "text", "") or getattr(part, "refusal", "") or ""
        elif kind != "reasoning":
            calls.append(item)
    return is_empty_assistant_message({"content": text, "tool_calls": calls})


class ViktorModel(Model):
    """Wraps the SDK's OpenAI model with Viktor's error mapping, empty-reply detection and early input checks."""

    def __init__(self, model: Model, *, strict_empty_reply: bool = False) -> None:
        self.inner = model
        self.strict_empty_reply = strict_empty_reply

    def _check(self, input: str | list[TResponseInputItem], tools: list[Tool]) -> None:
        _reject_unsupported_tools(tools)
        _validate_images(input)

    def _on_empty(self, request_id: str | None) -> None:
        if self.strict_empty_reply:
            raise ViktorEmptyReplyError(status=200, request_id=request_id)
        logger.warning("empty reply from Viktor (request %s); the stream may have ended before output", request_id)

    async def get_response(
        self,
        system_instructions: str | None,
        input: str | list[TResponseInputItem],
        model_settings: ModelSettings,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: list[Handoff],
        tracing: ModelTracing,
        *,
        previous_response_id: str | None = None,
        conversation_id: str | None = None,
        prompt: ResponsePromptParam | None = None,
    ) -> ModelResponse:
        self._check(input, tools)
        try:
            response = await self.inner.get_response(
                system_instructions,
                input,
                model_settings,
                tools,
                output_schema,
                handoffs,
                tracing,
                previous_response_id=previous_response_id,
                conversation_id=conversation_id,
                prompt=prompt,
            )
        except Exception as exc:
            mapped = _map_error(exc)
            if mapped is exc:
                raise
            raise mapped from exc
        if _is_empty_output(response.output):
            self._on_empty(response.request_id)
        return response

    async def stream_response(
        self,
        system_instructions: str | None,
        input: str | list[TResponseInputItem],
        model_settings: ModelSettings,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: list[Handoff],
        tracing: ModelTracing,
        *,
        previous_response_id: str | None = None,
        conversation_id: str | None = None,
        prompt: ResponsePromptParam | None = None,
    ) -> AsyncIterator[TResponseStreamEvent]:
        self._check(input, tools)
        try:
            async for event in self.inner.stream_response(
                system_instructions,
                input,
                model_settings,
                tools,
                output_schema,
                handoffs,
                tracing,
                previous_response_id=previous_response_id,
                conversation_id=conversation_id,
                prompt=prompt,
            ):
                if event.type == "response.completed" and _is_empty_output(event.response.output):
                    self._on_empty(None)
                elif event.type == "response.failed":  # the Responses wire's in-stream failure shape
                    error = event.response.error
                    raise ViktorRunFailedError(
                        error.message if error else "response.failed", detail_code=error.code if error else None
                    )
                yield event
        except Exception as exc:
            mapped = _map_error(exc)
            if mapped is exc:
                raise
            raise mapped from exc

    def get_retry_advice(self, request: ModelRetryAdviceRequest) -> ModelRetryAdvice | None:
        error = request.error
        if isinstance(error, ViktorRunFailedError):
            reason = "A failed Viktor run was billed and may have acted; it is not replayed automatically."
            return ModelRetryAdvice(suggested=False, replay_safety="unsafe", reason=reason)
        if isinstance(error, ViktorRateLimitError):
            return ModelRetryAdvice(suggested=True, retry_after=error.retry_after_seconds, replay_safety="safe")
        if isinstance(error, ViktorError):
            return ModelRetryAdvice(suggested=error.is_retryable)
        return self.inner.get_retry_advice(request)

    async def close(self) -> None:
        await self.inner.close()


class ViktorProvider(ModelProvider):
    """Model provider for Viktor. Every model name resolves to Viktor (the wire model id is always ``viktor``).

    Args:
        api_key: Viktor API key. Defaults to the ``VIKTOR_API_KEY`` environment variable.
        base_url: Viktor host. Defaults to ``VIKTOR_BASE_URL`` or ``https://api.viktor.com``.
        use_responses: ``False`` (default) uses Chat Completions, the only wire that sends keep-alives while
            Viktor works silently for minutes. ``True`` uses the Responses API, where the response id is
            Viktor's durable thread id and ``previous_response_id`` keeps multi-turn continuity.
        openai_client: A ready ``AsyncOpenAI`` client. Do not combine with ``api_key`` or ``base_url``.
        strict_empty_reply: Raise ``ViktorEmptyReplyError`` on an empty reply instead of logging a warning.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        use_responses: bool = False,
        openai_client: AsyncOpenAI | None = None,
        strict_empty_reply: bool = False,
    ) -> None:
        if openai_client is not None and (api_key is not None or base_url is not None):
            raise UserError("Don't provide api_key or base_url if you provide openai_client")
        self._client = openai_client
        self._api_key = api_key
        self._base_url = base_url
        self._use_responses = use_responses
        self._strict_empty_reply = strict_empty_reply

    def _get_client(self) -> AsyncOpenAI:
        # Lazy, like OpenAIProvider: a missing key fails on first use, not on import or construction.
        if self._client is None:
            self._client = AsyncOpenAI(
                api_key=resolve_api_key(self._api_key),
                base_url=openai_base_url(self._base_url),
                timeout=DEFAULT_TIMEOUT_S,
                max_retries=0,  # a failed Viktor run was billed and may have acted: never retry blindly
            )
        return self._client

    def get_model(self, model_name: str | None = None) -> Model:
        client = self._get_client()
        inner: Model = (
            OpenAIResponsesModel(model=VIKTOR_MODEL_ID, openai_client=client)
            if self._use_responses
            else OpenAIChatCompletionsModel(model=VIKTOR_MODEL_ID, openai_client=client)
        )
        return ViktorModel(inner, strict_empty_reply=self._strict_empty_reply)


def configure_viktor(*, disable_tracing: bool = True, **provider_kwargs: Any) -> RunConfig:
    """Return a ``RunConfig`` that routes every agent in the run to Viktor.

    Tracing uploads to OpenAI with the OpenAI key; with only a Viktor key that fails noisily, so it is
    switched off unless ``disable_tracing=False`` (keep it on if you export traces with your own OpenAI key).
    """
    if disable_tracing:
        set_tracing_disabled(True)
    return RunConfig(model_provider=ViktorProvider(**provider_kwargs))
