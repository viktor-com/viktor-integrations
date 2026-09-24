"""Replays fixtures/live/*.json (recorded from the real Viktor API) through the Python core."""

import httpx
import pytest
from viktor_integrations_core import (
    ChatStreamResult,
    ViktorAuthError,
    ViktorClient,
    ViktorRunFailedError,
    is_routed_tool_id,
    thread_id_from,
)
from viktor_integrations_core.testing import FixtureTransport, load_fixture

MSGS = [{"role": "user", "content": "x"}]


def client(name: str) -> ViktorClient:
    return ViktorClient(
        api_key="k",
        base_url="https://viktor.test",
        http_client=httpx.Client(transport=FixtureTransport(f"live/{name}")),
    )


def test_live_text_and_stream_parse():
    assert "Hello from Viktor" in client("chat-text").chat_completion(messages=MSGS)["choices"][0]["message"]["content"]
    parts = list(client("chat-stream-text").chat_completion_stream(messages=MSGS))
    final = parts[-1]
    assert isinstance(final, ChatStreamResult) and "Hello from Viktor" in final.text
    assert final.finish_reason == "stop" and isinstance(
        final.usage["total_tokens"], int
    )  # recordings zero token counts


def test_live_tool_call_ids_are_routed_ids():
    final = list(client("chat-stream-tool-call").chat_completion_stream(messages=MSGS))[-1]
    assert is_routed_tool_id(final.tool_calls[0].id) and len(final.tool_calls[0].id) <= 64
    res = client("chat-tool-call").chat_completion(messages=MSGS)
    assert thread_id_from(res["choices"][0]["message"]["tool_calls"][0]["id"])
    assert (
        "sunny"
        in client("chat-tool-result-followup")
        .chat_completion(messages=MSGS)["choices"][0]["message"]["content"]
        .lower()
    )


def test_live_errors_401_and_opaque_html_502():
    with pytest.raises(ViktorAuthError):
        client("chat-auth-401").chat_completion(messages=MSGS)
    with pytest.raises(ViktorRunFailedError) as exc:
        client("chat-tool-choice-required").chat_completion(messages=MSGS)
    assert exc.value.detail_code == "run_failed_opaque" and not exc.value.is_retryable
    assert "<html" not in exc.value.message.lower()


def test_live_responses_id_is_the_thread_id():
    fx = load_fixture("live/responses-text")
    assert fx["response"]["body"]["id"] == fx["request"]["body"]["previous_response_id"]
    assert thread_id_from(fx["response"]["body"]["id"]) == fx["response"]["body"]["id"]
