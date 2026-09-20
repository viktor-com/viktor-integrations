"""LangGraph helpers: Viktor as an agent and as a handoff target."""

from __future__ import annotations

import httpx2
import pytest
from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool
from langchain_viktor import ChatViktor
from langchain_viktor.agents import create_viktor_agent, create_viktor_handoff_tool
from langgraph.graph import START, MessagesState, StateGraph
from viktor_integrations_core.testing import make_fixture_transport

ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3"


@tool
def get_weather(city: str, units: str = "C") -> str:
    """Get weather"""
    return "Sunny, 24C"


def viktor(*fixtures: str):
    transport = make_fixture_transport(httpx2, *fixtures)
    model = ChatViktor(
        api_key="zt_test_sk_fixture",
        base_url="https://viktor.test",
        http_client=httpx2.Client(transport=transport),
        http_async_client=httpx2.AsyncClient(transport=transport),
    )
    return model, transport


class FakeSupervisor(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def test_create_viktor_agent_runs_the_tool_loop_with_the_routed_id():
    model, transport = viktor("chat-tool-call", "chat-tool-result-followup")
    agent = create_viktor_agent([get_weather], model=model)
    state = agent.invoke({"messages": [("user", "weather in Berlin?")]})
    assert state["messages"][-1].content == "It is sunny and 24C in Berlin."
    tool_message = next(m for m in state["messages"] if isinstance(m, ToolMessage))
    assert tool_message.tool_call_id == ROUTED_ID
    follow_up = transport.requests[1]["body"]
    assert follow_up["messages"][-1]["tool_call_id"] == ROUTED_ID
    assert follow_up["messages"][-2]["tool_calls"][0]["id"] == ROUTED_ID
    assert follow_up["tools"] == transport.requests[0]["body"]["tools"]


@pytest.mark.asyncio
async def test_create_viktor_agent_async():
    model, transport = viktor("chat-tool-call", "chat-tool-result-followup")
    state = await create_viktor_agent([get_weather], model=model).ainvoke({"messages": [("user", "weather?")]})
    assert state["messages"][-1].content == "It is sunny and 24C in Berlin."
    assert len(transport.requests) == 2


def test_handoff_tool_sends_the_parent_graph_to_the_viktor_node():
    handoff = create_viktor_handoff_tool()
    assert handoff.name == "transfer_to_viktor" and "Viktor" in handoff.description
    assert handoff.tool_call_schema.model_json_schema()["properties"] == {}

    call = {"name": "transfer_to_viktor", "args": {}, "id": "call_handoff", "type": "tool_call"}
    supervisor = create_agent(
        model=FakeSupervisor(messages=iter([AIMessage(content="", tool_calls=[call])])),
        tools=[handoff],
        name="supervisor",
    )
    model, transport = viktor("chat-text")
    graph = StateGraph(MessagesState)
    graph.add_node("supervisor", supervisor, destinations=("viktor",))
    graph.add_node("viktor", create_viktor_agent(model=model))
    graph.add_edge(START, "supervisor")
    state = graph.compile().invoke({"messages": [("user", "Ask Viktor to say hello")]})

    assert state["messages"][-1].content == "Hello! I'm Viktor, ready to help."
    transfer = next(m for m in state["messages"] if isinstance(m, ToolMessage))
    assert transfer.tool_call_id == "call_handoff" and transfer.content == "Transferred to viktor."
    sent = transport.requests[0]["body"]["messages"]
    assert [m["role"] for m in sent] == ["user", "assistant", "tool"]
    assert sent[1]["tool_calls"][0]["id"] == sent[2]["tool_call_id"] == "call_handoff"


def test_handoff_tool_accepts_a_custom_node_name_and_extra_update():
    handoff = create_viktor_handoff_tool(agent_name="ops", name="ask_ops", description="d", active="ops")
    assert (handoff.name, handoff.description) == ("ask_ops", "d")
