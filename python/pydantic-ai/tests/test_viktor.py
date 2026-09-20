"""Every row of the adapter test matrix (docs/adapter-guide.md), driven through Pydantic AI's public API."""

import copy
import json

import httpx
import httpx2
import pytest
from openai import AsyncOpenAI
from pydantic_ai import Agent, BinaryContent, ImageUrl, capture_run_messages
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError, UnexpectedModelBehavior, UserError
from pydantic_ai.messages import (
    DocumentUrl,
    FunctionToolCallEvent,
    ModelResponse,
    PartDeltaEvent,
    TextPart,
    ToolCallPart,
    ToolCallPartDelta,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai_viktor import (
    ViktorModel,
    ViktorProvider,
    ViktorToolset,
    viktor_agent,
    viktor_model,
    viktor_responses_model,
    viktor_thread_id,
)
from viktor_integrations_core import (
    ViktorAuthError,
    ViktorEmptyReplyError,
    ViktorInvalidRequestError,
    ViktorRateLimitError,
    ViktorRunFailedError,
    delegate_tool_spec,
)
from viktor_integrations_core.testing import fixtures_dir, load_fixture, make_fixture_transport

ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3"
THREAD_ID = "zwKTTPTKCc9TVsSMgJuGh"
PNG = load_fixture("chat-image")["request"]["body"]["messages"][0]["content"][1]["image_url"]["url"]


def provider(transport, base_url: str | None = "https://viktor.test") -> ViktorProvider:
    return ViktorProvider(
        api_key="zt_test_sk_fixture", base_url=base_url, http_client=httpx2.AsyncClient(transport=transport)
    )


def viktor(*fixtures: str, **kwargs):
    transport = make_fixture_transport(httpx2, *fixtures)
    return ViktorModel(provider=provider(transport), **kwargs), transport


def weather_agent(model) -> Agent:
    agent = Agent(model)

    @agent.tool_plain
    def get_weather(city: str, units: str = "celsius") -> str:
        """Get weather"""
        return f"Sunny, 24C in {city}"

    return agent


# --- provider -----------------------------------------------------------------------------------------------


async def test_plain_reply_with_only_an_api_key(monkeypatch):
    monkeypatch.delenv("VIKTOR_BASE_URL", raising=False)
    t = make_fixture_transport(httpx2, "chat-text")
    result = await Agent(OpenAIChatModel("viktor", provider=provider(t, base_url=None))).run(
        "Say hello in one sentence."
    )
    assert result.output == "Hello! I'm Viktor, ready to help."
    request = t.requests[0]
    assert request["url"] == "https://api.viktor.com/api/compat/v1/chat/completions"
    assert request["headers"]["authorization"] == "Bearer zt_test_sk_fixture"
    assert request["body"]["model"] == "viktor"
    assert request["body"]["messages"] == [{"role": "user", "content": "Say hello in one sentence."}]


def test_provider_follows_the_in_tree_provider_contract(monkeypatch):
    monkeypatch.setenv("VIKTOR_API_KEY", "zt_test_sk_env")
    monkeypatch.setenv("VIKTOR_BASE_URL", "https://staging.viktor.test/")
    provider = ViktorProvider()
    assert provider.name == "viktor"
    assert provider.base_url == "https://staging.viktor.test/api/compat/v1"
    assert isinstance(provider.client, AsyncOpenAI)
    assert str(provider.client.base_url) == "https://staging.viktor.test/api/compat/v1/"
    assert provider.client.api_key == "zt_test_sk_env"
    # A failed Viktor run was billed and may have acted: never retried blindly. 660 s is above the 600 s run cap.
    assert provider.client.max_retries == 0
    assert provider.client.timeout == 660.0

    client = AsyncOpenAI(api_key="k", base_url="https://proxy.test/v1")
    assert ViktorProvider(openai_client=client).client is client
    assert ViktorProvider(openai_client=client).base_url == "https://proxy.test/v1"
    with pytest.raises(UserError, match="Cannot provide both `openai_client` and `api_key`"):
        ViktorProvider(openai_client=client, api_key="k")  # type: ignore[call-overload]


def test_missing_api_key_uses_the_in_tree_wording(monkeypatch):
    monkeypatch.delenv("VIKTOR_API_KEY", raising=False)
    with pytest.raises(
        UserError,
        match=r"Set the `VIKTOR_API_KEY` environment variable or pass it via `ViktorProvider\(api_key=...\)`"
        " to use the Viktor provider.",
    ):
        ViktorProvider()


def test_model_profile_is_conservative():
    profile = viktor_model(ViktorProvider(api_key="k")).profile
    assert profile.get("supports_tools") and profile.get("supports_json_schema_output")
    assert profile.get("supports_thinking") is False and profile.get("openai_supports_reasoning") is False
    assert profile.get("openai_supports_strict_tool_definition") is False
    assert ViktorProvider.model_profile("viktor") == ViktorProvider.model_profile("anything")


def test_model_factories_wrap_the_upstream_classes():
    chat, responses = viktor_model(ViktorProvider(api_key="k")), viktor_responses_model(ViktorProvider(api_key="k"))
    assert type(chat) is OpenAIChatModel and type(responses) is OpenAIResponsesModel
    assert chat.model_name == responses.model_name == "viktor"
    assert chat.system == "viktor" and chat.base_url == "https://api.viktor.com/api/compat/v1/"
    wrapper = ViktorModel(provider=ViktorProvider(api_key="k"))
    assert isinstance(wrapper.wrapped, OpenAIChatModel) and wrapper.model_name == "viktor"
    with pytest.raises(UserError, match="Cannot provide both `wrapped` and `provider`"):
        ViktorModel(chat, provider=ViktorProvider(api_key="k"))


# --- streaming ----------------------------------------------------------------------------------------------


async def test_streaming_text_never_surfaces_keep_alives():
    model, t = viktor("chat-stream-text")
    async with Agent(model).run_stream("Say hello") as result:
        deltas = [delta async for delta in result.stream_text(delta=True, debounce_by=None)]
    expected = "".join(
        json.loads(frame[6:])["choices"][0]["delta"].get("content") or ""
        for frame in load_fixture("chat-stream-text")["response"]["sse"]
        if frame.startswith("data: {") and json.loads(frame[6:])["choices"]
    )
    assert "".join(deltas) == expected and len(deltas) > 1
    assert not any("keep-alive" in delta for delta in deltas)
    assert t.requests[0]["body"]["stream"] is True and t.requests[0]["body"]["model"] == "viktor"


async def test_streaming_tool_call_assembles_fragments_and_keeps_the_routed_id():
    model, t = viktor("chat-stream-tool-call", "chat-stream-text")
    calls: list[ToolCallPart] = []
    fragments: list = []
    async with weather_agent(model).iter("weather in Berlin?") as run:
        async for node in run:
            if Agent.is_model_request_node(node):
                async with node.stream(run.ctx) as model_stream:
                    async for event in model_stream:
                        if isinstance(event, PartDeltaEvent) and isinstance(event.delta, ToolCallPartDelta):
                            fragments.append(event.delta.args_delta)
            elif Agent.is_call_tools_node(node):
                async with node.stream(run.ctx) as events:
                    calls += [event.part async for event in events if isinstance(event, FunctionToolCallEvent)]
    assert [(c.tool_name, c.tool_call_id, c.args_as_dict()) for c in calls] == [
        ("get_weather", ROUTED_ID, {"city": "Berlin", "units": "metric"})
    ]
    assert fragments == ['lin","units":"metric"}']  # the second SSE fragment; the first one opens the part
    assert run.result is not None and run.result.output
    follow_up = t.requests[1]["body"]
    assert follow_up["messages"][-1]["tool_call_id"] == ROUTED_ID
    assert follow_up["messages"][-2]["tool_calls"][0]["id"] == ROUTED_ID
    response = next(m for m in run.result.all_messages() if isinstance(m, ModelResponse))
    assert viktor_thread_id(response) == THREAD_ID


# --- tool loop ----------------------------------------------------------------------------------------------


async def test_tool_loop_returns_the_id_byte_for_byte_and_redeclares_tools():
    model, t = viktor("chat-tool-call", "chat-tool-result-followup")
    result = await weather_agent(model).run("weather in Berlin?")
    assert (
        result.output
        == load_fixture("chat-tool-result-followup")["response"]["body"]["choices"][0]["message"]["content"]
    )

    first, second = (r["body"] for r in t.requests)
    assistant, tool = second["messages"][-2:]
    assert assistant["role"] == "assistant" and assistant["tool_calls"][0]["id"] == ROUTED_ID
    assert tool == {"role": "tool", "tool_call_id": ROUTED_ID, "content": "Sunny, 24C in Berlin"}
    assert second["tools"] == first["tools"] and first["tools"][0]["function"]["name"] == "get_weather"
    assert "strict" not in first["tools"][0]["function"]  # conservative profile: no strict tool definitions

    response = result.all_messages()[1]
    assert isinstance(response, ModelResponse)
    assert response.provider_details is not None and response.provider_details["viktor_thread_id"] == THREAD_ID


# --- images -------------------------------------------------------------------------------------------------


async def test_images_reach_viktor_as_image_url_parts():
    model, t = viktor("chat-image")
    image = BinaryContent.from_data_uri(PNG)
    result = await Agent(model).run(["What is in this picture?", image, ImageUrl("https://example.com/cat.png")])
    assert result.output == "A single transparent pixel."
    content = t.requests[0]["body"]["messages"][0]["content"]
    assert content[0] == {"type": "text", "text": "What is in this picture?"}
    assert content[1]["type"] == "image_url" and content[1]["image_url"]["url"] == PNG
    assert content[2]["type"] == "image_url" and content[2]["image_url"]["url"] == "https://example.com/cat.png"


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ([ImageUrl("http://example.com/cat.png")], "only fetches images over https"),
        ([BinaryContent(b"II*\x00", media_type="image/tiff")], "image/tiff"),
        ([ImageUrl(f"https://example.com/{i}.png") for i in range(11)], "at most 10 images"),
        ([DocumentUrl("https://example.com/report.pdf")], "not supported by Viktor"),
    ],
)
async def test_bad_images_are_rejected_before_any_request(content, message):
    model, t = viktor("chat-image")
    with pytest.raises(UserError, match=message) as exc_info:
        await Agent(model).run(["Look at this", *content])
    assert t.requests == []
    if "not supported" not in message:
        assert isinstance(exc_info.value.__cause__, ViktorInvalidRequestError)


