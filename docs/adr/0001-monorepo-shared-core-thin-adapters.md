# ADR-0001: Monorepo with one shared core per language and thin framework adapters

Status: accepted (2026-09-20)

## Context

We want Viktor in many frameworks (TypeScript and Python) with a small maintenance
budget for one team. Each framework has its own abstractions for a model provider,
a tool, an agent, and MCP. Most of the logic (HTTP to the Viktor compat API,
message and tool-call mapping, streaming parsing, error translation, image parts,
continuation rules) is identical across frameworks and differs only in the last
inch where it meets the framework's types.

## Decision

- One git repo, `this repository`, holds everything: `packages/*` for
  TypeScript (pnpm workspace), `python/*` for Python (uv workspace), `mcp/` for the
  MCP surface, `docs/` for research, design, ADRs, featuring kits, and the runbook.
- Exactly one shared core per language: `packages/core` (`@viktor/core`, working name)
  and `python/core` (`viktor-core`, working name). The core owns: the thin Viktor
  client, request/response types, the canonical message model, tool-call id
  preservation, streaming event parsing, error classification, image handling, and
  the recorded-fixture test harness.
- Every framework adapter is a thin package that depends on the core and on one
  upstream framework. An adapter contains only: the framework-facing class(es),
  type conversions to and from the canonical model, the framework's registration
  or entry-point metadata, README, example, and tests. Target: an adapter is under
  400 lines of non-test code.
- Adapters never call the Viktor HTTP API directly; they go through the core.
- Where a framework already speaks OpenAI-compatible or Anthropic-compatible wire
  protocols through a base URL, the adapter is a thin convenience (`viktor()` factory
  with defaults, error surfacing, docs), not a re-implementation.

## Consequences

- Wire-level changes in the Viktor API are fixed once per language.
- Upstream framework breaking changes are isolated to one small package each.
- The CI matrix is adapter × upstream version, with the core tested once.
- Package naming is a real decision for the maintainers (npm scope and PyPI prefix); the working
  names above are placeholders until sign-off.
