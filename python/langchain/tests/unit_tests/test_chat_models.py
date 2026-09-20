"""ChatViktor driven through its public API against the shared fixtures."""

from __future__ import annotations

import json
import warnings

import httpx2
import openai
import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langchain_viktor import (
    ChatViktor,
    ViktorAuthError,
    ViktorEmptyReplyError,
    ViktorInvalidRequestError,
    ViktorRateLimitError,
    ViktorRunFailedError,
    ViktorServerError,
)
from viktor_integrations_core.testing import load_fixture, make_fixture_transport

ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3"
THREAD_ID = "zwKTTPTKCc9TVsSMgJuGh"
PNG = load_fixture("chat-image")["request"]["body"]["messages"][0]["content"][1]["image_url"]["url"]


@tool
def get_weather(city: str, units: str = "C") -> str:
    """Get weather"""
    return "Sunny, 24C"


def viktor(*fixtures: str, **kwargs):
    transport = make_fixture_transport(httpx2, *fixtures)
    model = ChatViktor(
        api_key=kwargs.pop("api_key", "zt_test_sk_fixture"),
        base_url="https://viktor.test",
        http_client=httpx2.Client(transport=transport),
        http_async_client=httpx2.AsyncClient(transport=transport),
        **kwargs,
    )
    return model, transport


def test_plain_reply_with_only_an_api_key_uses_bearer_auth_and_model_viktor(monkeypatch):
    monkeypatch.setenv("VIKTOR_API_KEY", "zt_test_sk_env")
    monkeypatch.delenv("VIKTOR_BASE_URL", raising=False)
    transport = make_fixture_transport(httpx2, "chat-text")
    model = ChatViktor(http_client=httpx2.Client(transport=transport))
    reply = model.invoke("Say hello in one sentence.")
    assert isinstance(reply, AIMessage) and reply.content == "Hello! I'm Viktor, ready to help."
    assert reply.response_metadata["finish_reason"] == "stop"
    assert reply.response_metadata["run_cap_reached"] is False
    assert reply.response_metadata["viktor_thread_id"] is None
    assert reply.usage_metadata and reply.usage_metadata["total_tokens"] > 0
    req = transport.requests[0]
    assert req["url"] == "https://api.viktor.com/api/compat/v1/chat/completions"
    assert req["headers"]["authorization"] == "Bearer zt_test_sk_env"
    assert req["body"]["model"] == "viktor"
    assert req["body"]["messages"] == [{"role": "user", "content": "Say hello in one sentence."}]


def test_model_is_always_viktor_and_defaults_protect_long_runs():
    model, transport = viktor("chat-text", model="gpt-4o")
    model.invoke("hi")
    assert model.model_name == "viktor" and transport.requests[0]["body"]["model"] == "viktor"
    assert model.request_timeout == 660 and model.stream_chunk_timeout == 660 and model.max_retries == 0
    assert model.root_client.max_retries == 0 and model.root_async_client.max_retries == 0
    assert model._llm_type == "viktor-chat" and model._get_ls_params()["ls_provider"] == "viktor"


def test_missing_api_key_is_a_clear_error(monkeypatch):
    monkeypatch.delenv("VIKTOR_API_KEY", raising=False)
    with pytest.raises(ValueError, match="VIKTOR_API_KEY"):
        ChatViktor()


def test_base_url_from_environment(monkeypatch):
    monkeypatch.setenv("VIKTOR_BASE_URL", "https://staging.viktor.test/")
    transport = make_fixture_transport(httpx2, "chat-text")
    ChatViktor(api_key="k", http_client=httpx2.Client(transport=transport)).invoke("hi")
    assert transport.requests[0]["url"] == "https://staging.viktor.test/api/compat/v1/chat/completions"