# --- errors -------------------------------------------------------------------------------------------------


async def test_run_failed_is_a_model_http_error_with_viktors_message_and_is_not_retried():
    model, t = viktor("chat-run-failed")
    with pytest.raises(ModelHTTPError) as exc_info:
        await Agent(model, retries=3).run("trigger empty")
    error = exc_info.value
    assert error.status_code == 502 and error.model_name == "viktor"
    assert "Viktor run failed: The model returned an empty response twice in a row." in str(error)
    assert "req_fixture_0001" in str(error)
    cause = error.__cause__
    assert isinstance(cause, ViktorRunFailedError)
    assert (cause.detail_code, cause.request_id, cause.status) == ("run_failed", "req_fixture_0001", 502)
    assert len(t.requests) == 1  # billed, may have acted: never retried automatically


async def test_in_stream_error_frame_is_an_error_not_a_silent_end():
    model, t = viktor("chat-stream-run-failed")
    with pytest.raises(
        ModelAPIError, match="Viktor run failed: The model returned an empty response twice"
    ) as exc_info:
        async with Agent(model).run_stream("trigger empty") as result:
            async for _ in result.stream_text():
                pass
    cause = exc_info.value.__cause__
    assert isinstance(cause, ViktorRunFailedError) and cause.detail_code == "run_failed"
    assert exc_info.value.model_name == "viktor" and len(t.requests) == 1


