"""LIVE SMOKE TEST against the real Viktor API. Runs only when VIKTOR_API_KEY is set. Budget: 3 run creations."""

from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool
from langchain_viktor import ChatViktor
from viktor_integrations_core import is_routed_tool_id
from viktor_integrations_core.testing import LIVE_SKIP_MESSAGE, has_live_key

pytestmark = [pytest.mark.live, pytest.mark.skipif(not has_live_key(), reason=LIVE_SKIP_MESSAGE)]


@tool
def get_secret_number() -> str:
    """Returns the secret number. Always call it when asked for the secret number."""
    return "4217"


def test_plain_prompt():
    reply = ChatViktor(strict_empty_reply=True).invoke("Reply with the single word: pong")
    assert "pong" in reply.text.lower() and reply.response_metadata["model_name"] == "viktor"


def test_streamed_tool_call_has_a_routed_id_and_the_follow_up_resumes_the_thread():
    model = ChatViktor(strict_empty_reply=True).bind_tools([get_secret_number], tool_choice="required")
    question = HumanMessage("Call get_secret_number, then reply with only that number.")
    first = None
    for chunk in model.stream([question]):
        first = chunk if first is None else first + chunk
    assert first is not None and first.response_metadata["finish_reason"] == "tool_calls"
    call = first.tool_calls[0]
    assert is_routed_tool_id(call["id"]) and first.response_metadata["viktor_thread_id"]
    result = ToolMessage(get_secret_number.invoke(call["args"]), tool_call_id=call["id"])
    final = ChatViktor().bind_tools([get_secret_number]).invoke([question, first, result])
    assert "4217" in final.text
