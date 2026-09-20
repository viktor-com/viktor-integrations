// LIVE SMOKE TEST through Mastra against the real Viktor API. Runs only when VIKTOR_API_KEY is set.
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { LIVE_SKIP_MESSAGE, hasLiveKey } from "@viktor/integrations-core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { viktorModel } from "../src/index.js";

if (!hasLiveKey()) console.warn(LIVE_SKIP_MESSAGE);

describe.skipIf(!hasLiveKey()).sequential("live: Mastra", { timeout: 660_000 }, () => {
  it("completes a tool loop", async () => {
    const secret = createTool({ id: "get_secret_number", description: "Returns the secret number. Always call it when asked for the secret number.", inputSchema: z.object({}), execute: async () => "4217" });
    const agent = new Agent({ id: "a", name: "A", instructions: "Use tools when asked.", model: viktorModel({ strictEmptyReply: true }), tools: { get_secret_number: secret } });
    const result = await agent.generate("Call get_secret_number, then reply with only that number.");
    expect(result.text).toContain("4217");
  });
});