async def test_empty_reply_warns_by_default_and_pydantic_ai_asks_again():
    model, t = viktor("chat-empty-reply", "chat-text")
    with pytest.warns(UserWarning, match="Viktor returned an empty reply"):
        result = await Agent(model).run("hello")
    assert result.output == "Hello! I'm Viktor, ready to help." and len(t.requests) == 2


async def test_empty_reply_is_an_error_in_strict_mode():
    model, t = viktor("chat-empty-reply", strict_empty_reply=True)
    with pytest.raises(UnexpectedModelBehavior, match="Viktor returned an empty reply") as exc_info:
        await Agent(model).run("hello")
    assert isinstance(exc_info.value.__cause__, ViktorEmptyReplyError) and len(t.requests) == 1


async def test_stream_that_ends_without_output_is_an_error_in_strict_mode():
    model, t = viktor("chat-stream-ended-without-output", strict_empty_reply=True)
    with pytest.raises(UnexpectedModelBehavior, match="Viktor returned an empty reply") as exc_info:
        async with Agent(model).run_stream("hello") as result:
            async for _ in result.stream_text():
                pass
    assert isinstance(exc_info.value.__cause__, ViktorEmptyReplyError) and len(t.requests) == 1


async def test_401_is_an_auth_error_with_the_fix_hint():
    model, _ = viktor("chat-auth-401")
    with pytest.raises(ModelHTTPError, match="Check VIKTOR_API_KEY") as exc_info:
        await Agent(model).run("hi")
    cause = exc_info.value.__cause__
    assert exc_info.value.status_code == 401
    assert isinstance(cause, ViktorAuthError) and cause.detail_code == "invalid_api_key"


