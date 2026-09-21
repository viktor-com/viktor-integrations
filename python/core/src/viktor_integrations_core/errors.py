"""Viktor error taxonomy. The table of conditions lives in spec/errors.json."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


class ViktorError(Exception):
    code: str = "viktor_error"
    is_retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        request_id: str | None = None,
        detail_code: str | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.request_id = request_id
        self.detail_code = detail_code
        self.body = body


class ViktorRunFailedError(ViktorError):
    """The Viktor run failed server-side: HTTP 502 ``run_failed`` or an in-stream error frame."""

    code = "run_failed"

    def __init__(self, message: str, **kwargs: Any) -> None:
        super().__init__(f"Viktor run failed: {message}", **kwargs)


# One wording for the empty-reply condition, shared by every adapter's warning and error.
EMPTY_REPLY_MESSAGE = (
    "Viktor returned an empty reply (no text and no tool calls). The run's event stream may have ended "
    "before output was delivered. Retrying usually helps."
)


class ViktorEmptyReplyError(ViktorError):
    """HTTP 200 with no text and no tool calls (event-bus overflow, idempotent replay, or an empty answer)."""

    code = "empty_reply"
    is_retryable = True

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(EMPTY_REPLY_MESSAGE, **kwargs)


class ViktorAuthError(ViktorError):
    code = "auth"


class ViktorRateLimitError(ViktorError):
    code = "rate_limit"
    is_retryable = True

    def __init__(self, message: str, *, retry_after_seconds: float | None = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.retry_after_seconds = retry_after_seconds


class ViktorRequestTooLargeError(ViktorError):
    code = "request_too_large"


class ViktorStructuredOutputError(ViktorError):
    code = "response_format_not_satisfied"


class ViktorInvalidRequestError(ViktorError):
    code = "invalid_request"


class ViktorServerError(ViktorError):
    code = "server_error"
    is_retryable = True


_AUTH_HINTS = {
    "invalid_api_key": "Check VIKTOR_API_KEY. Keys look like zt_live_sk_… and are shown once when created.",
    "api_key_inactive": "The API key was deactivated. Create a new key in Viktor settings.",
    "api_key_expired": "The API key expired. Create a new key in Viktor settings.",
    "missing_scope": (
        "The API key lacks the scope named above. The chat model needs chat:completions; the delegate tool "
        "needs threads:create, runs:create, runs:read, messages:create and files:read."
    ),
    "identity_denied": (
        "The key's owner has no linked Slack or Teams identity, so Viktor cannot run as them. "
        "Link the account in Viktor."
    ),
    "identity_unsupported_platform": "The key owner's chat platform is not supported for API runs.",
    "compat_api_not_enabled": (
        "This Viktor environment does not serve the compatibility API."
    ),
}


def parse_error_body(body: Any) -> tuple[str | None, str | None]:
    """Return ``(message, detail_code)`` from Viktor's REST, OpenAI or Anthropic error envelopes."""
    if isinstance(body, (bytes, str)):
        try:
            body = json.loads(body)
        except (ValueError, TypeError):
            text = body.decode() if isinstance(body, bytes) else body
            return (text or None, None)
    if not isinstance(body, Mapping):
        return (None, None)
    if "detail" in body:
        detail = body["detail"]
        if isinstance(detail, str):
            return (detail, "missing_scope" if "scope required" in detail else detail)
        if isinstance(detail, list):
            msgs = [str(e.get("msg")) for e in detail if isinstance(e, Mapping) and e.get("msg")]
            return ("; ".join(msgs) or "Request validation failed", "validation_error")
        if isinstance(detail, Mapping):
            return (detail.get("message"), detail.get("error"))
    err = body.get("error")
    if isinstance(err, Mapping):
        return (err.get("message"), err.get("code") or err.get("type"))
    return (None, None)


