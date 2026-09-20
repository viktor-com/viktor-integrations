"""Every row of docs/adapter-guide.md's test matrix, driven through Runner.run / Runner.run_streamed."""

import json
import logging
import os

import httpx2
import pytest
from agents import Agent, CodeInterpreterTool, Runner, WebSearchTool, function_tool, set_tracing_disabled
from agents.exceptions import UserError
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
from agents.models.openai_responses import OpenAIResponsesModel
from agents.retry import ModelRetryAdviceRequest, ModelRetrySettings, retry_policies
from agents.testing import ScriptedModel, assistant_message, function_call
from openai import AsyncOpenAI
from openai.types.responses import ResponseTextDeltaEvent
from viktor_integrations_core import (
    ViktorAuthError,
    ViktorEmptyReplyError,
    ViktorInvalidRequestError,
    ViktorRateLimitError,
    ViktorRunFailedError,
    thread_id_from,
)
from viktor_integrations_core.testing import LIVE_SKIP_MESSAGE, has_live_key, load_fixture, make_fixture_transport
from viktor_openai_agents import ViktorModel, ViktorProvider, configure_viktor, viktor_agent

set_tracing_disabled(True)
ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3"


def provider(*fixtures: str, **kwargs):
    transport = make_fixture_transport(httpx2, *fixtures)
    client = AsyncOpenAI(
        api_key="zt_test_sk_fixture",
        base_url="https://viktor.test/api/compat/v1",
        max_retries=0,
        http_client=httpx2.AsyncClient(transport=transport),
    )
    return ViktorProvider(openai_client=client, **kwargs), transport


def agent(*fixtures: str, tools=(), **kwargs):
    p, t = provider(*fixtures, **kwargs)
    return Agent(name="Assistant", model=p.get_model("gpt-4o"), tools=list(tools)), t


@function_tool
def get_weather(city: str) -> str:
    """Get weather"""
    return "Sunny, 24C"


async def test_plain_reply_bearer_auth_and_model_forced_to_viktor():
    a, t = agent("chat-text")
    result = await Runner.run(a, "hi")
    assert "Viktor" in result.final_output
    req = t.requests[0]
    assert req["url"] == "https://viktor.test/api/compat/v1/chat/completions"
    assert req["headers"]["authorization"] == "Bearer zt_test_sk_fixture"
    assert req["body"]["model"] == "viktor"


async def test_api_key_only_builds_viktor_client_without_retries(monkeypatch):
    monkeypatch.setenv("VIKTOR_API_KEY", "zt_test_sk_env")
    monkeypatch.setenv("VIKTOR_BASE_URL", "https://staging.viktor.test/")
    model = ViktorProvider().get_model("anything")
    assert isinstance(model, ViktorModel) and isinstance(model.inner, OpenAIChatCompletionsModel)
    client = model.inner._client
    assert str(client.base_url) == "https://staging.viktor.test/api/compat/v1/"
    assert client.api_key == "zt_test_sk_env" and client.max_retries == 0 and client.timeout == 660
    monkeypatch.delenv("VIKTOR_API_KEY")
    with pytest.raises(ViktorInvalidRequestError, match="VIKTOR_API_KEY"):
        ViktorProvider().get_model(None)
    with pytest.raises(UserError, match="openai_client"):
        ViktorProvider(api_key="k", openai_client=client)


async def test_run_config_provider_routes_string_model_names_to_viktor():
    p, t = provider("chat-text")
    config = configure_viktor()
    config.model_provider = p
    result = await Runner.run(Agent(name="Assistant", model="gpt-5"), "hi", run_config=config)
    assert "Viktor" in result.final_output and t.requests[0]["body"]["model"] == "viktor"


async def test_streaming_text_without_keepalives():
    a, t = agent("chat-stream-text")
    result = Runner.run_streamed(a, "hi")
    deltas = [
        e.data.delta
        async for e in result.stream_events()
        if e.type == "raw_response_event" and isinstance(e.data, ResponseTextDeltaEvent)
    ]
    assert "".join(deltas) == "Hello from Viktor." == result.final_output
    assert not any("keep-alive" in d for d in deltas)
    assert t.requests[0]["body"]["stream"] is True and t.requests[0]["body"]["model"] == "viktor"
    assert result.context_wrapper.usage.total_tokens == 843


async def test_streaming_tool_call_assembles_fragments_and_keeps_routed_id():
    a, t = agent("chat-stream-tool-call", "chat-stream-text", tools=[get_weather])
    result = Runner.run_streamed(a, "weather in Berlin?")
    calls = [
        e.item.raw_item
        async for e in result.stream_events()
        if e.type == "run_item_stream_event" and e.name == "tool_called"
    ]
    assert calls[0].call_id == ROUTED_ID and thread_id_from(calls[0].call_id) == "zwKTTPTKCc9TVsSMgJuGh"
    assert json.loads(calls[0].arguments) == {"city": "Berlin", "units": "metric"}
    assert result.final_output == "Hello from Viktor."
    follow_up = t.requests[1]["body"]
    assert follow_up["messages"][-1]["tool_call_id"] == ROUTED_ID and follow_up["tools"]