def test_streaming_text_never_surfaces_keepalive_comments():
    model, transport = viktor("chat-stream-text")
    chunks = list(model.stream("Say hello"))
    text = "".join(c.text for c in chunks)
    assert text and "keep-alive" not in text
    assert all(isinstance(c, AIMessageChunk) for c in chunks)
    full = chunks[0]
    for c in chunks[1:]:
        full += c
    assert full.response_metadata["finish_reason"] == "stop"
    assert full.response_metadata["run_cap_reached"] is False
    assert transport.requests[0]["body"]["stream"] is True


@pytest.mark.asyncio
async def test_async_streaming_text():
    model, _ = viktor("chat-stream-text")
    sync_text = "".join(c.text for c in viktor("chat-stream-text")[0].stream("Say hello"))
    text = "".join([c.text async for c in model.astream("Say hello")])
    assert text == sync_text and text


def test_streaming_tool_call_assembles_fragmented_args_and_keeps_routed_id():
    model, transport = viktor("chat-stream-tool-call")
    full = None
    for chunk in model.bind_tools([get_weather]).stream("weather in Berlin?"):
        full = chunk if full is None else full + chunk
    assert full is not None
    expected_args = {"city": "Berlin", "units": "metric"}
    assert full.tool_calls == [{"name": "get_weather", "args": expected_args, "id": ROUTED_ID, "type": "tool_call"}]
    assert full.response_metadata["finish_reason"] == "tool_calls"
    assert full.response_metadata["viktor_thread_id"] == THREAD_ID
    assert transport.requests[0]["body"]["tools"][0]["function"]["name"] == "get_weather"


@pytest.mark.asyncio
async def test_async_streaming_tool_call_keeps_routed_id():
    model, _ = viktor("chat-stream-tool-call")
    full = None
    async for chunk in model.bind_tools([get_weather]).astream("weather in Berlin?"):
        full = chunk if full is None else full + chunk
    assert full is not None and full.tool_calls[0]["id"] == ROUTED_ID
    assert full.response_metadata["viktor_thread_id"] == THREAD_ID


def test_tool_loop_sends_the_routed_id_back_byte_for_byte_and_redeclares_tools():
    model, transport = viktor("chat-tool-call", "chat-tool-result-followup")
    bound = model.bind_tools([get_weather])
    question = HumanMessage("weather in Berlin?")
    first = bound.invoke([question])
    assert first.tool_calls[0]["id"] == ROUTED_ID and first.tool_calls[0]["args"] == {"city": "Berlin"}
    assert first.response_metadata["viktor_thread_id"] == THREAD_ID
    result = ToolMessage(get_weather.invoke(first.tool_calls[0]["args"]), tool_call_id=first.tool_calls[0]["id"])
    final = bound.invoke([question, first, result])
    assert final.content == "It is sunny and 24C in Berlin."
    follow_up = transport.requests[1]["body"]
    assistant, tool_msg = follow_up["messages"][-2:]
    assert assistant["role"] == "assistant" and assistant["tool_calls"][0]["id"] == ROUTED_ID
    assert tool_msg == {"role": "tool", "tool_call_id": ROUTED_ID, "content": "Sunny, 24C"}
    assert follow_up["tools"] == transport.requests[0]["body"]["tools"]
    assert follow_up["tools"][0]["function"]["name"] == "get_weather"


def test_image_reaches_viktor_as_image_url():
    model, transport = viktor("chat-image")
    blocks = [
        {"type": "text", "text": "What is in this picture?"},
        {"type": "image", "base64": PNG.split(",", 1)[1], "mime_type": "image/png"},
    ]
    reply = model.invoke([HumanMessage(content=blocks)])
    assert reply.content == "A single transparent pixel."
    sent = transport.requests[0]["body"]["messages"][0]["content"]
    assert sent == load_fixture("chat-image")["request"]["body"]["messages"][0]["content"]


