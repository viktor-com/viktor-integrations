# ADR-0004: Tier 1 is six frameworks; everything else is reached through protocol surfaces

Status: proposed (2026-09-20), pending the maintainers' sign-off on one close call

## Context

`docs/research/framework-selection.md` scores 17 frameworks and 6 protocol-level surfaces on reach,
featuring path, extension-API stability, build cost and shared-core leverage, with dated numbers.

## Decision

- Tier 1 (native package + featuring kit): Vercel AI SDK, LangChain/LangGraph Python,
  LangChain/LangGraph JS, Pydantic AI, Mastra, OpenAI Agents SDK (Python and JS).
- Tier 2 (built once): hosted MCP server listings + stdio bridge + recipes, OpenAI/Anthropic-compatible
  recipes, models.dev entry, LiteLLM `providers.json` entry, ACP (Zed Agent Client Protocol) stdio
  agent, listing-only pages for ADK, Haystack and CrewAI. A2A is deferred behind a backend decision.
- Tier 3 (skip): AutoGen, Semantic Kernel, Microsoft Agent Framework (revisit with NuGet data), AG2,
  smolagents, DSPy, native LlamaIndex / CrewAI / Haystack providers.
- First integration to take end to end in M2: **Vercel AI SDK**, because it scores highest and its
  provider object is reused by the Mastra and OpenAI Agents JS adapters.

## Close call

Google ADK (72) outscores OpenAI Agents SDK (65). OpenAI Agents SDK stays in Tier 1 because it is
the reference handoff framework, its default wire (Responses) is where Viktor has real thread
continuity, and its JS adapter is nearly free on top of the AI SDK provider. ADK maintainers route
third-party providers to a standalone package plus a catalog page, and ADK's best Viktor story is
MCP + A2A, both Tier 2. Swapping the two costs about the same.

## Consequences

Seven small packages on two cores, four data or docs artifacts, one stdio bridge, one ACP shim.