async def test_429_is_a_rate_limit_error_with_retry_after():
    model, _ = viktor("chat-rate-limit")
    with capture_run_messages(), pytest.raises(ModelHTTPError, match="Rate limit exceeded") as exc_info:
        await Agent(model).run("hi")
    error, cause = exc_info.value, exc_info.value.__cause__
    assert error.status_code == 429 and error.headers is not None and error.headers["retry-after"] == "17"
    assert isinstance(cause, ViktorRateLimitError)
    assert (cause.retry_after_seconds, cause.detail_code, cause.is_retryable) == (17.0, "rate_limit_exceeded", True)


# --- delegate toolset and agent -----------------------------------------------------------------------------


class RestScript(httpx.MockTransport):
    def __init__(self, script):
        self.script, self.calls, self.bodies = list(script), [], []
        super().__init__(self._handle)

    def _handle(self, request):
        key = f"{request.method} {request.url.path}"
        self.calls.append(key)
        self.bodies.append(json.loads(request.content) if request.content else None)
        for i, (k, status, body) in enumerate(self.script):
            if k == key:
                del self.script[i]
                return httpx.Response(status, json=body)
        raise AssertionError(f"unexpected request {key}")


COMPLETED = [
    (
        "POST /api/public/v1/threads",
        202,
        {"thread": {"id": "thr_1"}, "message": {"id": "m"}, "run": {"id": "run_1", "status": "queued"}},
    ),
    (
        "GET /api/public/v1/runs/run_1",
        200,
        {"id": "run_1", "thread_id": "thr_1", "status": "in_progress", "error": None},
    ),
    ("GET /api/public/v1/runs/run_1", 200, {"id": "run_1", "thread_id": "thr_1", "status": "completed", "error": None}),
    (
        "GET /api/public/v1/runs/run_1/result",
        200,
        {"run_id": "run_1", "status": "completed", "markdown": "Done.", "json": None, "artifacts": []},
    ),
]


async def test_delegate_tool_definition_equals_the_shared_spec_and_runs_the_rest_lifecycle():
    spec = json.loads((fixtures_dir().parent / "spec" / "delegate-tool.json").read_text())
    assert spec == delegate_tool_spec
    rest = RestScript(COMPLETED)
    statuses: list[str] = []
    toolset = ViktorToolset(
        api_key="k",
        base_url="https://viktor.test",
        http_client=httpx.AsyncClient(transport=rest),
        poll_interval=0,
        on_status=statuses.append,
    )
    seen: list[AgentInfo] = []

    def lead(messages, info: AgentInfo) -> ModelResponse:
        seen.append(info)
        if len(seen) == 1:
            return ModelResponse(parts=[ToolCallPart("delegate_to_viktor", {"task": "Write the report"})])
        return ModelResponse(parts=[TextPart(messages[-1].parts[0].model_response_str())])

    result = await Agent(FunctionModel(lead), toolsets=[toolset]).run("Get Viktor to write the report")

    (definition,) = seen[0].function_tools
    assert definition.name == spec["name"] == "delegate_to_viktor"
    assert definition.description == spec["description"]
    assert definition.parameters_json_schema == spec["input_schema"]
    assert rest.calls == [k for k, _, _ in COMPLETED] and rest.bodies[0]["message"] == "Write the report"
    assert statuses == ["in_progress", "completed"]
    assert result.output == "Done.\n\n(status: completed, thread_id: thr_1, run_id: run_1)"


