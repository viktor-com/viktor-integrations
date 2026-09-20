# ADR-0003: Continuation is stateless replay; adapters preserve Viktor tool-call ids

Status: accepted (2026-09-20)

## Context

Viktor's compat API resumes a paused run after a caller-side tool result with a
hybrid policy:

- Live-hold: if the previous run's worker is alive and the tool result arrives within
  300 s, the paused run resumes in place.
- Stateless replay: otherwise the run is rebuilt from the full message history the
  client resends. This path is always correct; live-hold is a latency optimisation.

Routing is carried inside the tool-call id itself:
ids look like
`call_vk1_<thread>_<kind>_<suffix>` and embed the Viktor thread id. Unrecognised ids
fall back to replay.

## Decision

- Adapters model Viktor as an ordinary OpenAI/Anthropic-style chat model: the
  framework owns the message history and resends it. We do not add a Viktor-specific
  session or thread object to any model adapter.
- Adapters MUST pass tool-call ids through unchanged in both directions. Any
  framework that rewrites or regenerates ids loses the live-hold fast path; the core
  documents this and each adapter's tests assert id round-tripping.
- Adapters MUST keep assistant `tool_calls` and the matching `tool` result messages
  adjacent and complete when converting framework history back to wire messages, so
  replay reconstructs the run exactly.
- The "delegate to Viktor" tool (a different abstraction from the chat model) is the
  place for explicit thread reuse, using the native REST thread id, not tool ids.

## Consequences

- Multi-turn and tool loops work in every framework without special state.
- Latency after a tool result depends on the caller replying within 300 s; the
  README of each adapter states this.
- Frameworks that truncate or summarise history (memory modules) still work, at the
  cost of a replay from the truncated history.
