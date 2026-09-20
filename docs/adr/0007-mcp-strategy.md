# ADR-0007: MCP is served by Viktor's hosted endpoint; we ship listings, recipes and a stdio bridge

Status: accepted (2026-09-20)

## Context

`<host>/mcp` already exists: stateless Streamable HTTP, static API key auth, scope-filtered tools.
Every framework and almost every IDE client can attach a remote Streamable-HTTP server with an
`Authorization` header (`docs/research/raw/sublanes/d-mcp-spec-and-clients.md`). The current MCP
spec revision (2026-07-28) is stateless; legacy clients still send `initialize`.

## Decision

- No second MCP server implementation. `mcp/` contains: `server.json` for the official MCP Registry
  (`com.viktor/viktor`, remote `streamable-http`, secret `Authorization` header), one recipe per
  framework and client, and `viktor-mcp`, a small stdio-to-HTTP bridge for stdio-only contexts that
  reads `VIKTOR_API_KEY` and forwards to the hosted endpoint.
- A conformance check in CI calls `tools/list` on the hosted endpoint in both protocol eras when a
  key is present, and records the tool catalogue as a fixture so recipe docs stay accurate.
- Directory submissions that accept static keys are prepared as kits. Directories that require OAuth
  (claude.ai, ChatGPT) are recorded as a backend ask.

## Consequences

Near-zero code to maintain; the bridge has no tool logic. Dual-era behaviour of the hosted server is
verified, not assumed; any gap is reported to the API owners.
