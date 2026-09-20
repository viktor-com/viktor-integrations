"""The narrow Viktor client the adapters depend on (ADR-0002): small enough to re-base on the Viktor SDK."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Iterator, Mapping
from typing import Any

import httpx

from .config import DEFAULT_TIMEOUT_S, VIKTOR_MODEL_ID, resolve_api_key, resolve_base_url
from .errors import (
    ViktorEmptyReplyError,
    ViktorInvalidRequestError,
    ViktorServerError,
    error_from_response,
    is_empty_assistant_message,
)
from .images import validate_chat_images
from .sse import ChatStreamAccumulator, ChatStreamResult, aiter_sse_data, iter_sse_data

logger = logging.getLogger("viktor")
CHAT_PATH = "/api/compat/v1/chat/completions"


class _Base:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_S,
        headers: Mapping[str, str] | None = None,
        strict_empty_reply: bool = False,
    ) -> None:
        self._api_key = api_key
        self.base_url = resolve_base_url(base_url)
        self._timeout = timeout
        self._headers = dict(headers or {})
        self._strict = strict_empty_reply

    def _request_headers(self, accept: str, idempotency_key: str | None) -> dict[str, str]:
        headers = {"authorization": f"Bearer {resolve_api_key(self._api_key)}", "accept": accept, **self._headers}
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key
        return headers

    @staticmethod
    def _chat_body(body: Mapping[str, Any], stream: bool) -> dict[str, Any]:
        validate_chat_images(body.get("messages") or [])
        if isinstance(body.get("n"), int) and body["n"] > 1:
            raise ViktorInvalidRequestError("Viktor always returns one choice; `n` greater than 1 is not supported.")
        out = {**body, "model": VIKTOR_MODEL_ID, "stream": stream}
        if stream:
            out["stream_options"] = {"include_usage": True, **(body.get("stream_options") or {})}
        return out

    @staticmethod
    def _raise_for_status(response: httpx.Response) -> None:
        if response.is_success:
            return
        try:
            body: Any = response.json()
        except ValueError:
            body = response.text
        raise error_from_response(response.status_code, response.headers, body)

    def _check_empty(self, data: Mapping[str, Any], request_id: str | None) -> None:
        choice = (data.get("choices") or [{}])[0]
        if choice.get("finish_reason") == "stop" and is_empty_assistant_message(choice.get("message")):
            if self._strict:
                raise ViktorEmptyReplyError(status=200, request_id=request_id, body=data)
            logger.warning("empty reply from Viktor (request %s); the stream may have ended before output", request_id)

    def _check_empty_stream(self, result: ChatStreamResult, request_id: str | None) -> None:
        if result.is_empty and result.finish_reason in ("stop", None):
            if self._strict:
                raise ViktorEmptyReplyError(status=200, request_id=request_id)
            logger.warning("stream from Viktor ended without output (request %s)", request_id)


class ViktorClient(_Base):
    """Synchronous client."""

    def __init__(self, *, http_client: httpx.Client | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._http = http_client or httpx.Client(timeout=self._timeout)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> ViktorClient:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def request(self, method: str, path: str, json: Any = None, *, idempotency_key: str | None = None) -> Any:
        try:
            response = self._http.request(
                method,
                f"{self.base_url}{path}",
                json=json,
                headers=self._request_headers("application/json", idempotency_key),
            )
        except httpx.TransportError as exc:
            raise ViktorServerError(f"Could not reach Viktor at {self.base_url}: {exc}") from exc
        self._raise_for_status(response)
        return response.json()

    def chat_completion(self, **body: Any) -> dict[str, Any]:
        try:
            response = self._http.post(
                f"{self.base_url}{CHAT_PATH}",
                json=self._chat_body(body, False),
                headers=self._request_headers("application/json", None),
            )
        except httpx.TransportError as exc:
            raise ViktorServerError(f"Could not reach Viktor at {self.base_url}: {exc}") from exc
        self._raise_for_status(response)
        data: dict[str, Any] = response.json()
        self._check_empty(data, response.headers.get("x-request-id"))
        return data

    def chat_completion_stream(self, **body: Any) -> Iterator[str | ChatStreamResult]:
        """Yield text deltas, then the final ChatStreamResult (text, tool calls, finish reason, usage)."""
        with self._http.stream(
            "POST",
            f"{self.base_url}{CHAT_PATH}",
            json=self._chat_body(body, True),
            headers=self._request_headers("text/event-stream", None),
        ) as response:
            if not response.is_success:
                response.read()
                self._raise_for_status(response)
            request_id = response.headers.get("x-request-id")
            acc = ChatStreamAccumulator(request_id)
            for data in iter_sse_data(response.iter_lines()):
                text = acc.feed(data)
                if text:
                    yield text
                if acc.done:
                    break
        self._check_empty_stream(acc.result, request_id)
        yield acc.result

    def list_models(self) -> list[dict[str, Any]]:
        models: list[dict[str, Any]] = self.request("GET", "/api/compat/v1/models")["data"]
        return models


class AsyncViktorClient(_Base):
    """Asynchronous client."""

    def __init__(self, *, http_client: httpx.AsyncClient | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._http = http_client or httpx.AsyncClient(timeout=self._timeout)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> AsyncViktorClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def request(self, method: str, path: str, json: Any = None, *, idempotency_key: str | None = None) -> Any:
        try:
            response = await self._http.request(
                method,
                f"{self.base_url}{path}",
                json=json,
                headers=self._request_headers("application/json", idempotency_key),
            )
        except httpx.TransportError as exc:
            raise ViktorServerError(f"Could not reach Viktor at {self.base_url}: {exc}") from exc
        self._raise_for_status(response)
        return response.json()

    async def chat_completion(self, **body: Any) -> dict[str, Any]:
        try:
            response = await self._http.post(
                f"{self.base_url}{CHAT_PATH}",
                json=self._chat_body(body, False),
                headers=self._request_headers("application/json", None),
            )
        except httpx.TransportError as exc:
            raise ViktorServerError(f"Could not reach Viktor at {self.base_url}: {exc}") from exc
        self._raise_for_status(response)
        data: dict[str, Any] = response.json()
        self._check_empty(data, response.headers.get("x-request-id"))
        return data

    async def chat_completion_stream(self, **body: Any) -> AsyncIterator[str | ChatStreamResult]:
        async with self._http.stream(
            "POST",
            f"{self.base_url}{CHAT_PATH}",
            json=self._chat_body(body, True),
            headers=self._request_headers("text/event-stream", None),
        ) as response:
            if not response.is_success:
                await response.aread()
                self._raise_for_status(response)
            request_id = response.headers.get("x-request-id")
            acc = ChatStreamAccumulator(request_id)
            async for data in aiter_sse_data(response.aiter_lines()):
                text = acc.feed(data)
                if text:
                    yield text
                if acc.done:
                    break
        self._check_empty_stream(acc.result, request_id)
        yield acc.result

    async def list_models(self) -> list[dict[str, Any]]:
        models: list[dict[str, Any]] = (await self.request("GET", "/api/compat/v1/models"))["data"]
        return models
