"""The delegate_to_viktor function tool: shared schema, REST lifecycle, behaviour inside a Runner loop."""

import json

import httpx
import pytest
from agents import Agent, Runner, set_tracing_disabled
from agents.exceptions import ModelBehaviorError
from agents.models.chatcmpl_converter import Converter
from agents.testing import ScriptedModel, assistant_message, function_call
from viktor_integrations_core import AsyncViktorClient, delegate_tool_spec
from viktor_integrations_core.testing import fixtures_dir
from viktor_openai_agents import viktor_delegate_tool

set_tracing_disabled(True)


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


RUN = {"id": "run_1", "thread_id": "thr_1", "error": None}
COMPLETED = [
    ("POST /api/public/v1/threads", 202, {"thread": {"id": "thr_1"}, "message": {"id": "m"}, "run": RUN}),
    ("GET /api/public/v1/runs/run_1", 200, {**RUN, "status": "in_progress"}),
    ("GET /api/public/v1/runs/run_1", 200, {**RUN, "status": "completed"}),
    (
        "GET /api/public/v1/runs/run_1/result",
        200,
        {"run_id": "run_1", "status": "completed", "markdown": "Done.", "json": None, "artifacts": []},
    ),
]


def delegate(script):
    transport = RestScript(script)
    client = AsyncViktorClient(
        api_key="k", base_url="https://viktor.test", http_client=httpx.AsyncClient(transport=transport)
    )
    return viktor_delegate_tool(client=client, poll_interval=0), transport


def test_delegate_tool_schema_name_and_description_equal_the_shared_spec():
    spec = json.loads((fixtures_dir().parent / "spec" / "delegate-tool.json").read_text())
    tool = viktor_delegate_tool(api_key="k")
    assert tool.name == "delegate_to_viktor" == spec["name"]
    assert tool.description == spec["description"] == delegate_tool_spec["description"]
    assert tool.params_json_schema == spec["input_schema"] and tool.strict_json_schema is False
    wire = Converter.tool_to_openai(tool)["function"]  # what a Chat Completions model is sent
    assert wire["parameters"] == spec["input_schema"] and wire["name"] == "delegate_to_viktor"


async def test_delegate_tool_runs_the_rest_lifecycle_inside_a_runner_loop():
    tool, transport = delegate(COMPLETED)
    args = {"task": "Write the report", "speed": "faster"}
    model = ScriptedModel(
        [[function_call("delegate_to_viktor", args, call_id="call_1")], [assistant_message("Viktor is done.")]]
    )
    result = await Runner.run(Agent(name="Boss", model=model, tools=[tool]), "Get me the report")
    assert result.final_output == "Viktor is done."
    assert transport.calls == [k for k, _, _ in COMPLETED]
    assert transport.bodies[0]["message"] == "Write the report" and transport.bodies[0]["speed"] == "faster"
    output = next(i for i in model.last_call.input if i.get("type") == "function_call_output")["output"]
    assert output.startswith("Done.") and "(status: completed, thread_id: thr_1, run_id: run_1)" in output


async def test_delegate_tool_follow_up_reuses_the_thread_and_reports_failures_as_text():
    tool, transport = delegate(
        [
            ("POST /api/public/v1/threads/thr_1/messages", 202, {"message": {"id": "m2"}, "run": RUN}),
            ("GET /api/public/v1/runs/run_1", 200, {**RUN, "status": "requires_action"}),
            (
                "GET /api/public/v1/runs/run_1/result",
                200,
                {"run_id": "run_1", "status": "requires_action", "markdown": "Which quarter?", "artifacts": []},
            ),
        ]
    )
    text = await tool.on_invoke_tool(None, json.dumps({"task": "Q3", "thread_id": "thr_1"}))
    assert "needs input" in text and "Which quarter?" in text
    assert transport.calls[0] == "POST /api/public/v1/threads/thr_1/messages"
    denied, _ = delegate([("POST /api/public/v1/threads", 401, {"detail": {"error": "invalid_api_key"}})])
    assert "Delegating to Viktor failed (auth)" in await denied.on_invoke_tool(None, '{"task": "x"}')
    with pytest.raises(ModelBehaviorError, match="Invalid JSON input"):
        await tool.on_invoke_tool(None, "{not json")
