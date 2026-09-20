# ADR-0003: Continuation is thread resume via routed tool ids, with stateless replay as fallback

Status: accepted (2026-09-20)

## Context

How a Viktor compat run continues after a caller-side tool result
(`the Viktor API contract` §2.5, §3, §11):

- A caller-tool call ENDS the run: the thread goes idle, the stream closes with
  `finish_reason: "tool_calls"`, and the concurrency slot is released. Nothing waits
  server-side; there is no timeout on how long the caller may take to answer.
- Tool-call ids are routing tokens: `call_vk1_<thread>_<c|t|b>_<suffix>` on OpenAI wires,
  `toolu_vk1_…` on the Anthropic wire. They embed the durable thread id.
- Follow-up request with trailing `tool` messages whose ids all decode to one thread
  the actor created: the durable thread is RESUMED. Only the trailing tool results are
  consumed; earlier messages in the request are ignored. Sandbox state and server-side
  tool results stay intact.
- Otherwise (ids rewritten, no trailing tool messages, plain multi-turn chat): a FRESH
  thread is created and the whole message array is replayed as history. Correct, but
  every turn re-runs the agent from scratch and loses sandbox continuity.
- Responses API: the response `id` IS the thread id; `previous_response_id` resumes it
  and only the new `input` is seeded.
- `tools` must be re-declared on every request, including resume turns.

## Decision

- Adapters model Viktor as an ordinary OpenAI/Anthropic-style chat model: the
  framework owns the message history and resends it. No adapter introduces a
  Viktor-specific session object for the chat-model abstraction.
- Adapters MUST pass tool-call ids through unchanged in both directions. Each adapter's
  tests assert id round-tripping, because a framework that regenerates ids silently
  degrades to stateless replay.
- Adapters MUST emit assistant `tool_calls` followed by the matching `tool` results as
  the trailing messages of the follow-up request, and MUST re-send the tool
  declarations on every request.
- Where a framework exposes the Responses API natively (OpenAI Agents SDK, Vercel AI
  SDK `openai.responses`, LangChain `use_responses_api`), adapters prefer it and pass
  `previous_response_id` so plain multi-turn chat also keeps thread continuity.
- The "delegate to Viktor" tool (a different abstraction from the chat model) uses the
  native REST thread id for explicit thread reuse, never tool ids.
- The core exposes a helper that extracts the thread id from a routed tool id or
  Responses id, so adapters can surface it (metadata, logs) without parsing.

## Consequences

- Tool loops work in every framework with continuity and no extra state.
- Multi-turn chat on Chat Completions or Anthropic wires without tools is a replay per
  turn; adapter READMEs say so and point to the Responses path for continuity.
- Frameworks that truncate or summarise history still work, at the cost of a replay
  from the truncated history when no routed ids are present.
- Backend gap recorded for the maintainers: a pause/live-hold would need worker changes
  (backend work); not required for any adapter.
