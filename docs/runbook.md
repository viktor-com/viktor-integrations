# Maintenance runbook

For the team that owns the Viktor framework integrations. Goal: keep seven adapters, two protocol shims and
the listings healthy for about one engineer-day per month.

## What exists

| Piece | Path | Depends on upstream | Lines of source |
|---|---|---|---|
| TS core | `packages/core` | `undici` | ~900 |
| Python core | `python/core` | `httpx` | ~1100 |
| Vercel AI SDK provider | `packages/ai-sdk` | `ai` ^7, `@ai-sdk/openai-compatible` ^3 | ~330 |
| LangChain.js | `packages/langchain` | `@langchain/core` ^1.2, `@langchain/openai` ^1.5, `@langchain/langgraph` ^1.4.4 (optional) | 385 |
| Mastra | `packages/mastra` | `@mastra/core` ^1.67 (through the AI SDK provider) | ~110 |
| OpenAI Agents SDK (JS) | `packages/openai-agents` | `@openai/agents` >=0.18 <1 (through the AI SDK provider) | ~150 |
| LangChain (Python) | `python/langchain` | `langchain-core` >=1.6, `langchain-openai` >=1.6 | 395 |
| Pydantic AI | `python/pydantic-ai` | `pydantic-ai-slim[openai]` >=2.40 | 394 |
| OpenAI Agents SDK (Python) | `python/openai-agents` | `openai-agents` >=0.21 | 385 |
| MCP stdio bridge | `mcp/bridge` | none | ~130 |
| ACP agent | `acp` | `@agentclientprotocol/sdk` ^1.4 | ~130 |
| Shared spec, fixtures, recipes | `spec/`, `fixtures/`, `docs/recipes/` | none | data |

Every declared range above is the lowest version that passed the full adapter suite on 2026-09-20
(`docs/evidence/upstream-matrix-2026-09-20.txt`). Widen a range only after the matrix passes on the new floor.

## Signals and what to do

| Signal | Meaning | Action |
|---|---|---|
| `ci` red on a PR | our change broke something | fix before merge |
| `upstream-matrix` red on `latest` | a framework release broke an adapter for users installing today | same-day fix; see "Upstream break" |
| Issue "upstream next breaks <adapter>" | a pre-release will break us when it ships | fix within the week; no user impact yet |
| `upstream-matrix` red on `min` | a transitive dependency moved under our floor | raise the floor in the adapter manifest and in `ci/upstream-matrix.json` |
| Matrix cell exits 2 | install failed (registry hiccup or a release mid-publish) | re-run; act only if it repeats |
| `live-contract` red | the Viktor API changed behaviour, or the key or credits ran out | see "Viktor API change" |

## Upstream break

1. Reproduce: `python3 scripts/upstream_matrix.py --adapter <id> --channel latest` (Python adapters run in a throwaway
   venv; for TypeScript follow with `npm ci` to restore the workspace).
2. Read the framework's changelog for the version in the log. Known patterns from the first year of data:
   - **Vercel AI SDK**: one provider-spec major about every six months. `@ai-sdk/openai-compatible` absorbs it; we bump
     the dependency range and the middleware type name (`LanguageModelV4Middleware`). Also watch the shape of the
     in-stream `error` part (it changed from a string to an object inside 7.x).
   - **Pydantic AI**: the adapter subclasses `pydantic_ai.providers._openai_compatible.OpenAICompatibleProvider`, a private
     module (it mirrors the in-tree providers so the file can be upstreamed). It did not exist in 2.0 and changed by 2.40.
     This is the most likely adapter to break. If the in-tree provider lands, delete our copy and re-export theirs.
   - **OpenAI Agents SDK**: 0.x, breaking minors monthly. The `Model` / `ModelProvider` interfaces have been stable; the
     tests rely on `agents.testing` (added in 0.21).
   - **LangChain**: stable since 1.0. Watch `BaseChatOpenAI` private hooks we override (`_get_request_payload`,
     `stream_chunk_timeout`) and, in JS, `withConfig` and `_streamChatModelEvents`.
   - **Mastra**: weekly minors, stable public API. It bundles its own AI SDK provider types, hence the cast in `viktorModel()`.
   - **ACP**: schema v2 is in alpha; v1 is what every shipping editor speaks. Move when Zed and JetBrains do.
3. Fix in the adapter only. If the fix is Viktor-specific logic, it belongs in the core.
4. Release the adapter: patch version if behaviour is unchanged, minor if we add support for a new upstream major,
   major if our public types change.

## Viktor API change

1. Run the live suite locally: `VIKTOR_API_KEY=… npm test` and `cd python && VIKTOR_API_KEY=… uv run pytest -m live`.
2. If the wire changed on purpose, update `the Viktor API contract`, re-record fixtures
   (`provenance: live`), fix the core once per language, and run every adapter against the new fixtures.
3. Adapters should not need changes. If one does, the core is leaking a wire detail: fix that instead.

## Swapping in the Viktor SDK

When `the Viktor SDK repository` ships, re-implement `createViktorClient` (TS) and `ViktorClient` / `AsyncViktorClient` (Python)
on top of it behind the same interface (ADR-0002). Fixtures stay valid because they record wire traffic. Expect about
two days including review.

## Routine

| When | What | Time |
|---|---|---|
| Daily, automated | `upstream-matrix` | 0 |
| Weekly | triage matrix issues, skim framework release notes linked from them | 1 h |
| Weekly, automated | `live-contract` (Monday) | 0 |
| Monthly | bump "tested against" lines in READMEs from the matrix log, release patch versions | 2 h |
| Quarterly | re-verify listings (MCP Registry schema is still in preview; models.dev, LangChain docs, AI SDK providers page), rerun `python3 scripts/score_frameworks.py` with fresh download numbers and reconsider tiers | half a day |

## Expected ongoing cost

| Item | Budget |
|---|---|
| Steady state | about 1 engineer-day per month |
| Vercel AI SDK provider-spec major (twice a year) | half a day each |
| Pydantic AI private-module drift, until the provider lands in-tree | up to 1 day per quarter |
| OpenAI Agents 0.x breaking minor that touches `Model` | half a day, a few times a year |
| Viktor SDK swap (one-off) | 2 days |
| Adding a Tier 2 framework as a native adapter | 1 to 2 days on the existing core, fixtures and guide (`docs/adapter-guide.md`) |

Who breaks what: framework maintainers break adapters (caught by the nightly matrix before users see it, for `next`);
the Viktor API team breaks the cores (caught by the weekly live contract); registries break listings (caught quarterly).

## Releasing (when the maintainers decides to publish)

Nothing is published by automation. Order matters because adapters depend on the cores:
`@viktor/integrations-core` and `viktor-integrations-core`, then `@viktor/ai-sdk-provider`, then the adapters built on
it (`@viktor/mastra`, `@viktor/openai-agents`), then the rest, then `viktor-mcp` and `viktor-acp`. Package names and
the npm scope follow the SDK task's ADR-0001; they are one string per manifest. After publishing, work through
`upstream/*/CHECKLIST.md`.
