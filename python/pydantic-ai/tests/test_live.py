"""LIVE SMOKE TEST through Pydantic AI against the real Viktor API. Runs only when VIKTOR_API_KEY is set.

Budget: 3 run creations.
"""

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai_viktor import ViktorModel, is_routed_tool_id, viktor_thread_id
from viktor_integrations_core.testing import LIVE_SKIP_MESSAGE, has_live_key

pytestmark = [pytest.mark.live, pytest.mark.skipif(not has_live_key(), reason=LIVE_SKIP_MESSAGE)]


async def test_live_streams_a_reply():
    async with Agent(ViktorModel(strict_empty_reply=True)).run_stream("Reply with the single word: pong") as result:
        text = "".join([delta async for delta in result.stream_text(delta=True)])
    assert "pong" in text.lower()


async def test_live_completes_a_tool_loop_with_routed_ids():
    agent = Agent(ViktorModel(strict_empty_reply=True))

    @agent.tool_plain
    def get_secret_number() -> str:
        """Returns the secret number. Always call it when asked for the secret number."""
        return "4217"

    result = await agent.run("Call get_secret_number, then reply with only that number.")
    assert "4217" in result.output
    responses = [m for m in result.all_messages() if isinstance(m, ModelResponse)]
    call = next(p for m in responses for p in m.parts if isinstance(p, ToolCallPart))
    assert is_routed_tool_id(call.tool_call_id), f"tool id {call.tool_call_id} should be a routed id"
    assert viktor_thread_id(responses[0])
