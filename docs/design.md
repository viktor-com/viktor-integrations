# Viktor framework integrations: design

Status: M1 design, 2026-09-20, updated as the adapters were built. Inputs: a framework selection study
(reach, featuring path, API stability, build cost; summarised in ADR-0004), the Viktor API contract, and the Viktor
SDK's ADRs (names, env vars, layering). Decisions are recorded as ADRs in `docs/adr/`.

## 1. Principles

1. **Wrap, do not re-implement.** Where a framework already ships an OpenAI-compatible or
   Anthropic-compatible model class, the Viktor adapter configures and wraps it. Upstream then
   carries its own spec churn (ADR-0005).
2. **One core per language.** Everything Viktor-specific lives once in `packages/core` and
   `python/core`. Adapters convert types and register with the framework, nothing else (ADR-0001).
3. **One spec for shared artifacts.** The delegate tool's name, description and JSON Schema, the
   error table, and the recipe matrix live in `spec/` and are consumed by both languages and by the
   docs generator (ADR-0006).
4. **Fixtures first, live always.** Recorded wire fixtures are shared across languages. A live
   contract test runs whenever `VIKTOR_API_KEY` is set (ADR-0009).
5. **Thin client now, SDK later.** The core talks to Viktor through a narrow client interface that
   is re-implemented on the Viktor SDK when it ships (ADR-0002).

## 2. What Viktor is in each framework

Four roles, mapped to each Tier 1 framework's own abstractions:

| Role | Backing Viktor surface | Notes |
|---|---|---|
| **Chat model** | compat Chat Completions; Responses where the framework supports it; Anthropic Messages as a documented alternative | Model id is always `viktor`. System prompts are appended, never replace Viktor's identity. Sampling params are best effort |
| **Delegate tool** | native REST: `POST /threads`, poll `GET /runs/{id}`, `GET /runs/{id}/result`, files | For long or side-effecting work. No 600 s cap; `requires_action` surfaces as a tool result asking the caller for input; optional `thread_id` reuse |
| **Agent / handoff target** | the chat model wrapped in the framework's agent type, or the delegate tool exposed as a sub-agent | Only where the framework has the concept |
| **MCP server** | hosted `/mcp` | No package needed; one recipe per framework |

| Framework | Chat model | Delegate tool | Agent / handoff | MCP recipe |
|---|---|---|---|---|
| Vercel AI SDK | `createViktor()` returns a provider; `viktor()` is a language model built on `createOpenAICompatible`, wrapped with `wrapLanguageModel` middleware for Viktor errors | `viktorDelegate()` built with `tool({ inputSchema, execute })` | `ToolLoopAgent({ model: viktor() })`; sub-agent-as-tool example | `createMCPClient({ transport: { type: 'http', url, headers } })` |
| LangChain / LangGraph (Py) | `ChatViktor(BaseChatOpenAI)` with `use_responses_api` option | `ViktorDelegateTool(BaseTool)` with async `_arun` | `create_agent(model=ChatViktor())`; LangGraph `create_viktor_handoff_tool()` returning a `Command` | `MultiServerMCPClient({"viktor": {"transport": "http", "url", "headers"}})` |
| LangChain / LangGraph (JS) | `ChatViktor extends ChatOpenAI` | `viktorDelegateTool` via `tool()` | `createAgent({ model })`; handoff tool with `Command` | `MultiServerMCPClient` |
| Pydantic AI | `ViktorProvider(Provider[AsyncOpenAI])` used by `OpenAIChatModel` / `OpenAIResponsesModel`; in-tree PR makes `Agent('viktor:viktor')` resolve | `ViktorToolset(FunctionToolset)` with `delegate_to_viktor` | `viktor_agent()` returning a configured `Agent`, usable through agent delegation | `MCPToolset(url, headers=…)` |
| Mastra | `viktorModel()` config (`{ id, url, apiKey, api }`) or the AI SDK `viktor()` instance; models.dev entry gives `'viktor/viktor'` | `viktorDelegateTool` via `createTool({ background: true })` | `new Agent({ id: 'viktor', model })` for a supervisor's `agents` map | `new MCPClient({ servers: { viktor: { url, requestInit } } })` |
| OpenAI Agents SDK (Py) | `ViktorProvider(ModelProvider)` on Chat Completions by default (the only wire with keepalives), `use_responses=True` for thread continuity | `viktor_delegate_tool` via `@function_tool` | `viktor_agent()` for `handoffs=[…]` and `.as_tool()` | `MCPServerStreamableHttp(params={url, headers})` |
| OpenAI Agents SDK (JS) | `ViktorModel` / `ViktorProvider` built on the Viktor AI SDK provider through the SDK's `aisdk()` bridge | `viktorDelegateTool` via `tool()` | `viktorAgent()` for `handoffs` and `asTool()` | `MCPServerStreamableHttp({ url, requestInit })` |