async def test_tool_loop_returns_routed_id_byte_for_byte_and_redeclares_tools():
    a, t = agent("chat-tool-call", "chat-tool-result-followup", tools=[get_weather])
    result = await Runner.run(a, "weather in Berlin?")
    assert result.final_output == "It is sunny and 24C in Berlin."
    first, second = (r["body"] for r in t.requests)
    assistant, tool = second["messages"][-2:]
    assert assistant["role"] == "assistant" and assistant["tool_calls"][0]["id"] == ROUTED_ID
    assert tool == {"role": "tool", "tool_call_id": ROUTED_ID, "content": "Sunny, 24C"}
    assert second["tools"] == first["tools"] and second["tools"][0]["function"]["name"] == "get_weather"
    assert second["model"] == "viktor"


async def test_image_input_reaches_viktor_as_image_url_and_bad_images_fail_early():
    url = load_fixture("chat-image")["request"]["body"]["messages"][0]["content"][1]["image_url"]["url"]

    def message(*urls):
        images = [{"type": "input_image", "image_url": u, "detail": "auto"} for u in urls]
        return [{"role": "user", "content": [{"type": "input_text", "text": "What is in this picture?"}, *images]}]

    a, t = agent("chat-image")
    result = await Runner.run(a, message(url))
    assert result.final_output == "A single transparent pixel."
    part = t.requests[0]["body"]["messages"][-1]["content"][1]
    assert part["type"] == "image_url" and part["image_url"]["url"] == url
    for bad, match in [
        (["http://example.com/a.png"], "https"),
        (["data:image/tiff;base64,AAAA"], "image/tiff"),
        (["https://example.com/a.png"] * 11, "at most 10"),
    ]:
        with pytest.raises(ViktorInvalidRequestError, match=match):
            await Runner.run(a, message(*bad))
    assert len(t.requests) == 1


async def test_502_run_failed_is_a_viktor_error_and_is_not_retried():
    a, t = agent("chat-run-failed", "chat-text")
    a.model_settings.retry = ModelRetrySettings(max_retries=3, policy=retry_policies.provider_suggested())
    with pytest.raises(ViktorRunFailedError, match="empty response twice") as exc:
        await Runner.run(a, "trigger empty")
    assert exc.value.status == 502 and exc.value.request_id == "req_fixture_0001"
    assert exc.value.__cause__.__class__.__name__ == "InternalServerError"  # the openai error stays chained
    assert len(t.requests) == 1
    advice = a.model.get_retry_advice(ModelRetryAdviceRequest(error=exc.value, attempt=1, stream=False))
    assert advice.suggested is False and advice.replay_safety == "unsafe"


async def test_in_stream_error_frame_raises_run_failed():
    a, t = agent("chat-stream-run-failed")
    result = Runner.run_streamed(a, "trigger empty")
    with pytest.raises(ViktorRunFailedError, match="empty response twice") as exc:
        async for _ in result.stream_events():
            pass
    assert exc.value.detail_code == "run_failed" and len(t.requests) == 1


@pytest.mark.parametrize("fixture", ["chat-empty-reply", "chat-stream-ended-without-output"])
async def test_empty_reply_warns_by_default_and_raises_in_strict_mode(fixture, caplog):
    streamed = "stream" in fixture

    async def run(a):
        if not streamed:
            return await Runner.run(a, "hello")
        result = Runner.run_streamed(a, "hello")
        async for _ in result.stream_events():
            pass
        return result

    a, _ = agent(fixture)
    with caplog.at_level(logging.WARNING, logger="viktor"):
        result = await run(a)
    assert not result.final_output and "empty reply from Viktor" in caplog.text
    strict, _ = agent(fixture, strict_empty_reply=True)
    with pytest.raises(ViktorEmptyReplyError):
        await run(strict)


async def test_401_is_auth_error_with_hint_and_429_carries_retry_after():
    a, _ = agent("chat-auth-401")
    with pytest.raises(ViktorAuthError, match="VIKTOR_API_KEY") as auth:
        await Runner.run(a, "hello")
    assert auth.value.detail_code == "invalid_api_key"
    a, _ = agent("chat-rate-limit")
    with pytest.raises(ViktorRateLimitError) as limited:
        await Runner.run(a, "hello")
    assert limited.value.retry_after_seconds == 17
    advice = a.model.get_retry_advice(ModelRetryAdviceRequest(error=limited.value, attempt=1, stream=False))
    assert advice.suggested is True and advice.retry_after == 17


