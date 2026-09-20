"""Viktor chat model."""

from __future__ import annotations

import logging
import warnings
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from typing import Any

import openai
import viktor_integrations_core as vk  # core ships no py.typed yet
from langchain_core.language_models import LangSmithParams, LanguageModelInput
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_core.utils import from_env, secret_from_env
from langchain_openai.chat_models.base import BaseChatOpenAI
from pydantic import ConfigDict, Field, SecretStr, model_validator
from typing_extensions import Self

logger = logging.getLogger(__name__)

EMPTY_REPLY_WARNING = (
    "Viktor returned an empty reply (no text and no tool calls). The run's event stream may have "
    "ended before output was delivered. Retrying usually helps."
)
_FILE_PART_TYPES = {"file", "input_file", "input_audio"}
_RESPONSES_FINISH = {"completed": "stop", "incomplete": "length"}


@contextmanager
def _viktor_errors() -> Iterator[None]:
    """Re-raise ``openai`` SDK errors as the typed ``ViktorError``, chained from the original."""
    try:
        yield
    except openai.APIStatusError as exc:
        raise vk.viktor_error_from_exception(exc) or exc from exc
    except openai.APIError as exc:
        if type(exc) is not openai.APIError:  # connection errors and timeouts stay as they are
            raise
        # The openai SDK raises a bare APIError for Viktor's in-stream `{"error": …}` frame.
        message, code = vk.parse_error_body({"error": exc.body})
        raise vk.ViktorRunFailedError(message or exc.message, status=200, detail_code=code, body=exc.body) from exc


def _check_payload(payload: dict[str, Any]) -> None:
    """Fail early on input Viktor would silently ignore: bad images, files, hosted tools, ``n > 1``."""
    chat_shaped: list[dict[str, Any]] = []
    for item in payload.get("messages") or payload.get("input") or []:
        content = item.get("content") if isinstance(item, dict) else None
        parts = [p for p in content if isinstance(p, dict)] if isinstance(content, list) else []
        for part in parts:
            if part.get("type") in _FILE_PART_TYPES:
                raise vk.ViktorInvalidRequestError(
                    f'A "{part["type"]}" content part is not supported by Viktor: the chat API accepts text and '
                    "images only. Send the file's text, or delegate the task with ViktorDelegateTool."
                )
        # The Responses wire calls the part `input_image`; the core validates the Chat Completions shape.
        chat_shaped.append(
            {"content": [{**p, "type": "image_url"} if p.get("type") == "input_image" else p for p in parts]}
        )
    vk.validate_chat_images(chat_shaped)
    for tool in payload.get("tools") or []:
        if isinstance(tool, dict) and tool.get("type") != "function":
            raise vk.ViktorInvalidRequestError(f'Viktor cannot run the hosted tool "{tool.get("type")}".')
    if (payload.get("n") or 1) > 1:
        raise vk.ViktorInvalidRequestError("Viktor returns exactly one choice; `n` must be 1.")


