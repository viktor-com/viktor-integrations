# viktor-integrations-core

Internal shared core for the Viktor framework integrations (LangChain, Pydantic AI, OpenAI Agents SDK).
Owns configuration, the thin Viktor client, stream parsing, the error taxonomy, routed tool-call ids,
image validation, the delegate tool, and the fixture-replay test transport.
It will be re-based on the official Viktor SDK (`viktor-sdk`) when that ships; adapters do not change.
