"""ViktorDelegateTool: shared schema and the REST lifecycle against a scripted transport."""

from __future__ import annotations

import json

import httpx
import pytest
from langchain_core.messages import ToolMessage
from langchain_core.utils.function_calling import convert_to_openai_tool
from langchain_viktor import ViktorDelegateTool
from pydantic import ValidationError
from viktor_integrations_core import AsyncViktorClient, ViktorClient
from viktor_integrations_core.testing import fixtures_dir

SPEC = json.loads((fixtures_dir().parent / "spec" / "delegate-tool.json").read_text())
REST = "/api/public/v1"
COMPLETED = [
    (f"POST {REST}/threads", 202, {"thread": {"id": "thr_1"}, "message": {"id": "m"}, "run": {"id": "run_1"}}),
    (f"GET {REST}/runs/run_1", 200, {"id": "run_1", "thread_id": "thr_1", "status": "in_progress", "error": None}),
    (f"GET {REST}/runs/run_1", 200, {"id": "run_1", "thread_id": "thr_1", "status": "completed", "error": None}),
    (
        f"GET {REST}/runs/run_1/result",
        200,
        {
            "run_id": "run_1",
            "status": "completed",
            "markdown": "Done.",
            "json": None,
            "artifacts": [{"id": "ftok", "display_name": "report.pdf", "content_type": "application/pdf"}],
        },
    ),
    (f"GET {REST}/files/ftok/download-url", 200, {"url": f"{REST}/files/downloads/signed", "expires_at": None}),
]
REQUIRES_ACTION = [
    (f"POST {REST}/threads/thr_1/messages", 202, {"message": {"id": "m2"}, "run": {"id": "run_2"}}),
    (f"GET {REST}/runs/run_2", 200, {"id": "run_2", "thread_id": "thr_1", "status": "requires_action", "error": None}),
    (
        f"GET {REST}/runs/run_2/result",
        200,
        {"run_id": "run_2", "status": "requires_action", "markdown": "Which quarter?", "json": None, "artifacts": []},
    ),
]


class RestScript(httpx.MockTransport):
    """Answers each `METHOD path` once, in script order; records calls and JSON bodies."""

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


def delegate_tool(script):
    transport = RestScript(script)
    options = {"api_key": "k", "base_url": "https://viktor.test"}
    tool = ViktorDelegateTool(
        poll_interval=0,
        client=ViktorClient(**options, http_client=httpx.Client(transport=transport)),
        async_client=AsyncViktorClient(**options, http_client=httpx.AsyncClient(transport=transport)),
    )
    return tool, transport


def _clean(prop):
    return {k: v for k, v in prop.items() if k != "title" and not (k == "default" and v is None)}


def test_delegate_tool_schema_equals_the_shared_spec():
    tool = ViktorDelegateTool(api_key="k")
    assert tool.name == SPEC["name"] == "delegate_to_viktor"
    assert tool.description == SPEC["description"]
    for schema in (
        tool.tool_call_schema.model_json_schema(),
        convert_to_openai_tool(tool)["function"]["parameters"],
    ):
        assert {k: _clean(v) for k, v in schema["properties"].items()} == SPEC["input_schema"]["properties"]
        assert schema["required"] == SPEC["input_schema"]["required"]
    function = convert_to_openai_tool(tool)["function"]
    assert (function["name"], function["description"]) == (SPEC["name"], SPEC["description"])


def test_delegate_tool_validates_input_like_the_spec():
    tool, transport = delegate_tool([])
    with pytest.raises(ValidationError):
        tool.invoke({"task": ""})
    with pytest.raises(ValidationError):
        tool.invoke({"task": "x", "timeout_seconds": 5000})
    assert transport.calls == []


def test_delegate_tool_runs_the_rest_lifecycle_and_returns_text_plus_artifact():
    tool, transport = delegate_tool(COMPLETED)
    message = tool.invoke(
        {"type": "tool_call", "name": tool.name, "id": "call_1", "args": {"task": "Write the report"}}
    )
    assert isinstance(message, ToolMessage) and message.tool_call_id == "call_1"
    assert "Done." in message.content and "report.pdf" in message.content
    assert "thread_id: thr_1" in message.content and "run_id: run_1" in message.content
    assert message.artifact["status"] == "completed" and message.artifact["thread_id"] == "thr_1"
    assert message.artifact["artifacts"][0]["download_url"] == f"https://viktor.test{REST}/files/downloads/signed"
    assert transport.calls == [k for k, _, _ in COMPLETED]
    assert transport.bodies[0] == {"message": "Write the report", "response_format": {"type": "text"}}


def test_delegate_tool_plain_invoke_returns_the_text():
    tool, _ = delegate_tool(COMPLETED)
    assert tool.invoke({"task": "Write the report"}).startswith("Done.")


def test_delegate_tool_follow_up_reuses_the_thread_and_requires_action_is_a_result():
    tool, transport = delegate_tool(REQUIRES_ACTION)
    text = tool.invoke({"task": "Q3", "thread_id": "thr_1", "speed": "faster"})
    assert "needs input" in text and "Which quarter?" in text and "thread_id: thr_1" in text
    assert transport.calls[0] == f"POST {REST}/threads/thr_1/messages"
    assert transport.bodies[0]["speed"] == "faster"


@pytest.mark.asyncio
async def test_delegate_tool_async_runs_the_rest_lifecycle():
    tool, transport = delegate_tool(COMPLETED)
    message = await tool.ainvoke({"type": "tool_call", "name": tool.name, "id": "call_2", "args": {"task": "Report"}})
    assert message.artifact["status"] == "completed" and "Done." in message.content
    assert transport.calls[0] == f"POST {REST}/threads"


def test_delegate_tool_reads_the_api_key_from_the_environment(monkeypatch):
    monkeypatch.setenv("VIKTOR_API_KEY", "zt_test_sk_env")
    tool = ViktorDelegateTool()
    assert tool.api_key is not None and tool.api_key.get_secret_value() == "zt_test_sk_env"
    assert "zt_test_sk_env" not in repr(tool)
