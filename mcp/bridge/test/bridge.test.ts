import { describe, expect, it } from "vitest";
import { createBridge } from "../src/bridge.js";

type Call = { url: string; headers: Record<string, string>; body: unknown };

function harness(reply: (body: { method?: string; id?: number }) => Response) {
  const calls: Call[] = [];
  const out: unknown[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), headers, body });
    return reply(body);
  };
  const bridge = createBridge({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", fetch, write: (m) => out.push(m) });
  return { bridge, calls, out };
}
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

describe("viktor-mcp stdio bridge", () => {
  it("forwards requests to <host>/mcp with the bearer key and relays the JSON answer", async () => {
    const { bridge, calls, out } = harness((b) => json({ jsonrpc: "2.0", id: b.id, result: { tools: [{ name: "ask_viktor" }] } }));
    await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(calls[0]!.url).toBe("https://viktor.test/mcp");
    expect(calls[0]!.headers.authorization).toBe("Bearer zt_test_sk_fixture");
    expect(calls[0]!.headers.accept).toBe("application/json, text/event-stream");
    expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "ask_viktor" }] } }]);
  });

  it("relays SSE answers including progress notifications, in order", async () => {
    const sse = [
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 2, total: 120 } })}\n\n`,
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "done" }] } })}\n\n`,
    ].join("");
    const { bridge, out, calls } = harness(() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask_viktor", arguments: { message: "hi" }, _meta: { progressToken: "p1" } } }));
    expect(out).toHaveLength(2);
    expect((out[0] as { method: string }).method).toBe("notifications/progress");
    expect((out[1] as { id: number }).id).toBe(7);
    expect(calls[0]!.headers["mcp-method"]).toBe("tools/call");
    expect(calls[0]!.headers["mcp-name"]).toBe("ask_viktor");
  });

  it("remembers the negotiated protocol version and sends it on later requests", async () => {
    const { bridge, calls } = harness((b) =>
      b.method === "initialize" ? json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }) : json({ jsonrpc: "2.0", id: b.id, result: {} }),
    );
    await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(calls[0]!.headers["mcp-protocol-version"]).toBeUndefined();
    expect(calls[1]!.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("writes nothing for notifications", async () => {
    const { bridge, out } = harness(() => new Response(null, { status: 202 }));
    await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(out).toEqual([]);
  });

  it("turns HTTP auth failures into a JSON-RPC error that says what to fix", async () => {
    const { bridge, out } = harness(() => json({ detail: { error: "invalid_api_key", message: "Missing or invalid API key" } }, 401));
    await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    expect(out[0]).toMatchObject({ id: 3, error: { code: -32000 } });
    expect((out[0] as { error: { message: string } }).error.message).toMatch(/VIKTOR_API_KEY/);
  });

  it("answers malformed input with a JSON-RPC parse error", async () => {
    const { bridge, out, calls } = harness(() => json({}));
    await bridge.handleLine("{not json");
    expect(out[0]).toMatchObject({ error: { code: -32700 } });
    expect(calls).toHaveLength(0);
  });
});
