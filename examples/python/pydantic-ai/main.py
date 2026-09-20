"""A Pydantic AI agent that runs on Viktor, with one local tool, streamed.

Live:     VIKTOR_API_KEY=zt_live_sk_... python main.py
Offline:  VIKTOR_EXAMPLE_OFFLINE=1 python main.py   (replays the repo's recorded fixtures, no network)
"""

from __future__ import annotations

import asyncio
import os

from pydantic_ai import (
    Agent,
    AgentRunResultEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ToolReturnPart,
)
from pydantic_ai_viktor import ViktorModel, ViktorProvider, thread_id_from


def offline_model() -> ViktorModel:
    import httpx2
    from viktor_integrations_core.testing import make_fixture_transport

    transport = make_fixture_transport(httpx2, "chat-stream-tool-call", "chat-stream-text")
    provider = ViktorProvider(
        api_key="zt_test_sk_offline",
        base_url="https://viktor.test",
        http_client=httpx2.AsyncClient(transport=transport),
    )
    return ViktorModel(provider=provider)


model = offline_model() if os.environ.get("VIKTOR_EXAMPLE_OFFLINE") else ViktorModel()
agent = Agent(model, instructions="Answer in one line.")


@agent.tool_plain
def get_weather(city: str, units: str = "metric") -> str:
    """Get the current weather for a city."""
    return f"Sunny, 24C in {city}" if units == "metric" else f"Sunny, 75F in {city}"


async def main() -> None:
    async with agent.run_stream_events("What's the weather in Berlin?") as events:
        async for event in events:
            if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
                print(event.part.content, end="", flush=True)
            elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                print(event.delta.content_delta, end="", flush=True)
            elif isinstance(event, FunctionToolCallEvent):
                thread = thread_id_from(event.part.tool_call_id)
                print(
                    f"\n[tool call] {event.part.tool_name}({event.part.args_as_json_str()}) on Viktor thread {thread}"
                )
            elif isinstance(event, FunctionToolResultEvent) and isinstance(event.part, ToolReturnPart):
                print(f"[tool result] {event.part.model_response_str()}")
            elif isinstance(event, AgentRunResultEvent):
                print(f"\n\nFinal output: {event.result.output}")


if __name__ == "__main__":
    asyncio.run(main())
