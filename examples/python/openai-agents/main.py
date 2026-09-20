"""An OpenAI Agents SDK agent that runs on Viktor, with one local function tool, streamed.

Live:     VIKTOR_API_KEY=zt_live_sk_... python main.py
Offline:  VIKTOR_EXAMPLE_OFFLINE=1 python main.py   (replays the repo's recorded fixtures, no network)
"""

from __future__ import annotations

import asyncio
import os

from agents import Agent, Runner, function_tool
from openai.types.responses import ResponseTextDeltaEvent
from viktor_openai_agents import ViktorProvider, configure_viktor, thread_id_from


@function_tool
def get_weather(city: str, units: str = "metric") -> str:
    """Get the current weather for a city."""
    return f"Sunny, 24C in {city}" if units == "metric" else f"Sunny, 75F in {city}"


def offline_provider() -> ViktorProvider:
    import httpx2
    from openai import AsyncOpenAI
    from viktor_integrations_core.testing import make_fixture_transport

    transport = make_fixture_transport(httpx2, "chat-stream-tool-call", "chat-stream-text")
    client = AsyncOpenAI(
        api_key="zt_test_sk_offline",
        base_url="https://viktor.test/api/compat/v1",
        max_retries=0,
        http_client=httpx2.AsyncClient(transport=transport),
    )
    return ViktorProvider(openai_client=client)


async def main() -> None:
    # Routes the run to Viktor and disables SDK tracing, which would upload to OpenAI with an OpenAI key.
    run_config = configure_viktor()
    if os.environ.get("VIKTOR_EXAMPLE_OFFLINE"):
        run_config.model_provider = offline_provider()

    agent = Agent(name="Assistant", instructions="Answer in one line.", tools=[get_weather])
    result = Runner.run_streamed(agent, "What's the weather in Berlin?", run_config=run_config)
    async for event in result.stream_events():
        if event.type == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
            print(event.data.delta, end="", flush=True)
        elif event.type == "run_item_stream_event" and event.name == "tool_called":
            call = event.item.raw_item
            print(f"\n[tool call] {call.name}({call.arguments}) on Viktor thread {thread_id_from(call.call_id)}")
        elif event.type == "run_item_stream_event" and event.name == "tool_output":
            print(f"[tool result] {event.item.output}")
    print(f"\n\nFinal output: {result.final_output}")


if __name__ == "__main__":
    asyncio.run(main())
