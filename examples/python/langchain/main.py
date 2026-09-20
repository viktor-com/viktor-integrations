"""A LangChain agent that runs on Viktor, with one local tool, streamed.

Live:     VIKTOR_API_KEY=zt_live_sk_... python main.py
Offline:  VIKTOR_EXAMPLE_OFFLINE=1 python main.py   (replays the repo's recorded fixtures, no network)
"""

from __future__ import annotations

import os

from langchain_core.messages import AIMessageChunk, ToolMessage
from langchain_core.tools import tool
from langchain_viktor import ChatViktor
from langchain_viktor.agents import create_viktor_agent


@tool
def get_weather(city: str, units: str = "metric") -> str:
    """Get the current weather for a city."""
    return f"Sunny, 24C in {city}" if units == "metric" else f"Sunny, 75F in {city}"


def offline_model() -> ChatViktor:
    import httpx2
    from viktor_integrations_core.testing import make_fixture_transport

    transport = make_fixture_transport(httpx2, "chat-stream-tool-call", "chat-stream-text")
    return ChatViktor(
        api_key="zt_test_sk_offline",
        base_url="https://viktor.test",
        http_client=httpx2.Client(transport=transport),
    )


def main() -> None:
    model = offline_model() if os.environ.get("VIKTOR_EXAMPLE_OFFLINE") else ChatViktor()
    agent = create_viktor_agent([get_weather], model=model, system_prompt="Answer in one line.")

    question = {"messages": [("user", "What's the weather in Berlin?")]}
    for message, _metadata in agent.stream(question, stream_mode="messages"):
        if isinstance(message, AIMessageChunk):
            print(message.text, end="", flush=True)
            if message.response_metadata.get("finish_reason") == "tool_calls":
                # Viktor's tool-call ids are routing tokens: the follow-up request resumes this thread.
                print(f"\n[tool call] run ended on Viktor thread {message.response_metadata['viktor_thread_id']}")
        elif isinstance(message, ToolMessage):
            print(f"[tool result] {message.name} -> {message.content} (id {message.tool_call_id})")
    print()


if __name__ == "__main__":
    main()
