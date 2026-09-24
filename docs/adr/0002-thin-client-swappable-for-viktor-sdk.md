# ADR-0002: Adapters depend on a thin internal client that is swapped for the Viktor SDK

Status: accepted (2026-09-20)

## Context

A sibling effort is building the official Viktor SDK (TypeScript and Python) in
its own repository. It was only a scaffold when this work started. Framework
adapters need an HTTP client now, but must not duplicate the SDK long term.

## Decision

- The shared core exposes a small client interface (`ViktorClient`) with exactly the
  operations adapters need: `chatCompletion` (sync + streaming), `responses` (sync +
  streaming), `anthropicMessages` (sync + streaming), `listModels`, and later
  `delegate` for the native REST run lifecycle used by the "delegate to Viktor" tool.
- The first implementation is an internal, dependency-light client (`fetch` in TS,
  `httpx` in Python) built directly from the compat API contract documented by Viktor.
- When the Viktor SDK ships the equivalent surface, the core replaces the internal
  implementation with an SDK-backed one behind the same interface. Adapters do not
  change. Recorded fixtures stay the same because they capture wire traffic, not
  client calls.
- The client interface stays narrow on purpose: no retries policy, no auth flows,
  no key management beyond `apiKey` + `baseUrl`. Those belong to the SDK.
- Environment defaults are shared with the SDK's expected names so a swap is
  invisible to users: `VIKTOR_API_KEY`, `VIKTOR_BASE_URL` (default
  `https://api.viktor.com`).

## Consequences

- No wait on the SDK to start M2.
- One-time cost when the SDK lands: reimplement the interface, rerun fixtures.
- Risk: the SDK picks different environment variable names. Mitigation: read
  `the Viktor SDK design doc` before M2 code and align; record any
  divergence in this ADR.
