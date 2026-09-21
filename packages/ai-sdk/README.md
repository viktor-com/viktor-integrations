# Viktor provider for the Vercel AI SDK

Use [Viktor](https://viktor.com), the AI employee, from the [AI SDK](https://ai-sdk.dev): as a
language model for `generateText` / `streamText` / agents, and as a tool your own agent can
delegate work to.

Viktor is an agent, not a bare LLM. Each call runs Viktor with its own tools (code sandbox, files,
the team's connected integrations) next to the tools you pass. A turn can take minutes.

## 60-second quickstart

```bash
npm install @viktor/ai-sdk-provider ai
export VIKTOR_API_KEY=zt_live_sk_...   # Viktor → Settings → API keys, scope chat:completions
```

```ts
import { generateText } from "ai";
import { viktor } from "@viktor/ai-sdk-provider";

const { text } = await generateText({
  model: viktor(),
  prompt: "Summarise what changed in our #releases channel this week.",
});
console.log(text);
```

## Streaming and your own tools

```ts
import { streamText, tool, isStepCount } from "ai";
import { viktor } from "@viktor/ai-sdk-provider";
import { z } from "zod";

const result = streamText({
  model: viktor(),
  tools: {
    get_weather: tool({
      description: "Get the weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny, 24C in ${city}`,
    }),
  },
  stopWhen: isStepCount(5),
  prompt: "What's the weather in Berlin? Answer in one line.",
});
for await (const delta of result.textStream) process.stdout.write(delta);
```

Tool-call ids from Viktor look like `call_vk1_<thread>_…`. They are routing tokens: when the AI SDK
sends your tool result back, Viktor resumes the same run with its sandbox state intact. The provider
passes them through unchanged; do not rewrite them. The thread id is on
`result.providerMetadata.viktor.threadId`.

## Delegate work to Viktor from another model

```ts
import { generateText, isStepCount } from "ai";
import { viktorDelegate } from "@viktor/ai-sdk-provider";

const result = await generateText({
  model: yourModel,
  tools: { delegate_to_viktor: viktorDelegate() },
  stopWhen: isStepCount(4),
  prompt: "Ask Viktor to compile last month's support tickets into a CSV and tell me the top 3 themes.",
});
```

`viktorDelegate()` uses Viktor's native task API: no 600 s limit, files come back as download URLs,
and `requires_action` tells the model Viktor needs an answer (call again with the same `thread_id`).
The key needs scopes `threads:create`, `runs:create`, `runs:read`, `messages:create`, `files:read`.

## Images

Pass images as `file` parts with an image media type. `https` URLs are fetched by Viktor; anything
else is inlined by the AI SDK. Viktor accepts jpeg, png, gif and webp, at most 10 per request.
The provider rejects other files and an 11th image up front, because Viktor would silently skip them.

## Errors

HTTP failures are `APICallError`s, as everywhere in the AI SDK, with a typed Viktor error on `cause`:

| Situation | `error.cause` | Retried by the AI SDK |
|---|---|---|
| The Viktor run failed (HTTP 502 `run_failed`, or an error frame mid-stream) | `ViktorRunFailedError` with Viktor's message | No. The run was billed and may have acted |
| 200 with no text and no tool calls (stream ended before output) | warning on the result; `ViktorEmptyReplyError` with `createViktor({ strictEmptyReply: true })` | Your choice |
| Bad, expired or under-scoped key; key owner without a linked Slack/Teams identity | `ViktorAuthError` with `detailCode` and a fix hint | No |
| Rate limit, concurrency (8 runs per key), credits | `ViktorRateLimitError` with `retryAfterSeconds` | Yes |
| `finishReason: "length"` | not an error; `providerMetadata.viktor.runCapReached` is `true` when Viktor hit its 600 s cap | n/a |

In streams, a failed run arrives as an `error` part carrying `ViktorRunFailedError`.

## Settings

```ts
import { createViktor } from "@viktor/ai-sdk-provider";

const viktor = createViktor({
  apiKey: process.env.VIKTOR_API_KEY,        // default
  baseURL: "https://api.viktor.com",         // default; or VIKTOR_BASE_URL
  strictEmptyReply: false,
  timeoutMs: 660_000,
});
```

Good to know: the model id is always `viktor`; system prompts are added to Viktor's own instructions
and do not replace its identity; `temperature` and `maxOutputTokens` are best effort; reasoning is
not streamed. Plain multi-turn chat replays the history into a fresh run each turn.

## Also works with

- **OpenAI Agents SDK (JS):** `aisdk(viktor())` from `@openai/agents-extensions/ai-sdk`.
- **Mastra:** `new Agent({ model: viktor(), … })`.
- **MCP:** `createMCPClient({ transport: { type: "http", url: "https://api.viktor.com/mcp", headers: { Authorization: `Bearer ${key}` } } })`.

Known limitation (checked live 2026-09-21): forcing a tool (`tool_choice` `required` or a named tool) makes the Viktor run fail, because Viktor's current backing model rejects it. Leave tool choice on `auto`.

Tested against `ai` 7.0.x and `@ai-sdk/openai-compatible` 3.0.x on 2026-09-20.
