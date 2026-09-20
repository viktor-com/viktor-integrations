# Viktor for Mastra

Use [Viktor](https://viktor.com), the AI employee, in [Mastra](https://mastra.ai): as the model behind an
agent, as a sub-agent a supervisor delegates to, and as a tool.

Viktor is an agent, not a bare LLM. Each turn runs Viktor with its own tools (code sandbox, files, the
team's connected integrations) next to the tools you pass. A turn can take minutes.

## 60-second quickstart

```bash
npm install @viktor/mastra @mastra/core zod
export VIKTOR_API_KEY=zt_live_sk_...   # Viktor → Settings → API keys, scope chat:completions
```

```ts
import { Agent } from "@mastra/core/agent";
import { viktorModel } from "@viktor/mastra";

const agent = new Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "Be brief.",
  model: viktorModel(),
});
const result = await agent.generate("Summarise what changed in our #releases channel this week.");
console.log(result.text);
```

Streaming (`agent.stream(...)`) and your own `createTool` tools work as usual. Tool-call ids from Viktor
look like `call_vk1_<thread>_…`; they are routing tokens that let Viktor resume the same run when the
tool result comes back, and they pass through unchanged.

## Viktor as a sub-agent of a supervisor

```ts
import { Agent } from "@mastra/core/agent";
import { viktorAgent } from "@viktor/mastra";

const supervisor = new Agent({
  id: "supervisor",
  name: "Supervisor",
  instructions: "Plan the work. Delegate anything that needs the team's systems to Viktor.",
  model: "openai/gpt-5.2",
  agents: { viktor: viktorAgent() },
});
```

## Delegate long work as a tool

```ts
import { viktorDelegateTool } from "@viktor/mastra";

const agent = new Agent({ id: "planner", name: "Planner", instructions: "…", model: "openai/gpt-5.2",
  tools: { delegate_to_viktor: viktorDelegateTool() } });
```

`delegate_to_viktor` uses Viktor's task API: no 600 s limit, files come back as download URLs, and
`requires_action` tells the model Viktor needs an answer (call again with the same `thread_id`).
The key needs scopes `threads:create`, `runs:create`, `runs:read`, `messages:create`, `files:read`.

## Config-only model

Where Mastra needs a plain config object, use the model router form. It reaches the same endpoint
without the Viktor-specific error handling that `viktorModel()` adds:

```ts
import { viktorModelConfig } from "@viktor/mastra";
const model = viktorModelConfig(); // { id: "viktor/viktor", url: "https://api.viktor.com/api/compat/v1", apiKey }
```

## Errors

Errors from `viktorModel()` carry a typed Viktor error in the `cause` chain:
`ViktorRunFailedError` (the run failed; it is never retried because it was billed and may have acted),
`ViktorAuthError` (with a fix hint), `ViktorRateLimitError` (with `retryAfterSeconds`),
`ViktorEmptyReplyError` (only with `viktorModel({ strictEmptyReply: true })`; a warning otherwise).

## MCP instead of a model

```ts
import { MCPClient } from "@mastra/mcp";
const mcp = new MCPClient({ servers: { viktor: {
  url: new URL("https://api.viktor.com/mcp"),
  requestInit: { headers: { Authorization: `Bearer ${process.env.VIKTOR_API_KEY}` } },
} } });
```

Settings (`apiKey`, `baseURL`, `strictEmptyReply`, `timeoutMs`, `fetch`) are the same as in
`@viktor/ai-sdk-provider`, which this package builds on. Good to know: the model id is always `viktor`;
instructions are added to Viktor's own and do not replace its identity; sampling settings are best effort.

Tested against `@mastra/core` 1.67.0 on 2026-09-20.
