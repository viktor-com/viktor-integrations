# Viktor for the OpenAI Agents SDK (JavaScript)

Use [Viktor](https://viktor.com), the AI employee, in the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/):
as the model behind an agent, as a **handoff target**, and as a tool other agents delegate to.

Viktor is an agent, not a bare LLM. Each turn runs Viktor with its own tools (code sandbox, files, the
team's connected integrations) next to the function tools you pass. A turn can take minutes.

## 60-second quickstart

```bash
npm install @viktor/openai-agents @openai/agents zod
export VIKTOR_API_KEY=zt_live_sk_...   # Viktor → Settings → API keys, scope chat:completions
```

```ts
import { Agent, run } from "@openai/agents";
import { configureViktor } from "@viktor/openai-agents";

configureViktor(); // Viktor becomes the default model; OpenAI trace uploads are turned off

const agent = new Agent({ name: "Assistant", instructions: "Be brief." });
const result = await run(agent, "Summarise what changed in our #releases channel this week.");
console.log(result.finalOutput);
```

Tracing: the SDK uploads traces to OpenAI with an OpenAI key. With a Viktor key that upload fails, so
`configureViktor()` calls `setTracingDisabled(true)`. Pass `{ keepTracing: true }` if you export traces
elsewhere.

## Hand off to Viktor

```ts
import { Agent, run } from "@openai/agents";
import { viktorAgent } from "@viktor/openai-agents";

const triage = new Agent({
  name: "Triage",
  instructions: "Answer simple questions yourself. Hand off anything that needs the team's systems.",
  handoffs: [viktorAgent()],
});
const result = await run(triage, "Pull last week's churned accounts from the CRM and draft outreach.");
console.log(result.lastAgent?.name, result.finalOutput);
```

`viktorAgent()` also works as a tool: `viktorAgent().asTool({ toolName: "ask_viktor", toolDescription: "…" })`.

## Your function tools, streaming

```ts
import { Agent, run, tool } from "@openai/agents";
import { viktorModel } from "@viktor/openai-agents";
import { z } from "zod";

const getWeather = tool({
  name: "get_weather",
  description: "Get the weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny, 24C in ${city}`,
});
const agent = new Agent({ name: "Assistant", model: viktorModel(), tools: [getWeather] });
const stream = await run(agent, "What's the weather in Berlin?", { stream: true });
for await (const text of stream.toTextStream()) process.stdout.write(text);
await stream.completed;
```

Tool-call ids from Viktor look like `call_vk1_<thread>_…`. They are routing tokens: when the SDK sends
your tool output back, Viktor resumes the same run with its sandbox state intact. They pass through
unchanged. Hosted tools (`webSearchTool()`, file search, code interpreter, hosted MCP) are rejected
up front with a `UserError`, because Viktor cannot execute them; Viktor has its own equivalents.

## Delegate long work from any agent

```ts
import { Agent } from "@openai/agents";
import { viktorDelegateTool } from "@viktor/openai-agents";

const agent = new Agent({ name: "Planner", model: "gpt-5.2", tools: [viktorDelegateTool()] });
```

`delegate_to_viktor` uses Viktor's task API: no 600 s limit, files come back as download URLs, and
`requires_action` tells the model Viktor needs an answer (call again with the same `thread_id`).
The key needs scopes `threads:create`, `runs:create`, `runs:read`, `messages:create`, `files:read`.

## Errors

| Situation | Error | Retry advice given to the SDK |
|---|---|---|
| The Viktor run failed (HTTP 502 `run_failed`, or an error frame mid-stream) | `ViktorRunFailedError` with Viktor's message | never (`replaySafety: "unsafe"`): the run was billed and may have acted |
| 200 with no text and no tool calls | warning; `ViktorEmptyReplyError` with `viktorModel({ strictEmptyReply: true })` | your choice |
| Bad or under-scoped key; key owner without a linked Slack/Teams identity | `ViktorAuthError` with `detailCode` and a fix hint | no |
| Rate limit, concurrency (8 runs per key), credits | `ViktorRateLimitError` with `retryAfterSeconds` | yes, after `Retry-After` |

## MCP instead of a model

```ts
import { MCPServerStreamableHttp } from "@openai/agents";
const viktorMcp = new MCPServerStreamableHttp({
  name: "viktor",
  url: "https://api.viktor.com/mcp",
  requestInit: { headers: { Authorization: `Bearer ${process.env.VIKTOR_API_KEY}` } },
});
```

Settings (`apiKey`, `baseURL`, `strictEmptyReply`, `timeoutMs`, `fetch`) are the same as in
`@viktor/ai-sdk-provider`, which this package builds on through the SDK's `aisdk()` bridge.
Good to know: the model id is always `viktor`; instructions are added to Viktor's own and do not
replace its identity; sampling settings are best effort.

Known limitation (checked live 2026-09-21): forcing a tool (`tool_choice` `required` or a named tool) makes the Viktor run fail, because Viktor's current backing model rejects it. Leave tool choice on `auto`.

Tested against `@openai/agents` 0.18.0 and `@openai/agents-extensions` 0.18.0 on 2026-09-20.
