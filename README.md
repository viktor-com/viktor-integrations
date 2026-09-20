# Viktor integrations

Viktor (app.viktor.com) as a first-class integration for agentic frameworks:
a chat model, a "delegate to Viktor" tool, an agent/handoff target, and an MCP server.

Monorepo:

- `packages/` TypeScript adapters and shared core (npm workspaces)
- `python/` Python adapters and shared core (uv workspace)
- `mcp/` MCP surface (hosted server docs, stdio bridge)
- `docs/` research, design, ADRs, plan, featuring kits, maintenance runbook

Start with `docs/plan.md`, then `docs/research/framework-selection.md` and `docs/design.md`.
Spec is fact-driven: `facts ll` to skim, `facts check` to verify.
