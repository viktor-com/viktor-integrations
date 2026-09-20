# Viktor for Pydantic AI

Use [Viktor](https://viktor.com), the AI employee, from [Pydantic AI](https://ai.pydantic.dev): as the
model behind an `Agent`, and as a tool your own agent can delegate work to.

Viktor is an agent, not a bare LLM. Each call runs Viktor with its own tools (code sandbox, files,
the team's connected integrations) next to the tools you pass. A turn can take minutes and may act on
connected systems.

## 60-second quickstart

```bash
pip install pydantic-ai-viktor
export VIKTOR_API_KEY=zt_live_sk_...   # Viktor → Settings → API keys, scope chat:completions
```

```python
from pydantic_ai import Agent
from pydantic_ai_viktor import ViktorModel

agent = Agent(ViktorModel())
result = agent.run_sync("Summarise what changed in our #releases channel this week.")
print(result.output)
```

`ViktorModel()` is Pydantic AI's own `OpenAIChatModel('viktor', provider=ViktorProvider())` plus Viktor's
error diagnosis. The provider is written like the in-tree OpenAI-compatible providers, so both forms work:

```python
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai_viktor import ViktorProvider

agent = Agent(OpenAIChatModel("viktor", provider=ViktorProvider()))  # works today
agent = Agent("viktor:viktor")  # works once the in-tree provider lands in Pydantic AI
```

## Streaming and your own tools

```python
from pydantic_ai import Agent
from pydantic_ai_viktor import ViktorModel

agent = Agent(ViktorModel(), instructions="Answer in one line.")


@agent.tool_plain
def get_weather(city: str) -> str:
    """Get the weather for a city."""
    return f"Sunny, 24C in {city}"


async def main():
    async with agent.run_stream_events("What's the weather in Berlin?") as events:
        async for event in events:
            print(event)
```

Use `run_stream_events()` or `agent.iter()` when you pass tools: Viktor often says a few words before it
calls a tool, and `run_stream()` treats that first text as the final answer.

Tool-call ids from Viktor look like `call_vk1_<thread>_…`. They are routing tokens: when Pydantic AI sends
your tool result back, Viktor resumes the same run with its sandbox state intact. Pydantic AI passes them
through unchanged; do not rewrite them in a history processor. `viktor_thread_id(response)` gives the
thread behind any `ModelResponse`; non-streamed responses also carry it in
`response.provider_details["viktor_thread_id"]`.

Plain multi-turn chat on Chat Completions replays the history into a fresh run each turn. For continuity use
the Responses API, where Viktor's response id is the thread id:

```python
from pydantic_ai.models.openai import OpenAIResponsesModelSettings
from pydantic_ai_viktor import ViktorModel, viktor_responses_model

agent = Agent(
    ViktorModel(viktor_responses_model()),
    model_settings=OpenAIResponsesModelSettings(openai_previous_response_id="auto"),
)
```

Chat Completions stays the default because only that wire sends keep-alives during Viktor's long silences.

## Delegate work to Viktor from another model

```python
from pydantic_ai import Agent
from pydantic_ai_viktor import ViktorToolset

agent = Agent("openai:gpt-5.2", toolsets=[ViktorToolset()])
result = agent.run_sync("Ask Viktor to compile last month's support tickets into a CSV, then name the top 3 themes.")
```

`ViktorToolset` has one tool, `delegate_to_viktor`, with the name, description and JSON schema shared by
every Viktor integration. It uses Viktor's native task API: no 600 s limit, files come back as download
URLs, and `requires_action` tells the model Viktor needs an answer (call again with the same `thread_id`).
The key needs scopes `threads:create`, `runs:create`, `runs:read`, `messages:create`, `files:read`.

For [agent delegation](https://ai.pydantic.dev/multi-agent-applications/), `viktor_agent()` returns an
`Agent` named `viktor` that runs on `ViktorModel`:

```python
from pydantic_ai import Agent, RunContext
from pydantic_ai_viktor import viktor_agent

viktor = viktor_agent(instructions="Be brief.")
lead = Agent("anthropic:claude-sonnet-4-5")


@lead.tool
async def ask_viktor(ctx: RunContext[None], task: str) -> str:
    """Ask Viktor, who can work in the team's tools."""
    return (await viktor.run(task, usage=ctx.usage)).output
```

## Images

Pass `ImageUrl("https://…")` or `BinaryContent(data, media_type="image/png")` in the prompt list; they reach
Viktor as `image_url` parts. Viktor accepts jpeg, png, gif and webp, at most 10 per request, and fetches
URLs over https only. `ViktorModel` raises `UserError` for anything else (and for documents, audio and
video) before the request is sent, because Viktor would silently skip them.

## Errors

`ViktorModel` raises the exceptions Pydantic AI users already catch, with Viktor's diagnosis as the message
and a typed Viktor error on `__cause__`:

| Situation | Raised | `__cause__` | Retried automatically |
|---|---|---|---|
| The Viktor run failed (HTTP 502 `run_failed`) | `ModelHTTPError` | `ViktorRunFailedError` with Viktor's message and request id | No. The run was billed and may have acted |
| An error frame in the middle of a stream | `ModelAPIError` | `ViktorRunFailedError` | No |
| 200 with no text and no tool calls | `UserWarning`, then Pydantic AI asks again (a new run); with `ViktorModel(strict_empty_reply=True)` an `UnexpectedModelBehavior` | `ViktorEmptyReplyError` | Your choice |
| Bad, expired or under-scoped key; key owner without a linked Slack/Teams identity | `ModelHTTPError` (401/403) with a fix hint | `ViktorAuthError` with `detail_code` | No |
| Rate limit, concurrency (8 runs per key), credits | `ModelHTTPError` (429); `error.headers["retry-after"]` | `ViktorRateLimitError` with `retry_after_seconds` | No; wait `retry_after_seconds` |
| Unsupported image or file | `UserError` | `ViktorInvalidRequestError` | n/a |
| `finish_reason == "length"` | not an error; Viktor hit its 600 s cap or the output limit | | n/a |

```python
import asyncio

from pydantic_ai.exceptions import ModelHTTPError
from viktor_integrations_core import ViktorRateLimitError

try:
    result = await agent.run("…")
except ModelHTTPError as error:
    if isinstance(error.__cause__, ViktorRateLimitError):
        await asyncio.sleep(error.__cause__.retry_after_seconds or 5)
```

The OpenAI client is created with `max_retries=0`, so nothing is retried behind your back. Without
`ViktorModel` (plain `OpenAIChatModel` + `ViktorProvider`) you get Pydantic AI's stock `ModelHTTPError`, and
an in-stream error frame surfaces as a raw `openai.APIError`.

## Settings

```python
from pydantic_ai_viktor import ViktorModel, ViktorProvider

ViktorProvider(
    api_key=None,  # default: VIKTOR_API_KEY
    base_url=None,  # host only; default: VIKTOR_BASE_URL, else https://api.viktor.com
    http_client=None,  # your own httpx2.AsyncClient (proxies, tests)
)  # or ViktorProvider(openai_client=AsyncOpenAI(...))
ViktorModel(provider=None, strict_empty_reply=False)  # or ViktorModel(viktor_responses_model(provider))
```

The client timeout is 660 s (above Viktor's 600 s run cap) and `max_retries` is 0; pass `openai_client` to
change either. Good to know: the model id is always `viktor`; instructions and system prompts are added to
Viktor's own instructions and do not replace its identity; `temperature` and `max_tokens` are best effort;
reasoning is not returned; tool definitions are sent without `strict`; `NativeOutput` maps to Viktor's
`json_schema` response format (a schema Viktor cannot satisfy is a 422 with `ViktorStructuredOutputError`
on `__cause__`).

## MCP

Viktor also hosts an MCP server; no package needed:

```python
import os

from pydantic_ai import Agent
from pydantic_ai.mcp import MCPToolset

viktor_mcp = MCPToolset(
    "https://api.viktor.com/mcp", headers={"Authorization": f"Bearer {os.environ['VIKTOR_API_KEY']}"}
)
agent = Agent("openai:gpt-5.2", toolsets=[viktor_mcp.prefixed("viktor")])
```

## Example and tests

`examples/python/pydantic-ai/main.py` streams a run with one local tool; `VIKTOR_EXAMPLE_OFFLINE=1`
replays recorded fixtures without a network. The test suite replays the repo's shared fixtures through
`Agent.run`, `run_stream` and `iter`; the live smoke test runs when `VIKTOR_API_KEY` is set.

Tested against `pydantic-ai-slim` 2.46.0 and `openai` 3.16.2 (httpx2 2.13.0) on 2026-09-20.