async def test_rate_limit_is_retried_when_the_caller_opts_in():
    a, t = agent("chat-rate-limit", "chat-text")
    a.model_settings.retry = ModelRetrySettings(
        max_retries=1, policy=retry_policies.provider_suggested(), backoff={"initial_delay": 0, "jitter": False}
    )
    original = ViktorModel.get_retry_advice

    def no_wait(self, request):
        advice = original(self, request)
        advice.retry_after = 0
        return advice

    ViktorModel.get_retry_advice = no_wait
    try:
        result = await Runner.run(a, "hello")
    finally:
        ViktorModel.get_retry_advice = original
    assert "Viktor" in result.final_output and len(t.requests) == 2


async def test_hosted_tools_are_rejected_before_any_request():
    hosted = [WebSearchTool(), CodeInterpreterTool(tool_config={"type": "code_interpreter", "container": "auto"})]
    a, t = agent("chat-text", tools=[get_weather, *hosted])
    with pytest.raises(UserError, match="CodeInterpreterTool, WebSearchTool"):
        await Runner.run(a, "hi")
    result = Runner.run_streamed(a, "hi")
    with pytest.raises(UserError, match="hosted"):
        async for _ in result.stream_events():
            pass
    assert t.requests == []


async def test_triage_agent_hands_off_to_viktor_agent():
    p, t = provider("chat-text")
    viktor = viktor_agent(provider=p, instructions="Answer briefly.")
    triage_model = ScriptedModel([[function_call("transfer_to_viktor", "{}", call_id="call_triage_1")]])
    triage = Agent(name="Triage", model=triage_model, handoffs=[viktor])
    result = await Runner.run(triage, "Summarise #releases for this week")
    assert result.last_agent is viktor and "Viktor" in result.final_output
    assert "AI employee" in triage_model.first_call.handoffs[0].tool_description
    body = t.requests[0]["body"]
    assert body["model"] == "viktor" and body["messages"][0] == {"role": "system", "content": "Answer briefly."}
    assert "Summarise #releases" in json.dumps(body["messages"])


async def test_viktor_agent_as_tool():
    p, t = provider("chat-text")
    tool = viktor_agent(provider=p).as_tool(tool_name="ask_viktor", tool_description="Ask Viktor")
    boss_model = ScriptedModel(
        [[function_call("ask_viktor", {"input": "status?"}, call_id="call_1")], [assistant_message("done")]]
    )
    result = await Runner.run(Agent(name="Boss", model=boss_model, tools=[tool]), "go")
    assert result.final_output == "done"
    assert t.requests[0]["body"]["messages"][-1] == {"role": "user", "content": "status?"}
    assert "Viktor" in json.dumps(boss_model.last_call.input)


def test_responses_option_returns_responses_model_pointed_at_viktor():
    model = ViktorProvider(api_key="k", base_url="https://viktor.test", use_responses=True).get_model("x")
    assert isinstance(model, ViktorModel) and isinstance(model.inner, OpenAIResponsesModel)
    assert model.inner.model == "viktor"
    assert str(model.inner._client.base_url) == "https://viktor.test/api/compat/v1/"


@pytest.mark.live
@pytest.mark.skipif(not has_live_key(), reason=LIVE_SKIP_MESSAGE)
async def test_live_smoke():
    result = await Runner.run(
        Agent(name="Assistant"), "Reply with the single word: pong", run_config=configure_viktor()
    )
    assert "pong" in result.final_output.lower(), os.environ.get("VIKTOR_BASE_URL")


async def test_responses_stream_failed_event_raises_run_failed():
    from agents.models.interface import Model
    from openai.types.responses import Response, ResponseError, ResponseFailedEvent

    class FailingStream(Model):
        async def get_response(self, *args, **kwargs):
            raise NotImplementedError

        async def stream_response(self, *args, **kwargs):
            error = ResponseError(code="server_error", message="The sandbox crashed.")
            response = Response.model_construct(id="thr_1", status="failed", error=error, output=[])
            yield ResponseFailedEvent(response=response, sequence_number=1, type="response.failed")

    result = Runner.run_streamed(Agent(name="Assistant", model=ViktorModel(FailingStream())), "hi")
    with pytest.raises(ViktorRunFailedError, match="The sandbox crashed"):
        async for _ in result.stream_events():
            pass


async def test_run_cap_length_reply_is_returned_as_partial_output():
    a, _ = agent("chat-timeout-length")
    assert (await Runner.run(a, "long task")).final_output == "Partial progress so far"


def test_configure_viktor_disables_tracing_unless_opted_out(monkeypatch):
    calls = []
    monkeypatch.setattr("viktor_openai_agents.provider.set_tracing_disabled", calls.append)
    config = configure_viktor(disable_tracing=False, api_key="k", use_responses=True)
    assert calls == [] and isinstance(config.model_provider, ViktorProvider)
    assert isinstance(config.model_provider.get_model(None).inner, OpenAIResponsesModel)
    configure_viktor()
    assert calls == [True]