## 3. Mapping Viktor behaviours onto framework abstractions

### 3.1 Caller-side tools

- The framework owns tool execution. Viktor emits tool calls and the run ends with
  `finish_reason: "tool_calls"`. The framework sends results back with the full history.
- **Tool-call ids are routing tokens** (`call_vk1_<thread>_<kind>_<suffix>`). Adapters pass them
  through unchanged so the follow-up resumes the durable thread instead of replaying (ADR-0003).
  Each adapter has a test that round-trips an id through the framework's message types.
- Tool declarations are re-sent on every request. All wrapped upstream classes already do this.
- Viktor keeps its own server-side tools. READMEs state that a Viktor turn can take minutes and
  may act on connected integrations.
- Responses API built-in `web_search` is turned into a caller function by Viktor. Adapters do not
  advertise hosted tools; the OpenAI Agents adapter rejects hosted tool types with a clear error.

### 3.2 Streaming

- Chat Completions SSE: text deltas, tool-call argument fragments by `index`, final chunk, optional
  usage chunk, `[DONE]`. Wrapped upstream parsers handle this shape.
- **In-stream failure** is a `{"error":…}` data frame with no finish chunk. The core detects it and
  raises `ViktorRunFailedError`. Where the wrapped upstream class already raises on that frame,
  the adapter maps the upstream error to the Viktor error type.
- Long silences: only the Chat Completions wire sends keepalive comments. Adapters default to Chat
  Completions for streaming and set generous read timeouts (default 660 s, above the 600 s run cap).
  The Responses wire is opt-in where continuity matters more than keepalives.

### 3.3 Images

- User image parts map to `image_url` parts with https or data URLs.
- Client-side validation in the core: reject `http://` URLs, more than 10 images per request,
  and MIME types outside jpeg/png/gif/webp. Viktor silently skips bad images, so failing early is the
  only way a developer notices.
- Frameworks with typed file parts (AI SDK v7 `file` parts, LangChain standard content blocks)
  are converted in the adapter; non-image files raise "not supported by Viktor".

### 3.4 Continuation

- Tool loops: thread resume through routed tool ids, automatic.
- Plain multi-turn chat on Chat Completions is a stateless replay per turn. Frameworks that support
  the Responses API get an option that threads `previous_response_id` (the Viktor thread id) so
  multi-turn keeps sandbox continuity: LangChain `use_responses_api`, OpenAI Agents (Py) `use_responses=True`,
  Pydantic AI `viktor_responses_model()`. Chat Completions stays the default everywhere because it is the
  only wire that sends keepalives during Viktor's silent tool work. Viktor's Responses ids carry no `resp_`
  prefix, so adapters resolve them with the core's thread-id helper (LangChain needed an override for this).
- Delegate tool: explicit `thread_id` input for follow-ups; the tool result always returns the
  thread id and run id.

### 3.5 Errors

One error table in `spec/errors.json`, implemented in each core, mapped to the framework's error
types in each adapter:

| Condition (wire) | Core error | Retryable |
|---|---|---|
| 502 `run_failed`; stream `{"error":…}`; `response.failed`; Anthropic `event: error` | `ViktorRunFailedError` (worker message, request id) | caller decides |
| 200 with `content: null`, no tool calls, `finish_reason: "stop"` | `ViktorEmptyReplyError` in strict mode, warning otherwise | yes |
| `finish_reason: "length"` (600 s cap or generation error) | surfaced as finish reason `length` plus `viktor.timed_out` metadata | no |
| 401/403 `{"detail":…}` | `ViktorAuthError` with code (`invalid_api_key`, `identity_denied`, `compat_api_not_enabled`, missing scope) | no |
| 429 | `ViktorRateLimitError` with `retry_after` and code (`rate_limit_exceeded`, `insufficient_quota`) | after `Retry-After` |
| 413 | `ViktorRequestTooLargeError` | no |
| 422 `response_format_not_satisfied` | `ViktorStructuredOutputError` | no |

Every error carries the `X-Request-ID` response header.

## 4. Shared-core layout

