# ADR-0009: Language-neutral recorded fixtures plus a gated live contract test

Status: accepted (2026-09-20)

## Decision

- `fixtures/` holds recorded wire exchanges as `<name>.request.json`, `<name>.response.json` or
  `<name>.response.sse`, with secrets and ids scrubbed. Both cores and all adapters replay them
  through a local fixture server, so adapters are tested through the framework's public API.
- Until a live key exists, fixtures are hand-built from the API contract,
  and marked `"provenance": "contract"`. `scripts/record_fixtures` replaces them with
  `"provenance": "live"` recordings; CI reports how many fixtures are still contract-derived.
- Live contract tests run only when `VIKTOR_API_KEY` is set, serially, with a small request budget,
  because live runs are rate limited. Absence of the key is a visible skip, never a pass.

## Consequences

Work is not blocked on credentials, and the gap between "fixture verified" and "live verified" is
explicit in test output and in milestone reports.
