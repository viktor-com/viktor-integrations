# Adapter guide: the bar for every Viktor framework integration

Read first: `docs/design.md` (§2 roles, §3 mappings), ADR-0003 (tool ids), ADR-0005 (wrap upstream classes),
ADR-0006 (shared spec), and the reference adapter `packages/ai-sdk/` (source, tests, README).

## Rules

1. **Wrap the framework's own OpenAI-compatible class.** Configure it with the core's defaults
   (`VIKTOR_API_KEY`, `VIKTOR_BASE_URL`, base URL `<host>/api/compat/v1`, model `viktor`, 660 s timeout).
   Do not re-implement message conversion or stream parsing.
2. **Everything Viktor-specific comes from the core**: `@viktor-com/integrations-core` (TS) or
   `viktor_integrations_core` (Py): config resolution, error classes and `errorFromResponse` /
   `error_from_response`, `threadIdFrom` / `thread_id_from`, image validation, the delegate tool
   (`delegateToViktor` / `delegate_to_viktor`, `adelegate_to_viktor`) and its spec, fixture replay.
   If the core lacks something, say so in your final report; do not fork logic into the adapter.
3. **Idiomatic to the framework.** Names, constructor arguments, error types, docs style and test style
   follow the framework's own first-party integrations. A maintainer should feel it belongs.
4. **Under 400 lines of non-test code.** Typed (strict TS / mypy-clean Python).
5. **Never rewrite tool-call ids.** They are Viktor routing tokens.
6. **A failed Viktor run is never retried automatically** (it was billed and may have acted). Rate limits
   and 5xx may be retried by the framework's normal policy.

## Required surface per adapter

- Chat model (and Responses-API option where the framework supports it).
- Delegate tool named `delegate_to_viktor`, schema and description taken from the shared spec.
- Agent / handoff helper where the framework has the concept.
- An MCP recipe in the README (hosted server `https://api.viktor.com/mcp`, `Authorization: Bearer`).

## Required tests (through the framework's public API, replaying `fixtures/`)

| Behaviour | Fixture(s) |
|---|---|
| Plain reply with only an API key; bearer auth; model forced to `viktor` | `chat-text` |
| Streaming text; keep-alive comments never surface | `chat-stream-text` |
| Streaming tool call: fragmented args assembled, routed id unchanged | `chat-stream-tool-call` |
| Tool loop: id goes back byte for byte, tools re-declared on the follow-up | `chat-tool-call` + `chat-tool-result-followup` |
| Image input reaches Viktor as `image_url`; bad images rejected early where the framework allows | `chat-image` |
| 502 `run_failed` → framework-idiomatic error carrying Viktor's message, not retried | `chat-run-failed` |
| In-stream error frame → error, not a silent end of stream | `chat-stream-run-failed` |
| Empty 200 reply → warning by default, error in strict mode | `chat-empty-reply` |
| 401 → auth error with the fix hint; 429 → rate-limit error with retry-after | `chat-auth-401`, `chat-rate-limit` |
| Delegate tool: schema equals `spec/delegate-tool.json`; executes the REST lifecycle | scripted REST transport (see core tests) |
| Live smoke test gated on `VIKTOR_API_KEY`, skipping with the core's `LIVE_SKIP_MESSAGE` | real API |

Test doubles: TS `createFixtureFetch(...names)` from `@viktor-com/integrations-core/testing`; Python
`make_fixture_transport(httpx2, *names)` from `viktor_integrations_core.testing`. The `openai` SDK 3.x is
built on `httpx2`, so pass `http_client=httpx2.Client(transport=t)` / `httpx2.AsyncClient(transport=t)`.
(`FixtureTransport(*names)` is the plain-`httpx` variant used by the core's own client.) Map SDK exceptions with
`viktor_error_from_exception(exc)`. Both record requests on `.requests`.

## Required files

`README.md` (60-second quickstart first, then tools/streaming, delegate tool, images, errors table,
settings, MCP recipe, "tested against" line with versions and date), one runnable example under
`examples/ts/<name>/` or `examples/python/<name>/` with an offline mode that replays fixtures, tests.

## Lane discipline (parallel work)

Work only inside your package directory and your example directory. Do not edit `.facts`, root
`package.json`, `package-lock.json`, `python/pyproject.toml`, `uv.lock`, `spec/`, `fixtures/`, or the
cores. Do not run `npm install` at the repo root or `uv lock`; dependencies are pre-installed. Do not
`git commit`. Report proposed facts and any core gaps in your final message.
