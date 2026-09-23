# @viktor-com/langchain

Use [Viktor](https://viktor.com), the AI employee, from [LangChain.js](https://docs.langchain.com/oss/javascript/langchain/overview)
and [LangGraph.js](https://docs.langchain.com/oss/javascript/langgraph/overview): as a chat model
(`ChatViktor`) for `createAgent` and your own graphs, as a tool your own agent can delegate work to,
and as a handoff target in a multi-agent graph.

Viktor is an agent, not a bare LLM. Each call runs Viktor with its own tools (code sandbox, files,
the team's connected integrations) next to the tools you bind. A turn can take minutes and may act
on connected systems.

## 60-second quickstart

```bash
npm install @viktor-com/langchain @langchain/core @langchain/openai
export VIKTOR_API_KEY=zt_live_sk_...   # Viktor → Settings → API keys, scope chat:completions
```

```ts
import { ChatViktor } from "@viktor-com/langchain";

const model = new ChatViktor();
const reply = await model.invoke("Summarise what changed in our #releases channel this week.");
console.log(reply.text);
```

`ChatViktor` extends `ChatOpenAI`, so everything you know from it works: `invoke`, `stream`,
`bindTools`, `withStructuredOutput`, callbacks, LangSmith tracing (`ls_provider: "viktor"`).

## Streaming and your own tools

```ts
import { AIMessageChunk } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { ChatViktor } from "@viktor-com/langchain";
import { z } from "zod";

const getWeather = tool(async ({ city }) => `Sunny, 24C in ${city}`, {
  name: "get_weather",
  description: "Get the weather for a city",
  schema: z.object({ city: z.string() }),
});

const agent = createAgent({ model: new ChatViktor(), tools: [getWeather] });
const stream = await agent.stream(
  { messages: [{ role: "user", content: "What's the weather in Berlin? Answer in one line." }] },
  { streamMode: "messages" },
);
for await (const [message] of stream) {
  if (AIMessageChunk.isInstance(message)) process.stdout.write(message.text);
}
```

Tool-call ids from Viktor look like `call_vk1_<thread>_…`. They are routing tokens: when LangChain
sends the `ToolMessage` back, Viktor resumes the same run with its sandbox state intact. `ChatViktor`
passes them through unchanged; keep the `AIMessage` with its `tool_calls` and the `ToolMessage`s as
the last messages of the follow-up, and do not rewrite the ids. The thread id is on
`message.response_metadata.viktor_thread_id`.

Prefer `stream()` (or `new ChatViktor({ streaming: true })`) for long tasks: Viktor sends keep-alives
on the streaming wire, while Node's built-in `fetch` gives up after 300 s without response headers.

## Multi-turn chat that keeps Viktor's thread (Responses API)

On Chat Completions a plain multi-turn chat replays the history into a fresh Viktor run each turn.
With the Responses API the response id *is* Viktor's durable thread id, so `previous_response_id`
continues the same thread, sandbox included:

```ts
const model = new ChatViktor({ useResponsesApi: true });
const first = await model.invoke("Clone our docs repo and count the markdown files.");
const next = await model.invoke("Now list the five largest.", {
  previous_response_id: first.response_metadata.viktor_thread_id,
});
```

## Delegate work to Viktor from another model

```ts
import { createAgent } from "langchain";
import { viktorDelegateTool } from "@viktor-com/langchain";

const agent = createAgent({ model: "openai:gpt-5", tools: [viktorDelegateTool()] });
await agent.invoke({
  messages: [{ role: "user", content: "Ask Viktor to compile last month's support tickets into a CSV and tell me the top 3 themes." }],
});
```

`viktorDelegateTool()` (tool name `delegate_to_viktor`) uses Viktor's native task API: no 600 s limit,
files come back as download URLs, and `requires_action` tells the model Viktor needs an answer (call
again with the same `thread_id`). The model reads a text summary; the full result object is the
`ToolMessage.artifact`. The key needs scopes `threads:create`, `runs:create`, `runs:read`,
`messages:create`, `files:read`.

## LangGraph: Viktor as an agent and handoff target

```ts
import { MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { createViktorAgent, createViktorHandoffTool } from "@viktor-com/langchain/langgraph";

const triage = createAgent({ model: "openai:gpt-5", tools: [createViktorHandoffTool()] }); // transfer_to_viktor
const graph = new StateGraph(MessagesAnnotation)
  .addNode("triage", triage.graph, { ends: ["viktor"] })
  .addNode("viktor", createViktorAgent().graph)
  .addEdge(START, "triage")
  .compile();
```

The handoff tool returns `new Command({ goto: "viktor", graph: Command.PARENT, update: { messages } })`.
`createViktorAgent({ model?, tools?, ...createAgentParams })` is `createAgent` with a `ChatViktor`.
This entry point needs the optional peers `@langchain/langgraph` and `langchain`.

## Images

Use standard image blocks (`{ type: "image", source_type: "url" | "base64", … }`) or OpenAI-style
`image_url` parts. `https` URLs are fetched by Viktor; base64 data is sent as a data URL. Viktor
accepts jpeg, png, gif and webp, at most 10 per request. `ChatViktor` rejects `http://` URLs, other
types, non-image files and an 11th image before the request, because Viktor would silently skip them.

## Errors

`ChatViktor` throws typed errors (all extend `ViktorError`, with `status`, `requestId`, `detailCode`
and the original `openai` SDK error on `cause`; `lc_error_code` is kept where LangChain sets one):

| Situation | Error | Retried |
|---|---|---|
| The Viktor run failed (HTTP 502 `run_failed`, or an error frame mid-stream) | `ViktorRunFailedError` with Viktor's message | Never, even with `maxRetries > 0`. The run was billed and may have acted |
| 200 with no text and no tool calls (stream ended before output) | `console.warn`; `ViktorEmptyReplyError` with `strictEmptyReply: true` | Your choice |
| Bad, expired or under-scoped key; key owner without a linked Slack/Teams identity | `ViktorAuthError` with `detailCode` and a fix hint | No |
| Rate limit, concurrency (8 runs per key), credits | `ViktorRateLimitError` with `retryAfterSeconds` | With `maxRetries > 0`, by LangChain's normal policy |
| `finish_reason: "length"` | not an error; `response_metadata.run_cap_reached` is `true` when Viktor hit its 600 s cap | n/a |

## Settings

```ts
new ChatViktor({
  apiKey: process.env.VIKTOR_API_KEY,   // default, read when a request is made
  baseURL: "https://api.viktor.com",    // default; or VIKTOR_BASE_URL. Host only: /api/compat/v1 is appended
  timeout: 660_000,                     // ms; above Viktor's 600 s run cap so the server ends the run
  maxRetries: 0,                        // every request is a billed agent run (LangChain's default is 6); run_failed is never retried
  strictEmptyReply: false,
  useResponsesApi: false,
  configuration: { fetch },             // any other OpenAI client option, e.g. a custom fetch
});
```

Good to know: the model id is always `viktor`; system prompts are added to Viktor's own instructions
and do not replace its identity; `temperature` and `maxTokens` are best effort; reasoning is not
streamed; hosted OpenAI tools (`web_search_preview`, …) are rejected, pass function tools only.

## MCP

Viktor also has a hosted MCP server. No package needed:

```ts
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const client = new MultiServerMCPClient({
  mcpServers: {
    viktor: { transport: "http", url: "https://api.viktor.com/mcp", headers: { Authorization: `Bearer ${process.env.VIKTOR_API_KEY}` } },
  },
});
const agent = createAgent({ model: "openai:gpt-5", tools: await client.getTools() });
```

Known limitation (checked live 2026-09-21): forcing a tool (`tool_choice` `required` or a named tool) makes the Viktor run fail, because Viktor's current backing model rejects it. Leave tool choice on `auto`.

Tested against `@langchain/core` 1.2.11, `@langchain/openai` 1.5.13, `@langchain/langgraph` 1.4.16 and
`langchain` 1.5.11 on 2026-09-20.