async def test_delegate_tool_schema_reaches_an_openai_compatible_model_unchanged():
    model, t = viktor("chat-text")
    await Agent(model, toolsets=[ViktorToolset(api_key="k")]).run("hi")
    function = t.requests[0]["body"]["tools"][0]["function"]
    assert function["name"] == delegate_tool_spec["name"]
    assert function["description"] == delegate_tool_spec["description"]
    # Pydantic AI's OpenAI schema transformer adds an empty `properties` to free-form objects ("OpenAI drops
    # objects without it"); nothing else may differ, and the object must stay open (no `additionalProperties`).
    expected = copy.deepcopy(delegate_tool_spec["input_schema"])
    expected["properties"]["response_schema"]["properties"] = {}
    assert function["parameters"] == expected and "strict" not in function


async def test_viktor_agent_works_for_agent_delegation():
    transport = make_fixture_transport(httpx2, "chat-text")
    worker = viktor_agent(
        ViktorModel(provider=provider(transport)),
        instructions="Answer in one sentence.",
    )
    assert worker.name == "viktor" and isinstance(worker.model, ViktorModel)

    def lead_model(messages, info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart("ask_viktor", {"task": "Say hello"})])
        return ModelResponse(parts=[TextPart(messages[-1].parts[0].model_response_str())])

    lead = Agent(FunctionModel(lead_model))

    @lead.tool_plain
    async def ask_viktor(task: str) -> str:
        return (await worker.run(task)).output

    result = await lead.run("Ask Viktor to say hello")
    assert result.output == "Hello! I'm Viktor, ready to help."
    messages = transport.requests[0]["body"]["messages"]
    assert messages == [
        {"role": "system", "content": "Answer in one sentence."},
        {"role": "user", "content": "Say hello"},
    ]


async def test_responses_model_threads_previous_response_id():
    from pydantic_ai.models.openai import OpenAIResponsesModelSettings

    seen: list[dict] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(request.content))
        return httpx2.Response(200, json={
            "id": THREAD_ID, "object": "response", "created_at": 1758300000, "status": "completed", "model": "viktor",
            "output": [{"id": "msg_1", "type": "message", "role": "assistant", "status": "completed",
                        "content": [{"type": "output_text", "text": "Hi.", "annotations": []}]}],
            "parallel_tool_calls": True, "tool_choice": "auto", "tools": [],
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
                      "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 0}},
        })  # fmt: skip

    model = viktor_responses_model(provider(httpx2.MockTransport(handler)))
    agent = Agent(ViktorModel(model), model_settings=OpenAIResponsesModelSettings(openai_previous_response_id="auto"))
    first = await agent.run("hello")
    await agent.run("and again", message_history=first.all_messages())
    assert viktor_thread_id(first.all_messages()[-1]) == THREAD_ID  # type: ignore[arg-type]
    assert "previous_response_id" not in seen[0] and seen[1]["previous_response_id"] == THREAD_ID
    assert seen[1]["model"] == "viktor" and [i["content"] for i in seen[1]["input"]] == ["and again"]


async def test_error_frame_after_partial_text_is_mapped_while_the_caller_iterates():
    frames = (
        load_fixture("chat-stream-text")["response"]["sse"][:2]
        + load_fixture("chat-stream-run-failed")["response"]["sse"][1:]
    )
    body = "".join(f"{frame}\n\n" for frame in frames).encode()
    transport = httpx2.MockTransport(
        lambda _: httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=body)
    )
    model = ViktorModel(provider=provider(transport))
    seen: list[str] = []
    with pytest.raises(ModelAPIError, match="Viktor run failed") as exc_info:
        async with Agent(model).run_stream("hi") as result:
            async for delta in result.stream_text(delta=True, debounce_by=None):
                seen.append(delta)
    assert seen and isinstance(exc_info.value.__cause__, ViktorRunFailedError)
