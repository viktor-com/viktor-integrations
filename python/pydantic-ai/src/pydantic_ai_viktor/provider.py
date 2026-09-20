from __future__ import annotations as _annotations

import os
from typing import overload

from pydantic_ai import ModelProfile
from pydantic_ai.exceptions import UserError
from pydantic_ai.profiles.openai import OpenAIJsonSchemaTransformer, OpenAIModelProfile

try:
    from openai import AsyncOpenAI
except ImportError as _import_error:  # pragma: no cover
    raise ImportError(
        "Please install the `openai` package to use the Viktor provider, "
        'you can use the `openai` optional group — `pip install "pydantic-ai-slim[openai]"`'
    ) from _import_error
else:
    from pydantic_ai.providers._openai_compatible import AsyncHTTPClient as _OpenAIHTTPClient
    from pydantic_ai.providers._openai_compatible import OpenAICompatibleProvider as _OpenAICompatibleProvider


def _viktor_defaults(base_url: str | None) -> tuple[str, float]:
    # The only import from outside Pydantic AI. An in-tree copy inlines two constants:
    # `(base_url or os.getenv('VIKTOR_BASE_URL') or 'https://api.viktor.com').rstrip('/') + '/api/compat/v1'`
    # and `660.0` (Viktor caps a run at 600 s; the server, not the client, should end the request).
    from viktor_integrations_core import DEFAULT_TIMEOUT_S, openai_base_url

    return openai_base_url(base_url), DEFAULT_TIMEOUT_S


class ViktorProvider(_OpenAICompatibleProvider):
    """Provider for the Viktor API, the OpenAI-compatible endpoint of Viktor, the AI employee."""

    @property
    def name(self) -> str:
        return "viktor"

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def client(self) -> AsyncOpenAI:
        return self._client

    @staticmethod
    def model_profile(model_name: str) -> ModelProfile | None:
        # Viktor is an agent behind an OpenAI-compatible API (the only model id is `viktor`): it takes caller tools
        # and `json_schema`/`json_object` response formats and returns no reasoning. `strict` on function tools is
        # undocumented, so it is not sent; system prompts are appended to Viktor's own, so they are merged.
        return OpenAIModelProfile(
            json_schema_transformer=OpenAIJsonSchemaTransformer,
            supports_tools=True,
            supports_json_schema_output=True,
            supports_json_object_output=True,
            supports_thinking=False,
            openai_supports_strict_tool_definition=False,
            openai_supports_reasoning=False,
            openai_supports_encrypted_reasoning_content=False,
            openai_chat_supports_web_search=False,
            openai_chat_supports_document_input=False,
            openai_chat_supports_multiple_system_messages=False,
            openai_responses_supports_json_schema_output=True,
        )

    @overload
    def __init__(self, *, openai_client: AsyncOpenAI) -> None: ...

    @overload
    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        openai_client: None = None,
        http_client: _OpenAIHTTPClient | None = None,
    ) -> None: ...

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        openai_client: AsyncOpenAI | None = None,
        http_client: _OpenAIHTTPClient | None = None,
    ) -> None:
        """Create a new Viktor provider.

        Args:
            api_key: The API key to use for authentication, if not provided, the `VIKTOR_API_KEY` environment
                variable will be used if available.
            base_url: The Viktor host, without the `/api/compat/v1` suffix. If not provided, the
                `VIKTOR_BASE_URL` environment variable is used if available, else `https://api.viktor.com`.
            openai_client: An existing
                [`AsyncOpenAI`](https://github.com/openai/openai-python?tab=readme-ov-file#async-usage)
                client to use. If provided, `api_key`, `base_url` and `http_client` must be `None`.
            http_client: An existing `httpx2.AsyncClient` or legacy `httpx.AsyncClient` to use for making HTTP requests.
        """
        if openai_client is not None:
            if api_key is not None:
                raise UserError("Cannot provide both `openai_client` and `api_key`")
            if base_url is not None:
                raise UserError("Cannot provide both `openai_client` and `base_url`")
            if http_client is not None:
                raise UserError("Cannot provide both `openai_client` and `http_client`")
            self._client = openai_client
            self._base_url = str(openai_client.base_url).rstrip("/")
            return

        api_key = api_key or os.getenv("VIKTOR_API_KEY")
        if not api_key:
            raise UserError(
                "Set the `VIKTOR_API_KEY` environment variable or pass it via `ViktorProvider(api_key=...)`"
                " to use the Viktor provider."
            )
        self._base_url, timeout = _viktor_defaults(base_url)
        # A failed Viktor run was billed and may have acted on connected systems, so the SDK must not
        # retry it blindly (`max_retries=0`); retry policy belongs to the caller.
        self._client = AsyncOpenAI(
            base_url=self._base_url,
            api_key=api_key,
            http_client=self._get_http_client(http_client),  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
            timeout=timeout,
            max_retries=0,
        )
