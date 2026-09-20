# Viktor for the OpenAI Agents SDK

Use [Viktor](https://viktor.com), the AI employee, from the
[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/): as the model behind your agents, as a
handoff target, and as a tool another agent can delegate work to.

Viktor is an agent, not a bare LLM. Each call runs Viktor with its own tools (code sandbox, files, the
team's connected integrations) next to the tools you pass. A turn can take minutes and may act on
connected systems.

## 60-second quickstart

```bash
pip install viktor-openai-agents
export VIKTOR_API_KEY=zt_live_sk_...   # Viktor → Settings → API keys, scope chat:completions
```

```python
import asyncio
from agents import Agent, Runner
from viktor_openai_agents import configure_viktor


async def main():
    agent = Agent(name="Assistant", instructions="Answer briefly.")
    result = await Runner.run(
        agent,
        "Summarise what changed in our #releases channel this week.",
        run_config=configure_viktor(),  # routes the run to Viktor and turns SDK tracing off
    )
    print(result.final_output)


asyncio.run(main())
```

`configure_viktor()` returns a `RunConfig(model_provider=ViktorProvider())`. To put a single agent on
Viktor instead of the whole run, set `Agent(model=ViktorProvider().get_model())`.

**Tracing.** The SDK uploads traces to OpenAI with your OpenAI key. With only a Viktor key that upload
fails noisily on every run, so `configure_viktor()` calls `set_tracing_disabled(True)`. If you build the
provider yourself, call `agents.set_tracing_disabled(True)` too. To keep traces, pass
`configure_viktor(disable_tracing=False)` and give the SDK an OpenAI key with `set_tracing_export_api_key(...)`.

## Streaming and your own tools

```python
from agents import Agent, Runner, function_tool
from openai.types.responses import ResponseTextDeltaEvent
from viktor_openai_agents import configure_viktor


@function_tool
def get_weather(city: str) -> str:
    """Get the weather for a city."""
    return f"Sunny, 24C in {city}"


agent = Agent(name="Assistant", tools=[get_weather])
result = Runner.run_streamed(agent, "What's the weather in Berlin?", run_config=configure_viktor())
async for event in result.stream_events():
    if event.type == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
        print(event.data.delta, end="", flush=True)
```

Tool-call ids from Viktor look like `call_vk1_<thread>_…`. They are routing tokens: when the Runner
sends your tool result back, Viktor resumes the same run with its sandbox state intact. The SDK keeps
them unchanged; do not rewrite them in input filters or sessions. `thread_id_from(call_id)` gives the
Viktor thread id.

Function tools and handoffs only. Hosted tools (`WebSearchTool`, `FileSearchTool`, `CodeInterpreterTool`,
`HostedMCPTool`, `ComputerTool`, shell and patch tools…) raise a `UserError` before any request: they
run on OpenAI's servers, and Viktor already has its own web search, sandbox and integrations.

## Hand off to Viktor

```python
from agents import Agent, Runner
from viktor_openai_agents import viktor_agent

viktor = viktor_agent()  # Agent(name="Viktor", model=<Viktor>, handoff_description=…)
triage = Agent(
    name="Triage",
    model="gpt-5.4-mini",
    instructions="Answer simple questions yourself. Hand off work that needs the team's tools.",
    handoffs=[viktor],
)
result = await Runner.run(triage, "Compile last month's support tickets into a CSV.")
```

The triage model sees a `transfer_to_viktor` tool described by `VIKTOR_HANDOFF_DESCRIPTION`. Prefer a
tool call over a handoff? Use `viktor_agent().as_tool(tool_name="ask_viktor", tool_description="…")`.
`viktor_agent(provider=ViktorProvider(...), instructions=..., tools=[...])` accepts any `Agent` argument;
instructions are added to Viktor's own and do not replace its identity.

## Delegate long work to Viktor from another model

```python
from agents import Agent
from viktor_openai_agents import viktor_delegate_tool

agent = Agent(name="Boss", model="gpt-5.4-mini", tools=[viktor_delegate_tool()])
```

`delegate_to_viktor` uses Viktor's native task API instead of the chat wire: no 600 s limit, files come
back as download URLs, and `requires_action` tells the model Viktor needs an answer (it calls the tool
again with the same `thread_id`). Failures come back to the model as text, like the SDK's default tool
error handling. The key needs scopes `threads:create`, `runs:create`, `runs:read`, `messages:create`,
`files:read`. Pass `needs_approval=True` to gate each delegation through the SDK's approval flow.

## Chat Completions or Responses

| | `ViktorProvider()` (default) | `ViktorProvider(use_responses=True)` |
|---|---|---|
| SDK class | `OpenAIChatCompletionsModel` | `OpenAIResponsesModel` |
| Long silent work | Viktor sends keep-alives, so proxies keep the stream open | The stream can be byte-silent for minutes |
| Tool loops | Resume the same Viktor thread (routed tool ids) | Same |
| Plain multi-turn chat | Each turn replays the history into a fresh Viktor run | `previous_response_id` resumes the same thread: `Runner.run(agent, text, previous_response_id=result.last_response_id)` or `auto_previous_response_id=True` |

The default is Chat Completions because a Viktor turn often works silently for minutes and only that
wire carries keep-alives. Choose Responses when sandbox continuity across chat turns matters more; the
response id is Viktor's durable thread id.

## Images

Pass `input_image` parts with an `https` or `data:` URL. Viktor accepts jpeg, png, gif and webp, at
most 10 per request. The model raises `ViktorInvalidRequestError` for anything else before sending,
because Viktor would silently skip the image.

## Errors

The SDK lets provider errors propagate out of `Runner.run` unwrapped (you normally catch
`openai.APIStatusError`). This package raises the typed Viktor error instead, with the `openai` error
chained as `__cause__`. All of them subclass `ViktorError` and carry `status`, `request_id` and `detail_code`.

| Situation | Raised | Retried |
|---|---|---|
| The Viktor run failed (HTTP 502 `run_failed`, an error frame mid-stream, `response.failed`) | `ViktorRunFailedError` with Viktor's message | Never automatically. The run was billed and may have acted; the model's retry advice marks it replay-unsafe |
| 200 with no text and no tool calls | warning on the `viktor` logger; `ViktorEmptyReplyError` with `strict_empty_reply=True` | Your choice |
| Bad, expired or under-scoped key; key owner without a linked Slack/Teams identity | `ViktorAuthError` with a fix hint | No |
| Rate limit, concurrency (8 runs per key), credits | `ViktorRateLimitError` with `retry_after_seconds` | Only if you set `ModelSettings(retry=ModelRetrySettings(...))`; the advice carries `retry_after` |
| Hosted tool on a Viktor agent; `api_key` together with `openai_client` | `agents.exceptions.UserError` | No |
| Truncated reply (`finish_reason: "length"`, Viktor's 600 s cap) | not an error: the partial text is the final output (the SDK has no finish-reason field); an empty truncated reply is the SDK's `ModelBehaviorError` | No |

The `openai` client is built with `max_retries=0` so nothing replays a Viktor run behind your back.

## Settings

```python
from viktor_openai_agents import ViktorProvider

provider = ViktorProvider(
    api_key=None,  # default: VIKTOR_API_KEY
    base_url=None,  # default: VIKTOR_BASE_URL or https://api.viktor.com
    use_responses=False,  # see "Chat Completions or Responses"
    strict_empty_reply=False,  # raise ViktorEmptyReplyError instead of warning
    openai_client=None,  # bring your own AsyncOpenAI (not with api_key / base_url)
)
```

Good to know: every model name resolves to Viktor and the wire model id is always `viktor`; the client
timeout is 660 s, above Viktor's 600 s run cap; `temperature` and `max_tokens` are best effort;
reasoning is not streamed; structured `output_type` works through `response_format`.

## MCP recipe

Viktor's hosted MCP server works with the SDK's own client, no package needed:

```python
from agents.mcp import MCPServerStreamableHttp

async with MCPServerStreamableHttp(
    name="viktor",
    params={"url": "https://api.viktor.com/mcp", "headers": {"Authorization": f"Bearer {key}"}, "timeout": 30},
    client_session_timeout_seconds=660,
    cache_tools_list=True,
) as viktor_mcp:
    agent = Agent(name="Boss", mcp_servers=[viktor_mcp])
```

## Example and tests

`examples/python/openai-agents/main.py` streams an agent with one function tool;
`VIKTOR_EXAMPLE_OFFLINE=1` replays recorded fixtures without a network. The tests replay the shared
fixtures through `Runner.run` and `Runner.run_streamed`; the live smoke test runs when `VIKTOR_API_KEY`
is set.

Tested against `openai-agents` 0.22.3 and `openai` 3.16.2 on 2026-09-20.
