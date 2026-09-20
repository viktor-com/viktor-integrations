// LIVE SMOKE TEST through the OpenAI Agents SDK against the real Viktor API. Runs only when VIKTOR_API_KEY is set.
import { Agent, run, setTracingDisabled, tool } from "@openai/agents";
import { LIVE_SKIP_MESSAGE, hasLiveKey } from "@viktor/integrations-core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { viktorModel } from "../src/index.js";

if (!hasLiveKey()) console.warn(LIVE_SKIP_MESSAGE);

describe.skipIf(!hasLiveKey()).sequential("live: OpenAI Agents SDK", { timeout: 660_000 }, () => {
  it("completes a tool loop", async () => {
    setTracingDisabled(true);
    const secret = tool({ name: "get_secret_number", description: "Returns the secret number. Always call it when asked for the secret number.", parameters: z.object({}), execute: async () => "4217" });
    const agent = new Agent({ name: "A", instructions: "Use tools when asked.", model: viktorModel({ strictEmptyReply: true }), tools: [secret] });
    const result = await run(agent, "Call get_secret_number, then reply with only that number.");
    expect(String(result.finalOutput)).toContain("4217");
  });
});
