"""Viktor chat models for Pydantic AI: the upstream OpenAI models plus a thin wrapper for Viktor's diagnostics."""

from __future__ import annotations

import warnings
from collections.abc import AsyncGenerator, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, replace
from typing import Any

import viktor_integrations_core as _viktor  # core ships no py.typed yet
from openai import APIError
from pydantic_ai import RunContext
from pydantic_ai import messages as _messages
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError, UnexpectedModelBehavior, UserError
from pydantic_ai.models import Model, ModelRequestParameters, StreamedResponse
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.settings import ModelSettings

from .provider import ViktorProvider


def viktor_model(provider: ViktorProvider | None = None, *, settings: ModelSettings | None = None) -> OpenAIChatModel:
    """Viktor over Chat Completions: `OpenAIChatModel('viktor', provider=ViktorProvider())`.

    This is what `Agent('viktor:viktor')` resolves to once the provider lives in Pydantic AI. Chat Completions
    is the default wire because it sends keep-alives during Viktor's long silences.
    """
    return OpenAIChatModel(_viktor.VIKTOR_MODEL_ID, provider=provider or ViktorProvider(), settings=settings)


def viktor_responses_model(
    provider: ViktorProvider | None = None, *, settings: ModelSettings | None = None
) -> OpenAIResponsesModel:
    """Viktor over the Responses API: `OpenAIResponsesModel('viktor', provider=ViktorProvider())`.

    Viktor's response id is the durable thread id: with `OpenAIResponsesModelSettings(openai_previous_response_id=
    'auto')` plain multi-turn chat resumes the same thread instead of replaying the history into a new one.
    """
    return OpenAIResponsesModel(_viktor.VIKTOR_MODEL_ID, provider=provider or ViktorProvider(), settings=settings)


def viktor_thread_id(response: _messages.ModelResponse) -> str | None:
    """The Viktor thread behind a response: from `provider_details`, a routed tool-call id, or a Responses id."""
    known = (response.provider_details or {}).get("viktor_thread_id")
    if isinstance(known, str):
        return known
    ids = [part.tool_call_id for part in response.parts if isinstance(part, _messages.ToolCallPart)]
    found: str | None = next(filter(None, map(_viktor.thread_id_from, [*ids, response.provider_response_id])), None)
    return found


def _validate_images(messages: list[_messages.ModelMessage]) -> None:
    """Fail before the (billed) request: Viktor silently skips images it cannot use."""
    parts: list[dict[str, Any]] = []
    prompts = [p for m in messages if isinstance(m, _messages.ModelRequest) for p in m.parts]
    for prompt in prompts:
        if not isinstance(prompt, _messages.UserPromptPart) or isinstance(prompt.content, str):
            continue
        for item in prompt.content:
            if isinstance(item, _messages.ImageUrl):
                parts.append({"type": "image_url", "image_url": {"url": item.url}})
            elif isinstance(item, _messages.BinaryContent) and item.is_image:
                parts.append({"type": "image_url", "image_url": {"url": item.data_uri}})
            elif isinstance(item, (_messages.FileUrl, _messages.BinaryContent)):
                raise UserError(f"{type(item).__name__} ({item.media_type}) is not supported by Viktor.")
    try:
        _viktor.validate_chat_images([{"role": "user", "content": parts}])
    except _viktor.ViktorInvalidRequestError as e:
        raise UserError(e.message) from e


@dataclass(init=False)
class ViktorModel(WrapperModel):
    """Wraps a Viktor model (default: [`viktor_model()`][pydantic_ai_viktor.viktor_model]) with Viktor's diagnostics.

    Errors stay the ones Pydantic AI users already catch; the typed `ViktorError` is on `__cause__`:

    * HTTP errors: `ModelHTTPError` whose message is Viktor's diagnosis (fix hint, request id).
    * An error frame in the middle of a stream: `ModelAPIError` caused by `ViktorRunFailedError`.
    * An empty reply: a `UserWarning`, or with `strict_empty_reply=True` an `UnexpectedModelBehavior` caused by
      `ViktorEmptyReplyError` (instead of Pydantic AI silently asking Viktor again, which is a new billed run).
    * Images Viktor would skip (http URLs, more than 10, other MIME types) and non-image files: `UserError`.

    Non-streamed responses carry `provider_details['viktor_thread_id']` when the thread is known.
    """

    strict_empty_reply: bool

    def __init__(
        self,
        wrapped: Model | None = None,
        *,
        provider: ViktorProvider | None = None,
        strict_empty_reply: bool = False,
    ):
        if wrapped is not None and provider is not None:
            raise UserError("Cannot provide both `wrapped` and `provider`")
        super().__init__(wrapped or viktor_model(provider))
        self.strict_empty_reply = strict_empty_reply

    async def request(
        self,
        messages: list[_messages.ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> _messages.ModelResponse:
        _validate_images(messages)
        with self._map_errors():
            response = await super().request(messages, model_settings, model_request_parameters)
        self._check_empty(response)
        if thread_id := viktor_thread_id(response):
            details = {**(response.provider_details or {}), "viktor_thread_id": thread_id}
            response = replace(response, provider_details=details)
        return response

    @asynccontextmanager
    async def request_stream(
        self,
        messages: list[_messages.ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
        run_context: RunContext[Any] | None = None,
    ) -> AsyncGenerator[StreamedResponse]:
        _validate_images(messages)
        # Errors raised while the caller iterates the stream are thrown in at `yield`, so they are mapped too.
        with self._map_errors():
            async with super().request_stream(
                messages, model_settings, model_request_parameters, run_context
            ) as stream:
                yield stream
        if (response := stream.get()).state == "complete":
            self._check_empty(response)

    def _check_empty(self, response: _messages.ModelResponse) -> None:
        if response.parts or response.finish_reason not in ("stop", None):
            return
        error = _viktor.ViktorEmptyReplyError(status=200)
        if self.strict_empty_reply:
            raise UnexpectedModelBehavior(error.message) from error
        warnings.warn(f"{error.message} Pydantic AI will ask Viktor again, which starts a new run.", stacklevel=2)

    @contextmanager
    def _map_errors(self) -> Iterator[None]:
        try:
            yield
        except ModelHTTPError as e:
            # The SDK exception (on `__cause__`) still has the response headers: request id and `Retry-After`.
            error = _viktor.viktor_error_from_exception(e.__cause__ or e) or _viktor.viktor_error_from_exception(e)
            if error is None:  # pragma: no cover
                raise
            mapped = ModelHTTPError(e.status_code, e.model_name, e.body, headers=e.headers)
            request_id = f", request_id: {error.request_id}" if error.request_id else ""
            mapped.message = f"{error.message} (status_code: {e.status_code}, model_name: {e.model_name}{request_id})"
            mapped.args = (mapped.message,)
            raise mapped from error
        except APIError as e:
            # The OpenAI SDK raises a bare `APIError` for Viktor's in-stream `{"error": ...}` frame, and
            # Pydantic AI lets it through unmapped.
            message, code = _viktor.parse_error_body({"error": e.body} if isinstance(e.body, dict) else e.body)
            run_failed = _viktor.ViktorRunFailedError(message or e.message, detail_code=code, body=e.body)
            raise ModelAPIError(self.model_name, run_failed.message) from run_failed
