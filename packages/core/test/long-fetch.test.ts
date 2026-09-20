import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { longRunningFetch } from "../src/index.js";

// A server that sends response headers only after `delay` ms, like a non-streaming Viktor run.
let url = "";
const server = createServer((req, res) => {
  const delay = Number(new URL(req.url!, "http://x").searchParams.get("delay"));
  setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'), delay);
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("longRunningFetch", () => {
  it("controls the header timeout: a short limit fails a slow response, a long limit waits for it", async () => {
    // Same 1.5 s delay; only the configured timeout differs. This proves the knob that raises
    // Node's 300 s default to Viktor's 660 s is the one in effect.
    await expect(longRunningFetch(500)(`${url}/?delay=1500`)).rejects.toThrow(/fetch failed/);
    const res = await longRunningFetch(10_000)(`${url}/?delay=1500`);
    expect(await res.json()).toEqual({ ok: true });
  }, 15_000);

  it("passes method, headers, body and abort signals through", async () => {
    const controller = new AbortController();
    const pending = longRunningFetch(10_000)(`${url}/?delay=3000`, { method: "POST", body: "{}", headers: { "content-type": "application/json" }, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
