# ADR-0005: Adapters wrap the framework's own OpenAI-compatible classes

Status: accepted (2026-09-20)

## Context

Every Tier 1 framework ships a maintained OpenAI-compatible chat model (`@ai-sdk/openai-compatible`,
`BaseChatOpenAI`, `OpenAIChatModel` + `Provider`, `OpenAIProvider`, Mastra's model router).
Re-implementing message conversion and stream assembly per framework would multiply our exposure to
upstream spec churn (the AI SDK provider spec had two majors in 12 months).

## Decision

- A Viktor chat model is the upstream compatible class, configured with Viktor defaults (base URL,
  key from `VIKTOR_API_KEY`, model `viktor`, long timeouts) and wrapped with a thin layer that adds:
  Viktor error mapping, empty-reply detection, client-side image validation, thread-id metadata, and
  rejection of unsupported options (`n > 1`, hosted tools).
- The wrapper uses the framework's sanctioned extension point: `wrapLanguageModel` middleware (AI SDK),
  subclass overrides (`ChatViktor`), `Provider` subclass (Pydantic AI), `ModelProvider` (OpenAI Agents).
- The core's own SSE parser is used by the core's tests, the delegate tool, the MCP bridge and the live
  contract tests, and as the reference when an upstream parser mishandles a Viktor frame.

## Consequences

- Upstream absorbs provider-spec majors; we bump a peer range.
- Behaviour differences between upstream parsers (for example how each treats the in-stream error
  frame) are caught by the shared fixtures, which every adapter must pass.
- If an upstream class drops or breaks tool-id pass-through, the adapter falls back to the core client
  behind the same public class.
