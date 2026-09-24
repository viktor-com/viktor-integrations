# ADR-0003: Continuation is thread resume via routed tool ids, with stateless replay as fallback

Status: accepted (2026-09-20)

## Context

How a Viktor run continues after a caller-side tool result:

- A call to one of your tools ends the run: the stream closes with `finish_reason: "tool_calls"`.
  There is no deadline for sending the tool result back.
- Tool-call ids are routing tokens: `call_vk1_<thread>_<c|t|b>_<suffix>` on OpenAI wires,
  `toolu_vk1_…` on the Anthropic wire. They embed the Viktor thread id.
- A follow-up request whose trailing `tool` messages all carry ids of one thread started with the same API
  key's owner RESUMES that thread: Viktor continues the same run with its earlier work intact, and only the
  trailing tool results are read from the request. A thread started by anyone else is refused (404
  `not_found`), never resumed.
- Otherwise (ids rewritten, no trailing tool messages, plain multi-turn chat) Viktor starts a fresh
  thread and replays the whole message array as history. Correct, but each turn starts over.
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
- Where a framework exposes the Responses API natively (OpenAI Agents SDK, LangChain
  `use_responses_api`, Pydantic AI `OpenAIResponsesModel`), adapters offer it as an option and pass
  `previous_response_id` so plain multi-turn chat also keeps thread continuity. Chat Completions
  stays the default because it is the only wire with keepalives (amended 2026-09-20 after M3).
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
