# langchain-viktor

Use [Viktor](https://viktor.com), the AI employee, from [LangChain](https://docs.langchain.com) and
LangGraph: as a chat model (`ChatViktor`) for `create_agent`, chains and graphs, and as a tool
(`ViktorDelegateTool`) your own agent can delegate work to.

Viktor is an agent, not a bare LLM. Each call runs Viktor with its own tools (code sandbox, files,
the team's connected integrations) next to the tools you bind. A turn can take minutes and may act on
those integrations.

## 60-second quickstart

```bash
pip install langchain-viktor
export VIKTOR_API_KEY=zt_live_sk_...   # Viktor → Settings → API keys, scope chat:completions
```

```python
from langchain_viktor import ChatViktor

model = ChatViktor()
reply = model.invoke("Summarise what changed in our #releases channel this week.")
print(reply.text)
```

## Streaming and your own tools

```python
from langchain_core.tools import tool
from langchain_viktor import ChatViktor
from langchain_viktor.agents import create_viktor_agent  # pip install langchain langgraph


@tool
def get_weather(city: str) -> str:
    """Get the weather for a city."""
    return f"Sunny, 24C in {city}"


agent = create_viktor_agent([get_weather], system_prompt="Answer in one line.")
question = {"messages": [("user", "What's the weather in Berlin?")]}
for chunk, _metadata in agent.stream(question, stream_mode="messages"):
    print(chunk.text, end="", flush=True)
```

`create_viktor_agent(tools, model=ChatViktor(...), **kwargs)` is `langchain.agents.create_agent` with
Viktor as the model. Without an agent, use `ChatViktor().bind_tools([...])` with `invoke`, `stream`,
`ainvoke` and `astream` as with any LangChain chat model.

Tool-call ids from Viktor look like `call_vk1_<thread>_…`. They are routing tokens: when LangChain sends
your `ToolMessage` back, Viktor resumes the same run with its sandbox state intact. `ChatViktor` passes
them through unchanged; do not rewrite them. The thread id is on
`message.response_metadata["viktor_thread_id"]`.

### Multi-turn continuity (Responses API)

On Chat Completions, plain multi-turn chat replays the history into a fresh Viktor run each turn.
To keep one Viktor thread across turns, use the Responses wire:

```python
model = ChatViktor(use_responses_api=True, use_previous_response_id=True)
first = model.invoke("Create a scratch file with today's open incidents.")
second = model.invoke([("user", "..."), first, ("user", "Now sort that file by severity.")])
```

Viktor's Responses `id` is the thread id (`first.response_metadata["id"]`, also on `viktor_thread_id`).
`ChatViktor` sends it as `previous_response_id` and only the new messages as input. You can also pass
`previous_response_id=...` to `invoke` yourself. The Responses stream has no keep-alive comments, and a
failed run arrives there as `[Stream error: …]` text, so prefer the default wire for streaming.

## Delegate work to Viktor from another model

```python
from langchain.agents import create_agent
from langchain_viktor import ViktorDelegateTool

agent = create_agent(model=your_model, tools=[ViktorDelegateTool()])
agent.invoke({"messages": [("user", "Ask Viktor to compile last month's support tickets into a CSV.")]})
```

`ViktorDelegateTool` (tool name `delegate_to_viktor`) uses Viktor's native task API: no 600 s limit,
files come back as download URLs, and a `requires_action` result tells the model Viktor needs an answer
(call again with the same `thread_id`). The `ToolMessage` content is Viktor's answer as text; its
`artifact` is the full result dict (`status`, `thread_id`, `run_id`, `markdown`, `json`, `artifacts`,
`error`). It runs sync and async (`_arun`). The key needs scopes `threads:create`, `runs:create`,
`runs:read`, `messages:create`, `files:read`.

### LangGraph handoff

```python
from langchain_viktor.agents import create_viktor_agent, create_viktor_handoff_tool
from langgraph.graph import START, MessagesState, StateGraph

supervisor = create_agent(model=your_model, tools=[create_viktor_handoff_tool()], name="supervisor")
graph = StateGraph(MessagesState)
graph.add_node("supervisor", supervisor, destinations=("viktor",))
graph.add_node("viktor", create_viktor_agent())
graph.add_edge(START, "supervisor")
```

`create_viktor_handoff_tool(agent_name="viktor")` returns a `transfer_to_viktor` tool that answers with
`Command(goto="viktor", graph=Command.PARENT, update={"messages": [...]})`. Extra keyword arguments are
added to the update, for example `active_agent="viktor"`.

## Images

Pass images as LangChain image blocks (`{"type": "image", "url": ...}`, `{"type": "image", "base64":
..., "mime_type": ...}`) or OpenAI `image_url` parts; they reach Viktor as `image_url`. Viktor accepts
`https` and `data:` URLs, jpeg, png, gif and webp, at most 10 images per request. `ChatViktor` raises
`ViktorInvalidRequestError` before any request for `http://` URLs, other MIME types, an 11th image,
and file or audio blocks, because Viktor would silently skip them.

## Errors

`ChatViktor` raises typed Viktor errors (all subclass `ViktorError`, importable from
`langchain_viktor`), chained from the original `openai` exception (`error.__cause__`). Each carries
`status`, `detail_code`, `request_id` and `body`.

| Situation | Error | Retried |
|---|---|---|
| The Viktor run failed (HTTP 502 `run_failed`, or an error frame mid-stream) | `ViktorRunFailedError` with Viktor's message | Never. The run was billed and may have acted |
| 200 with no text and no tool calls (stream ended before output) | `UserWarning` + log record; `ViktorEmptyReplyError` with `strict_empty_reply=True` | Your choice |
| Bad, expired or under-scoped key; key owner without a linked Slack/Teams identity | `ViktorAuthError` with `detail_code` and a fix hint | No |
| Rate limit, concurrency (8 runs per key), credits | `ViktorRateLimitError` with `retry_after_seconds` | Opt in, see below |
| Other 5xx | `ViktorServerError` | Opt in, see below |
| Bad image, file part, hosted tool, `n > 1`, other 4xx | `ViktorInvalidRequestError` | No |
| `finish_reason: "length"` | not an error; `response_metadata["run_cap_reached"]` is `True` when Viktor hit its 600 s cap | n/a |

`max_retries` defaults to `0`. The `openai` SDK retries every 5xx and cannot tell a failed Viktor run
(502 `run_failed`) from a gateway error, so SDK-level retries would re-run billed work. Retry what is
safe with LangChain's own policy:

```python
from langchain_viktor import ChatViktor, ViktorRateLimitError, ViktorServerError

model = ChatViktor().with_retry(retry_if_exception_type=(ViktorRateLimitError, ViktorServerError))
```

## Settings

```python
ChatViktor(
    api_key=None,  # default: VIKTOR_API_KEY
    base_url="https://api.viktor.com",  # default; or VIKTOR_BASE_URL. The host, without /api/compat/v1
    timeout=660,  # seconds; above Viktor's 600 s run cap
    stream_chunk_timeout=660,  # async streams; Viktor is silent while it runs its own tools
    max_retries=0,  # see Errors
    strict_empty_reply=False,
    use_responses_api=None,  # True for the Responses wire
    use_previous_response_id=False,  # with use_responses_api: continue the Viktor thread
)
```

Good to know: the model id is always `viktor` (any other value is replaced); system prompts are added
to Viktor's own instructions and do not replace its identity; `temperature` and `max_tokens` are best
effort; `n` must be 1; hosted OpenAI tools are rejected; reasoning is not streamed.
`init_chat_model` does not know the `viktor` provider; construct `ChatViktor` directly.

## MCP

Viktor's hosted MCP server needs no package: `https://api.viktor.com/mcp` with
`Authorization: Bearer <VIKTOR_API_KEY>`. These recipes use LangChain's MCP clients and are not part of
this package's test suite.

```python
from fastmcp import Client  # pip install fastmcp
from langchain.mcp import MCPAdapter  # beta in langchain 1.4

async with MCPAdapter(Client("https://api.viktor.com/mcp", auth=os.environ["VIKTOR_API_KEY"])) as viktor:
    agent = create_agent(model=your_model, tools=await viktor.list_tools())
```

With the older `langchain-mcp-adapters`:

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient(
    {
        "viktor": {
            "transport": "streamable_http",
            "url": "https://api.viktor.com/mcp",
            "headers": {"Authorization": f"Bearer {key}"},
        }
    }
)
tools = await client.get_tools()
```

## Example and tests

`examples/python/langchain/main.py` is a streaming agent with one local tool. Run it without a key or
network: `VIKTOR_EXAMPLE_OFFLINE=1 python main.py` (replays the repo's recorded fixtures).

`pytest tests/unit_tests` runs offline against the shared fixtures, including LangChain's standard
`ChatModelUnitTests`. `tests/integration_tests` (standard `ChatModelIntegrationTests` plus a smoke
test) runs only when `VIKTOR_API_KEY` is set; every test there is a billed Viktor run.

Tested against `langchain` 1.4.2, `langchain-core` 1.6.3, `langchain-openai` 1.6.2, `langgraph` 1.2.11
and `openai` 3.16.2 on 2026-09-20.
