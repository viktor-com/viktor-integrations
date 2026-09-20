"""Configuration shared by every adapter. Names match the Viktor SDK so a later swap is invisible."""

from __future__ import annotations

import os

from .errors import ViktorInvalidRequestError

DEFAULT_BASE_URL = "https://api.viktor.com"
VIKTOR_MODEL_ID = "viktor"
# Viktor caps a compat run at 600 s; stay above it so the server, not the client, ends the request.
DEFAULT_TIMEOUT_S = 660.0


def resolve_api_key(api_key: str | None = None) -> str:
    key = api_key or os.environ.get("VIKTOR_API_KEY")
    if not key:
        raise ViktorInvalidRequestError(
            "Missing Viktor API key. Pass `api_key` or set the VIKTOR_API_KEY environment variable."
        )
    return key


def resolve_base_url(base_url: str | None = None) -> str:
    return (base_url or os.environ.get("VIKTOR_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def openai_base_url(base_url: str | None = None) -> str:
    """Base URL for OpenAI-protocol clients: ``<host>/api/compat/v1``."""
    return f"{resolve_base_url(base_url)}/api/compat/v1"


def anthropic_base_url(base_url: str | None = None) -> str:
    """Base URL for Anthropic-protocol clients (they append ``/v1/messages``): ``<host>/api/compat``."""
    return f"{resolve_base_url(base_url)}/api/compat"