@pytest.mark.parametrize(
    ("part", "match"),
    [
        ({"type": "image_url", "image_url": {"url": "http://example.com/a.png"}}, "https"),
        ({"type": "image", "base64": "AAAA", "mime_type": "image/tiff"}, "image/tiff"),
        ({"type": "file", "base64": "AAAA", "mime_type": "application/pdf", "filename": "a.pdf"}, "not supported"),
    ],
)
def test_bad_images_and_files_are_rejected_before_any_request(part, match):
    model, transport = viktor("chat-image")
    with pytest.raises(ViktorInvalidRequestError, match=match):
        model.invoke([HumanMessage(content=[{"type": "text", "text": "look"}, part])])
    assert transport.requests == []


def test_more_than_ten_images_are_rejected_before_any_request():
    model, transport = viktor("chat-image")
    parts = [{"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}] * 11
    with pytest.raises(ViktorInvalidRequestError, match="at most 10"):
        model.invoke([HumanMessage(content=parts)])
    assert transport.requests == []


def test_hosted_tools_and_n_greater_than_one_are_rejected():
    model, transport = viktor("chat-text")
    with pytest.raises(ViktorInvalidRequestError, match="hosted tool"):
        model.bind_tools([{"type": "web_search_preview"}]).invoke("hi")
    with pytest.raises(ViktorInvalidRequestError, match="`n` must be 1"):
        model.invoke("hi", n=2)
    assert transport.requests == []


def test_run_failed_502_raises_viktor_error_with_the_worker_message_after_one_request():
    model, transport = viktor("chat-run-failed")
    with pytest.raises(ViktorRunFailedError, match="empty response twice in a row") as info:
        model.invoke("trigger empty")
    assert len(transport.requests) == 1
    assert info.value.status == 502 and info.value.request_id == "req_fixture_0001"
    assert isinstance(info.value.__cause__, openai.APIStatusError)


@pytest.mark.asyncio
async def test_run_failed_502_is_not_retried_async():
    model, transport = viktor("chat-run-failed")
    with pytest.raises(ViktorRunFailedError):
        await model.ainvoke("trigger empty")
    assert len(transport.requests) == 1


def test_in_stream_error_frame_raises_run_failed_instead_of_ending_silently():
    model, _ = viktor("chat-stream-run-failed")
    with pytest.raises(ViktorRunFailedError, match="empty response twice in a row") as info:
        list(model.stream("trigger empty"))
    assert info.value.detail_code == "run_failed"


@pytest.mark.asyncio
async def test_in_stream_error_frame_raises_run_failed_async():
    model, _ = viktor("chat-stream-run-failed")
    with pytest.raises(ViktorRunFailedError, match="empty response twice in a row"):
        _ = [c async for c in model.astream("trigger empty")]


def test_empty_reply_warns_by_default():
    model, _ = viktor("chat-empty-reply")
    with pytest.warns(UserWarning, match="empty reply"):
        reply = model.invoke("hello")
    assert reply.content == ""


def test_empty_reply_raises_in_strict_mode():
    model, _ = viktor("chat-empty-reply", strict_empty_reply=True)
    with pytest.raises(ViktorEmptyReplyError):
        model.invoke("hello")


def test_stream_that_ends_without_output_warns_or_raises_in_strict_mode():
    model, _ = viktor("chat-stream-ended-without-output")
    with pytest.warns(UserWarning, match="empty reply"):
        list(model.stream("hello"))
    strict, _ = viktor("chat-stream-ended-without-output", strict_empty_reply=True)
    with pytest.raises(ViktorEmptyReplyError):
        list(strict.stream("hello"))


def test_normal_replies_do_not_warn():
    model, _ = viktor("chat-text")
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        model.invoke("hello")


def test_401_is_an_auth_error_with_the_fix_hint():
    model, _ = viktor("chat-auth-401")
    with pytest.raises(ViktorAuthError, match="Check VIKTOR_API_KEY") as info:
        model.invoke("hello")
    assert info.value.status == 401 and info.value.detail_code == "invalid_api_key"


def test_403_missing_scope_names_the_scope():
    model, _ = viktor("chat-scope-403")
    with pytest.raises(ViktorAuthError, match="chat:completions") as info:
        model.invoke("hello")
    assert info.value.status == 403


def test_429_is_a_rate_limit_error_with_retry_after():
    model, transport = viktor("chat-rate-limit")
    with pytest.raises(ViktorRateLimitError) as info:
        model.invoke("hello")
    assert info.value.retry_after_seconds == 17 and info.value.detail_code == "rate_limit_exceeded"
    assert len(transport.requests) == 1


def test_with_retry_retries_rate_limits_but_a_failed_run_stays_at_one_request():
    model, transport = viktor("chat-rate-limit", "chat-text")
    retrying = model.with_retry(
        retry_if_exception_type=(ViktorRateLimitError, ViktorServerError),
        wait_exponential_jitter=False,
        stop_after_attempt=2,
    )
    assert retrying.invoke("hello").content.startswith("Hello")
    assert len(transport.requests) == 2
    failed, failed_transport = viktor("chat-run-failed")
    with pytest.raises(ViktorRunFailedError):
        failed.with_retry(retry_if_exception_type=(ViktorRateLimitError, ViktorServerError)).invoke("x")
    assert len(failed_transport.requests) == 1


def test_run_cap_reached_is_reported_with_finish_reason_length():
    model, _ = viktor("chat-timeout-length")
    reply = model.invoke("very long task")
    assert reply.response_metadata["finish_reason"] == "length"
    assert reply.response_metadata["run_cap_reached"] is True


THREAD_RESPONSE_ID = "zwKTTPTKCc9TVsSMgJuGh"


def responses_viktor(**kwargs):
    """No Responses fixtures exist yet, so answer with the documented Viktor Responses shape inline."""
    requests: list[dict] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        requests.append({"url": str(request.url), "body": json.loads(request.content)})
        text = {"type": "output_text", "text": "Hello from the same thread.", "annotations": []}
        message = {"id": "msg_1", "type": "message", "role": "assistant", "status": "completed", "content": [text]}
        usage = {
            "input_tokens": 5,
            "output_tokens": 3,
            "total_tokens": 8,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        }
        body = {
            "id": THREAD_RESPONSE_ID,
            "object": "response",
            "created_at": 1758300000,
            "status": "completed",
            "model": "viktor",
            "output": [message],
            "usage": usage,
            "tools": [],
            "tool_choice": "auto",
            "parallel_tool_calls": True,
            "error": None,
            "incomplete_details": None,
            "metadata": {},
        }
        return httpx2.Response(200, json=body)

    client = httpx2.Client(transport=httpx2.MockTransport(handle))
    model = ChatViktor(
        api_key="k", base_url="https://viktor.test", use_responses_api=True, http_client=client, **kwargs
    )
    return model, requests


def test_responses_api_reports_the_thread_id_and_continues_it_with_previous_response_id():
    model, requests = responses_viktor(use_previous_response_id=True)
    first = model.invoke("hi")
    assert first.text == "Hello from the same thread."
    assert first.response_metadata["id"] == first.response_metadata["viktor_thread_id"] == THREAD_RESPONSE_ID
    model.invoke([HumanMessage("hi"), first, HumanMessage("and again")])
    assert requests[0]["url"] == "https://viktor.test/api/compat/v1/responses"
    assert requests[1]["body"]["previous_response_id"] == THREAD_RESPONSE_ID
    assert requests[1]["body"]["model"] == "viktor"
    assert [item["content"] for item in requests[1]["body"]["input"]] == ["and again"]


def test_responses_api_validates_images_too():
    model, requests = responses_viktor()
    bad = {"type": "image_url", "image_url": {"url": "http://example.com/a.png"}}
    with pytest.raises(ViktorInvalidRequestError, match="https"):
        model.invoke([HumanMessage(content=[{"type": "text", "text": "look"}, bad])])
    assert requests == []
