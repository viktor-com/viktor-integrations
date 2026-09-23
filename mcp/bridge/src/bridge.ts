import { parseSse, resolveApiKey, resolveBaseURL, type FetchLike } from "@viktor-com/integrations-core";

export interface BridgeOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: FetchLike;
  /** Called with every JSON-RPC message to send to the MCP client (one line on stdout). */
  write: (message: unknown) => void;
  log?: (line: string) => void;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: { name?: string; protocolVersion?: string; [k: string]: unknown };
  result?: { protocolVersion?: string; [k: string]: unknown };
}

/**
 * Forwards MCP JSON-RPC messages to Viktor's hosted, stateless Streamable-HTTP endpoint (`<host>/mcp`)
 * and relays the answers. It contains no tool logic: the tool catalogue, auth scopes and behaviour
 * are whatever the hosted server returns for the API key.
 */
export function createBridge(options: BridgeOptions) {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const url = `${resolveBaseURL(options.baseURL)}/mcp`;
  const log = options.log ?? (() => {});
  let protocolVersion: string | undefined;

  async function handle(message: JsonRpcMessage): Promise<void> {
    const isRequest = message.id !== undefined && message.id !== null && typeof message.method === "string";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${resolveApiKey(options.apiKey)}`,
    };
    // Legacy era (<= 2025-11-25): echo the negotiated version. Modern era (2026-07-28): routing headers.
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    if (message.method) headers["mcp-method"] = message.method;
    if (message.method === "tools/call" && typeof message.params?.name === "string") headers["mcp-name"] = message.params.name;

    let response: Response;
    try {
      response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(message) });
    } catch (cause) {
      if (isRequest) options.write(rpcError(message.id!, -32000, `Could not reach Viktor at ${url}: ${(cause as Error).message}`));
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log(`viktor-mcp: HTTP ${response.status} ${text.slice(0, 300)}`);
      if (isRequest) options.write(rpcError(message.id!, -32000, describeHttpError(response.status, text)));
      return;
    }
    if (response.status === 202 || !isRequest) return; // notification or response accepted

    const relay = (payload: JsonRpcMessage) => {
      if (message.method === "initialize" && payload.result?.protocolVersion) protocolVersion = payload.result.protocolVersion;
      options.write(payload);
    };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && response.body) {
      for await (const event of parseSse(response.body)) {
        try {
          relay(JSON.parse(event.data) as JsonRpcMessage);
        } catch {
          log(`viktor-mcp: dropped a non-JSON event`);
        }
      }
      return;
    }
    const body = (await response.json()) as JsonRpcMessage | JsonRpcMessage[];
    for (const payload of Array.isArray(body) ? body : [body]) relay(payload);
  }

  return {
    url,
    /** Handle one line of stdin (a JSON-RPC message or batch). */
    async handleLine(line: string): Promise<void> {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: JsonRpcMessage | JsonRpcMessage[];
      try {
        parsed = JSON.parse(trimmed) as JsonRpcMessage | JsonRpcMessage[];
      } catch {
        options.write(rpcError(null, -32700, "Parse error"));
        return;
      }
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) await handle(message);
    },
  };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function describeHttpError(status: number, body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { detail?: { error?: string; message?: string } | string };
    detail = typeof parsed.detail === "string" ? parsed.detail : `${parsed.detail?.error ?? ""} ${parsed.detail?.message ?? ""}`.trim();
  } catch {
    /* keep text */
  }
  if (status === 401) return `Viktor rejected the API key (${detail}). Check VIKTOR_API_KEY.`;
  if (status === 403) return `Viktor denied access (${detail}). The key may lack scopes, or its owner has no linked Slack/Teams identity.`;
  if (status === 429) return `Viktor rate limit reached (${detail}). Retry later.`;
  return `Viktor MCP endpoint returned HTTP ${status}${detail ? `: ${detail}` : ""}`;
}
