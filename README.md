# Viktor integrations

[Viktor](https://viktor.com) (app.viktor.com), the AI employee, as a first-class integration in the agentic frameworks
developers use: a chat model, a `delegate_to_viktor` tool, an agent/handoff target, and an MCP server.

Status, 2026-09-21: everything below is built, verified against recorded fixtures, and **live-verified against the
production Viktor API** (both cores, all seven adapters, the MCP bridge and the ACP agent; evidence in
`docs/evidence/live-2026-09-21.md`). Not yet live-verified: the delegate tool's happy path, which needs a key with the
REST scopes. Nothing is published and no upstream PR has been opened.

## Native adapters (Tier 1)

| Framework | Package | Path | Quickstart |
|---|---|---|---|
| Vercel AI SDK | `@viktor-com/ai-sdk-provider` | `packages/ai-sdk` | `generateText({ model: viktor(), prompt })` |
| LangChain.js / LangGraph.js | `@viktor-com/langchain` | `packages/langchain` | `new ChatViktor().invoke("…")` |
| Mastra | `@viktor-com/mastra` | `packages/mastra` | `new Agent({ model: viktorModel(), … })` |
| OpenAI Agents SDK (JS) | `@viktor-com/openai-agents` | `packages/openai-agents` | `configureViktor(); run(agent, "…")` |
| LangChain / LangGraph (Python) | `langchain-viktor` | `python/langchain` | `ChatViktor().invoke("…")` |
| Pydantic AI | `pydantic-ai-viktor` | `python/pydantic-ai` | `Agent(ViktorModel()).run_sync("…")` |
| OpenAI Agents SDK (Python) | `viktor-openai-agents` | `python/openai-agents` | `Runner.run(agent, "…", run_config=configure_viktor())` |

Every adapter wraps the framework's own OpenAI-compatible model class and adds what the generic path lacks: typed
Viktor errors, no automatic retry of a failed (billed) run, empty-reply detection, image checks, thread-id metadata,
the shared delegate tool, and an agent/handoff helper. Each has a README with a 60-second quickstart and a runnable
example under `examples/`.

## Protocol surfaces (Tier 2)

| Surface | Path | What it is |
|---|---|---|
| MCP | `mcp/server.json`, `mcp/bridge`, `docs/recipes/mcp.md` | Registry entry for Viktor's hosted MCP server, `viktor-mcp` stdio bridge, 25 copy-paste recipes |
| OpenAI / Anthropic-compatible | `docs/recipes/openai-compatible.md` | 18 recipes for frameworks and apps with a base-URL setting |
| ACP (Zed, JetBrains) | `acp` | `viktor-acp`: Viktor in the editor's agent panel; one session is one Viktor thread |
| Listings and upstream PRs | `upstream/` | Patches, exact submission text and a checklist per target. Start at `upstream/README.md` |

## Shared foundations

- `packages/core`, `python/core`: thin Viktor client, stream parsing, error taxonomy, routed tool-call ids, image
  validation, the delegate tool's REST lifecycle, fixture replay. Re-based on the Viktor SDK when it ships (ADR-0002).
- `spec/`: one definition of the delegate tool, the error table and the recipes, used by both languages.
- `fixtures/`: language-neutral recorded wire exchanges replayed by every test suite.

## Run it

```bash
npm install && npm run build && npm test             # TypeScript: cores, adapters, MCP bridge, ACP agent
cd python && uv sync --all-packages && uv run pytest # Python: core and adapters
facts check --tags implemented                        # the behavioural spec, one fact per user-visible behaviour

cd examples/ts/ai-sdk && npm run start:offline        # any example, offline against fixtures
VIKTOR_EXAMPLE_OFFLINE=1 python/.venv/bin/python examples/python/langchain/main.py

export VIKTOR_API_KEY=zt_live_sk_...                  # then the same test commands also run the live contract tests
python3 scripts/upstream_matrix.py --adapter pydantic-ai --channel latest   # one cell of the upstream matrix
```

## Read next

| Document | For |
|---|---|
| `docs/research/framework-selection.md` | why these frameworks: dated reach numbers, scoring, tier list, open decisions |
| `docs/design.md` | what Viktor is in each framework, mappings, shared-core layout, featuring plan, what building taught us (§10) |
| `docs/adr/` | the decisions, one per file |
| `docs/adapter-guide.md` | the bar for a new adapter |
| `docs/runbook.md` | maintenance: signals, upstream break patterns, routine, cost budget |
| `the Viktor API contract` | the Viktor API contract the cores are built from |
| `docs/plan.md` | milestones and status |