class ChatViktor(BaseChatOpenAI):
    """Viktor, the AI employee, as a LangChain chat model.

    Instantiate (``pip install langchain-viktor``, key from ``VIKTOR_API_KEY``):
        .. code-block:: python

            model = ChatViktor()  # api_key=..., base_url=..., timeout=..., strict_empty_reply=...

    A Viktor turn is an agent run: it can take minutes and may act on the team's connected
    integrations. Tool-call ids are routing tokens that resume the Viktor thread; they pass through unchanged.

    ``max_retries`` defaults to ``0``: the ``openai`` SDK retries every 5xx, and a failed Viktor run
    (HTTP 502 ``run_failed``) was billed and may have acted, so it must never be retried blindly. Retry the rest
    with ``model.with_retry(retry_if_exception_type=(ViktorRateLimitError, ViktorServerError))``.

    ``use_responses_api=True`` switches to Viktor's Responses wire, where ``response_metadata["id"]`` is the
    Viktor thread id; add ``use_previous_response_id=True`` and it is sent back as ``previous_response_id``, so
    multi-turn chat continues the same thread instead of replaying history into a new one.
    """

    model_name: str = Field(default=vk.VIKTOR_MODEL_ID, alias="model")
    """Always ``viktor``; any other value is replaced."""
    viktor_api_key: SecretStr | None = Field(
        alias="api_key", default_factory=secret_from_env("VIKTOR_API_KEY", default=None)
    )
    """Viktor API key. Read from ``VIKTOR_API_KEY`` when not passed."""
    viktor_api_base: str = Field(
        alias="base_url", default_factory=from_env("VIKTOR_BASE_URL", default=vk.DEFAULT_BASE_URL)
    )
    """Viktor host, without the ``/api/compat/v1`` path. Read from ``VIKTOR_BASE_URL`` when not passed."""
    request_timeout: Any = Field(default=vk.DEFAULT_TIMEOUT_S, alias="timeout")
    """Request timeout in seconds. Default 660, above Viktor's 600 s run cap."""
    stream_chunk_timeout: float | None = Field(default=vk.DEFAULT_TIMEOUT_S, exclude=True)
    """Gap allowed between async stream chunks (base default 120 s). Viktor is silent while it runs its own tools."""
    max_retries: int | None = 0
    """SDK-level retries. Default 0 so a failed Viktor run is never retried (see class docs)."""
    strict_empty_reply: bool = False
    """Raise ``ViktorEmptyReplyError`` on an empty 200 reply instead of warning."""
    openai_api_key: Any = None  # the base class aliases `api_key` / `base_url` to these; ChatViktor owns them
    openai_api_base: str | None = None

    model_config = ConfigDict(populate_by_name=True)

    @property
    def _llm_type(self) -> str:
        return "viktor-chat"

    @property
    def lc_secrets(self) -> dict[str, str]:
        return {"viktor_api_key": "VIKTOR_API_KEY"}

    def _get_ls_params(self, stop: list[str] | None = None, **kwargs: Any) -> LangSmithParams:
        params = super()._get_ls_params(stop=stop, **kwargs)
        params["ls_provider"] = "viktor"
        return params

    @model_validator(mode="after")
    def validate_environment(self) -> Self:
        """Build the ``openai`` clients against ``<host>/api/compat/v1``."""
        self.model_name = vk.VIKTOR_MODEL_ID
        if not (self.viktor_api_key and self.viktor_api_key.get_secret_value()):
            raise ValueError("Missing Viktor API key. Pass `api_key` or set the VIKTOR_API_KEY environment variable.")
        params: dict[str, Any] = {
            "api_key": self.viktor_api_key.get_secret_value(),
            "base_url": vk.openai_base_url(self.viktor_api_base),
            "timeout": self.request_timeout,
            "max_retries": self.max_retries or 0,
            "default_headers": self.default_headers,
            "default_query": self.default_query,
        }
        if not self.client:
            self.root_client = openai.OpenAI(**params, http_client=self.http_client)
            self.client = self.root_client.chat.completions
        if not self.async_client:
            self.root_async_client = openai.AsyncOpenAI(**params, http_client=self.http_async_client)
            self.async_client = self.root_async_client.chat.completions
        return self

    def _get_request_payload(
        self, input_: LanguageModelInput, *, stop: list[str] | None = None, **kwargs: Any
    ) -> dict[str, Any]:
        messages = self._convert_input(input_).to_messages()
        if self.use_previous_response_id and self._use_responses_api(kwargs) and "previous_response_id" not in kwargs:
            # Viktor's Responses id is the bare thread id; the base class only recognises a `resp_` prefix.
            for i in range(len(messages) - 1, -1, -1):
                thread_id = vk.thread_id_from(messages[i].response_metadata.get("id"))
                if isinstance(messages[i], AIMessage) and thread_id:
                    kwargs["previous_response_id"], messages = thread_id, messages[i + 1 :]
                    break
        payload: dict[str, Any] = super()._get_request_payload(messages, stop=stop, **kwargs)
        payload["model"] = vk.VIKTOR_MODEL_ID
        _check_payload(payload)
        return payload

    def _annotate(self, message: BaseMessage, generation_info: dict[str, Any] | None, has_output: bool) -> bool:
        """On the final message or chunk: apply the empty-reply policy and add Viktor metadata."""
        status = message.response_metadata.get("status")  # Responses API
        finish = (generation_info or {}).get("finish_reason") or _RESPONSES_FINISH.get(status or "")
        if finish is None:
            return False
        if not has_output and finish == "stop":
            if self.strict_empty_reply:
                raise vk.ViktorEmptyReplyError(status=200)
            warnings.warn(EMPTY_REPLY_WARNING, stacklevel=2)
            logger.warning(EMPTY_REPLY_WARNING)
        ids = [tc.get("id") for tc in getattr(message, "tool_calls", None) or []]
        ids.append(message.response_metadata.get("id"))
        message.response_metadata["viktor_thread_id"] = next((t for t in map(vk.thread_id_from, ids) if t), None)
        message.response_metadata["run_cap_reached"] = finish == "length"
        return True

    def _annotate_result(self, result: ChatResult) -> ChatResult:
        for gen in result.generations:
            has_output = bool(gen.text) or bool(getattr(gen.message, "tool_calls", None))
            self._annotate(gen.message, gen.generation_info, has_output)
        return result

    def _observe(self, chunk: ChatGenerationChunk, state: dict[str, Any]) -> ChatGenerationChunk:
        """Track output and the routed tool-call id across chunks; annotate the final chunk."""
        for tool_call in getattr(chunk.message, "tool_call_chunks", None) or []:
            state["id"] = state.get("id") or tool_call.get("id")
        state["output"] = state.get("output") or bool(chunk.text) or "id" in state
        if self._annotate(chunk.message, chunk.generation_info, state["output"]) and state.get("id"):
            chunk.message.response_metadata["viktor_thread_id"] = vk.thread_id_from(state["id"])
        return chunk

    def _generate(self, *args: Any, **kwargs: Any) -> ChatResult:
        with _viktor_errors():
            return self._annotate_result(super()._generate(*args, **kwargs))

    async def _agenerate(self, *args: Any, **kwargs: Any) -> ChatResult:
        with _viktor_errors():
            return self._annotate_result(await super()._agenerate(*args, **kwargs))

    def _stream(self, *args: Any, **kwargs: Any) -> Iterator[ChatGenerationChunk]:
        use_responses = self._use_responses_api({**kwargs, **self.model_kwargs})
        inner = super()._stream_responses(*args, **kwargs) if use_responses else super()._stream(*args, **kwargs)
        state: dict[str, Any] = {}
        with _viktor_errors():
            for chunk in inner:
                yield self._observe(chunk, state)

    async def _astream(self, *args: Any, **kwargs: Any) -> AsyncIterator[ChatGenerationChunk]:
        use_responses = self._use_responses_api({**kwargs, **self.model_kwargs})
        inner = super()._astream_responses(*args, **kwargs) if use_responses else super()._astream(*args, **kwargs)
        state: dict[str, Any] = {}
        with _viktor_errors():
            async for chunk in inner:
                yield self._observe(chunk, state)