```
spec/
  delegate-tool.json      name, description, input/output JSON Schema (single source)
  errors.json             wire condition → error class → retryable
  recipes.yaml            framework × surface matrix for generated recipes
fixtures/                 recorded wire exchanges, language neutral (JSON + .sse)
packages/
  core/                   @viktor-com/integrations-core (private until naming is settled)
    src/client.ts         ViktorClient interface + fetch implementation
    src/sse.ts            Chat Completions / Responses / Anthropic stream parsing
    src/errors.ts         error classes from spec/errors.json
    src/tool-ids.ts       RoutedToolId parse + threadIdFrom()
    src/images.ts         client-side image validation
    src/delegate.ts       REST delegate-and-poll lifecycle
    src/testing/          fixture server + live-test helpers
  ai-sdk/  langchain/  mastra/  openai-agents/
python/
  core/                   viktor_integrations_core (same modules, httpx)
  langchain/  pydantic-ai/  openai-agents/
mcp/                      server.json, stdio bridge, per-client recipes
acp/                      (M4) stdio ACP agent
docs/recipes/             generated from spec/recipes.yaml
scripts/                  spec sync, recipe generation, fixture recording, upstream matrix
```

What is generated or shared, to keep maintenance small:

- Delegate tool schema and description: every adapter in both languages reads `spec/delegate-tool.json`.
- Error classes and docs tables: generated from `spec/errors.json`.
- Recipes for Tier 2 frameworks and IDE clients: generated from `spec/recipes.yaml` and templates;
  a smoke test compiles or imports each snippet.
- Fixtures: recorded once with `scripts/record_fixtures`, replayed by both cores and all adapters.

## 5. Versioning against upstream

- Each adapter is its own package with independent semver and a peer or optional dependency range on
  the upstream framework: current major and the previous major while it is still maintained.
- Core is an internal dependency with a caret range; adapters never pin it exactly.
- CI matrix per adapter: `min` (lowest supported), `latest`, and `next` (pre-release or main) nightly.
  A `next` failure opens an issue, not a red build (M6).
- An upstream major gets a new adapter minor if the wrapped class absorbs it, or a new adapter major
  if our public types change.
- Support statement in every README: which upstream versions are tested, on which date.

## 6. Featuring plan per Tier 1 framework

| Framework | Contribution path | Requirements they impose | Artifacts we produce (M5) |
|---|---|---|---|
| Vercel AI SDK | PR to `vercel/ai` adding `content/providers/05-community-providers/NN-viktor.mdx`; second PR adding the delegate tool to `content/tools-registry/registry.ts` | Published npm package; signed commits; no changeset for docs; page follows the community-provider template | npm-ready package, the `.mdx` page, registry entry patch, PR text |
| LangChain Py + JS | Publish packages, then file `06-integration-submission.yml` in `langchain-ai/docs` (one per component: chat model, tool; both languages) | Package on PyPI / npm; `langchain-tests` standard tests passing; docs URL. Hosted guide needs 50k downloads/month or "featured" status | Packages with standard tests, filled issue forms, a ready MDX guide from their `TEMPLATE.mdx` to offer when asking for featured status |
| Pydantic AI | Open an issue proposing `ViktorProvider`; after a maintainer assigns it, in-tree PR: `providers/viktor.py`, `infer_provider_class`, docs section in `models/openai.md`, cassette tests. Fallback: one-paragraph docs mention linking `pydantic-ai-viktor` | Issue approval first; `make` green with 100% coverage; VCR cassettes; docs nav | Issue text, a fork branch with the provider and tests, the fallback paragraph |
| Mastra | PR to `sst/models.dev`: `providers/viktor/provider.toml`, `models/viktor.toml`, `logo.svg`. Optional Mastra docs example (needs a linked approved issue) | models.dev schema validation | TOML + logo patch, PR text, `@viktor-com/mastra` README with supervisor example |
| OpenAI Agents SDK | No registry. Example PRs: `examples/model_providers/viktor_example.py` and `examples/docs/models/viktorProvider.ts` | Tests for examples where applicable, `make check` / `pnpm test`, changeset for JS | Example files, PR text. Expectation stated: may be declined; our docs carry the integration |

Tier 2 listings (M4-M5): official MCP Registry `server.json` (DNS verification of `viktor.com` is a
maintainer action), GitHub MCP Registry email request, LiteLLM `providers.json` entry, models.dev entry
(shared with Mastra), adk.dev integrations page, Haystack integrations page, ACP registry entry.
Blocked on backend OAuth: Anthropic Connectors Directory, ChatGPT apps directory.

Submission material (patches, PR text, checklists) is maintained alongside this repository, not in it.
Nothing is submitted by automation.

## 7. Testing strategy

- **Unit, fixture-driven:** each core parses every fixture in `fixtures/`; each adapter runs its
  framework's public API against a local fixture server that replays the same files.
- **Conformance:** `langchain-tests` standard suites (Py and JS), Pydantic AI cassette tests, AI SDK
  provider tests with their test server utilities.
- **Live contract test:** one per core and one smoke test per adapter, gated on `VIKTOR_API_KEY`:
  text reply, streaming, tool round-trip with id preservation, image input, a forced auth error.
  Skipped with an explicit message when the key is absent. Live runs cost credits and rate limits
  are 10 run creations per minute at entry tier, so the suite is small and serial.
