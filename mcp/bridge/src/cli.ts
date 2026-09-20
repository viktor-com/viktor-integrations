#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createBridge } from "./bridge.js";

if (!process.env.VIKTOR_API_KEY) {
  process.stderr.write("viktor-mcp: set VIKTOR_API_KEY (a Viktor API key, zt_live_sk_...). Optional: VIKTOR_BASE_URL.\n");
  process.exit(2);
}

const bridge = createBridge({
  write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  log: (line) => process.stderr.write(`${line}\n`),
});
process.stderr.write(`viktor-mcp: bridging stdio to ${bridge.url}\n`);

// Requests may run in parallel (the hosted server is stateless); answers carry their JSON-RPC id.
const pending = new Set<Promise<void>>();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const p = bridge.handleLine(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on("close", async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
