# viktor-acp: Viktor in Zed, JetBrains IDEs and other ACP clients

[Viktor](https://viktor.com), the AI employee, as an [Agent Client Protocol](https://agentclientprotocol.com) agent.
Pick Viktor in your editor's agent panel and ask it to do work in your team's systems (Slack, connected
integrations, files, its own code sandbox) without leaving the editor.

Viktor runs in its own cloud sandbox. It does not read or edit the files in your local workspace; paste or
attach what it should see. One editor session is one Viktor thread, so follow-up prompts keep Viktor's context
and sandbox state.

## Set up

```bash
export VIKTOR_API_KEY=zt_live_sk_...   # Viktor → Settings → API keys, scope chat:completions
```

**Zed** (`settings.json`):

```json
{ "agent_servers": { "Viktor": { "type": "custom", "command": "npx", "args": ["-y", "viktor-acp"], "env": { "VIKTOR_API_KEY": "zt_live_sk_..." } } } }
```

**JetBrains IDEs** (`~/.jetbrains/acp.json`):

```json
{ "agent_servers": { "Viktor": { "command": "npx", "args": ["-y", "viktor-acp"], "env": { "VIKTOR_API_KEY": "zt_live_sk_..." } } } }
```

Any other ACP client: run `npx -y viktor-acp` as the agent command over stdio.

## What it supports

| ACP feature | Support |
|---|---|
| Protocol | v1 over stdio, built on the official `@agentclientprotocol/sdk` |
| `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel` | yes |
| Streaming | `agent_message_chunk` updates as Viktor writes |
| Prompt content | text, images, embedded text resources, resource links |
| Session continuity | one session = one Viktor thread (`previous_response_id`) |
| `session/load`, local file system and terminal methods, permission requests | no: Viktor works in its own sandbox |
| Stop reasons | `end_turn`, `cancelled`, `max_tokens` (Viktor's 600 s run cap) |

A failed Viktor run is returned as a request error carrying Viktor's message and request id. Set
`VIKTOR_BASE_URL` to use a different Viktor host.

Tested against `@agentclientprotocol/sdk` 1.4.0 (protocol v1) on 2026-09-20.