- **Facts:** one fact per user-visible behaviour, verified with `facts check --tags <tag>`.

## 8. Maintenance budget (target, finalised in M6)

| Item | Expected cost | Who breaks what |
|---|---|---|
| 7 adapter packages (< 400 lines each) + 2 cores | About 1 engineer-day per month steady state | Vercel AI SDK provider-spec major about every 6 months (absorbed by `@ai-sdk/openai-compatible`; we bump the peer range); Pydantic AI yearly major; OpenAI Agents 0.x minors monthly; LangChain stable since 1.0; Mastra weekly minors, stable public API |
| Nightly CI matrix (`min`, `latest`, `next`) | Automated; triage about 1 hour per week | `next` failures give weeks of warning before a release |
| Viktor API changes | Fixed once per core | Compat API owners; fixtures re-recorded by script |
| Listings | Re-verify quarterly | Registry schema changes (MCP Registry is still in preview) |
| SDK swap | One-off, about 2 days | Viktor SDK |

## 9. Risks

- **Live coverage depends on key scopes.** The chat surfaces are live-verified; the delegate tool's happy path needs
  a key with the REST scopes.
- **Package names:** npm scope `@viktor-com` (decided 2026-09-23, same as the SDK).
- **Empty 200 replies** cannot be told apart from an intentionally empty answer. Strict mode is opt-in.
- **Upstream refusal** (Pydantic AI in-tree, OpenAI Agents examples). Every kit has a fallback that
  keeps the integration usable from our own packages and docs.

## 10. What building the adapters taught us (2026-09-20)

Findings from M2-M3 that every future adapter must respect. Each is covered by a test in the adapter named.

| Finding | Where it bit | What the adapter does |
|---|---|---|
| Frameworks retry 5xx by default, and a 502 `run_failed` is a billed run that may have acted | AI SDK (`isRetryable`), LangChain.js `AsyncCaller` (6 retries), openai SDK (2 retries) used by LangChain Py, Pydantic AI, OpenAI Agents | Failed runs produce exactly one request. Retries for rate limits stay available (AI SDK, LangChain.js, OpenAI Agents retry advice) or are opt-in (`max_retries=0` in Python, because the openai SDK cannot tell 502 `run_failed` from a gateway 502) |
| An empty reply makes Pydantic AI silently ask again, which is a second billed run | Pydantic AI 2.46 | `ViktorModel` warns, or raises after one request in strict mode |
| Node's fetch gives up after 300 s without headers; a non-streaming Viktor run can take 600 s | every TS adapter | the core's `longRunningFetch` (undici `Agent` with 660 s header and body timeouts) is the default fetch |
| `BaseChatOpenAI` kills async streams silent for 120 s; SSE comments do not reset it | LangChain Py | `stream_chunk_timeout` raised to 660 s |
| The openai JS SDK keeps only `body.error`, so Viktor's `{"detail": …}` auth bodies arrive as "401 status code (no body)" | LangChain.js | a fetch wrapper remembers error bodies keyed by the response headers object |
| The openai SDKs raise a status-less `APIError` for Viktor's in-stream error frame | all openai-SDK based adapters | both cores map it to `ViktorRunFailedError` (`runFailedFromStreamFrame`, `viktor_error_from_exception`) |
| `ChatOpenAI.withConfig` / `bindTools` rebuilds a plain `ChatOpenAI`, dropping subclass overrides | LangChain.js | `withConfig` overridden to return `ChatViktor` |
| Strict tool schemas close the free-form `response_schema` object | Pydantic AI, OpenAI Agents | the delegate tool is registered non-strict |
| `run_stream()` treats Viktor's short text before a tool call as the final answer | Pydantic AI | README and example use `run_stream_events()` / `agent.iter()` when tools are present |
| The OpenAI Agents SDK uploads traces to OpenAI with the model key | OpenAI Agents Py + JS | `configure_viktor()` / `configureViktor()` turn tracing off unless asked to keep it |

| In production a failed non-streaming run arrives as a CDN HTML 502, not the JSON `run_failed` body | found live, 2026-09-21 | both cores treat any 502 as a failed run that is never auto-retried |
| `tool_choice: "required"` fails every run on the current backing model | found live, 2026-09-21 | documented; live tests use `auto`; backend ask |

Live verification ran on 2026-09-21: both cores, all seven adapters, the MCP
bridge and the ACP agent pass against production. Twelve live recordings in `fixtures/live/` are replayed by both cores.
Still open: the delegate tool's happy path and MCP `ask_viktor` need a key with the REST scopes.