def error_from_response(status: int, headers: Mapping[str, str] | None, body: Any) -> ViktorError:
    """Map a non-2xx Viktor response to the matching error class."""
    message, detail_code = parse_error_body(body)
    hdrs = {k.lower(): v for k, v in (headers or {}).items()}
    common: dict[str, Any] = {
        "status": status,
        "request_id": hdrs.get("x-request-id"),
        "detail_code": detail_code,
        "body": body,
    }
    message = message or f"Viktor API returned HTTP {status}"
    if status in (401, 403):
        hint = _AUTH_HINTS.get(detail_code or "")
        return ViktorAuthError(f"{message}. {hint}" if hint else message, **common)
    if status == 429:
        retry_after: float | None
        try:
            retry_after = float(hdrs["retry-after"])
        except (KeyError, ValueError):
            retry_after = None
        return ViktorRateLimitError(message, retry_after_seconds=retry_after, **common)
    if status == 413:
        return ViktorRequestTooLargeError(message, **common)
    if status == 422 and detail_code == "response_format_not_satisfied":
        return ViktorStructuredOutputError(message, **common)
    if status == 502 and detail_code == "run_failed":
        return ViktorRunFailedError(message, **common)
    if status == 502:
        # In production the CDN replaces the origin's JSON 502 body with its own HTML error page, so a failed
        # run often arrives as an opaque 502. It must still count as a failed (billed, never auto-retried) run.
        common["detail_code"] = detail_code if detail_code and len(detail_code) < 64 else "run_failed_opaque"
        common["body"] = body[:300] if isinstance(body, str) else body
        return ViktorRunFailedError(
            "HTTP 502 from Viktor. The run most likely failed; a proxy replaced Viktor's error detail. "
            "Stream the request to see Viktor's own message.",
            **common,
        )
    if status >= 500:
        return ViktorServerError(message, **common)
    return ViktorInvalidRequestError(message, **common)


def is_empty_assistant_message(message: Mapping[str, Any] | None) -> bool:
    if not message:
        return True
    return not message.get("content") and not message.get("tool_calls")


def run_failed_from_stream_frame(frame: Any, *, request_id: str | None = None) -> ViktorRunFailedError:
    """Error for Viktor's in-stream failure frame ``{"error": {...}}`` (or the bare error object SDKs surface)."""
    envelope = frame if isinstance(frame, Mapping) and "error" in frame else {"error": frame}
    message, detail_code = parse_error_body(envelope)
    return ViktorRunFailedError(
        message or "unknown error", status=200, request_id=request_id, detail_code=detail_code, body=frame
    )


def viktor_error_from_exception(exc: BaseException) -> ViktorError | None:
    """Map an exception from an SDK built on httpx (``openai``, ``anthropic``) to a ViktorError.

    Duck-typed so the core does not import those SDKs.

    * HTTP status errors (``status_code`` plus ``body``/``response``) map through ``error_from_response``.
    * The status-less API error the ``openai`` SDK raises for Viktor's in-stream ``{"error": ...}`` frame
      (``body`` holds the error object, there is no ``status_code``) maps to ViktorRunFailedError.

    Returns ``None`` for anything else (timeouts, connection errors, unrelated exceptions).
    """
    if isinstance(exc, ViktorError):
        return exc
    status = getattr(exc, "status_code", None)
    body = getattr(exc, "body", None)
    if not isinstance(status, int):
        if isinstance(body, Mapping) and (body.get("message") or body.get("code")) and hasattr(exc, "request"):
            return run_failed_from_stream_frame(body)
        return None
    response = getattr(exc, "response", None)
    headers = getattr(exc, "headers", None) or getattr(response, "headers", None)
    if isinstance(body, Mapping) and "detail" not in body and "error" not in body:
        body = {"error": body}  # the openai SDK unwraps {"error": {...}} into .body
    if body is None and response is not None:
        try:
            body = response.json()
        except Exception:  # noqa: BLE001 - any parse problem falls back to text
            body = getattr(response, "text", None)
    return error_from_response(status, headers, body)
