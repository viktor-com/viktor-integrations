// LIVE SMOKE TEST through the AI SDK against the real Viktor API. Runs only when VIKTOR_API_KEY is set.
// Budget: 3 run creations.
import { LIVE_SKIP_MESSAGE, hasLiveKey } from "@viktor-com/integrations-core/testing";
import { generateText, isStepCount, streamText, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createViktor, isRoutedToolId } from "../src/index.js";

if (!hasLiveKey()) console.warn(LIVE_SKIP_MESSAGE);

describe.skipIf(!hasLiveKey()).sequential("live: AI SDK provider", { timeout: 660_000 }, () => {
  const viktor = createViktor({ strictEmptyReply: true });

  it("streams a reply", async () => {
    const result = streamText({ model: viktor(), prompt: "Reply with the single word: pong" });
    let text = "";
    for await (const d of result.textStream) text += d;
    expect(text.toLowerCase()).toContain("pong");
  });

  it("completes a tool loop with routed ids", async () => {
    const result = await generateText({
      model: viktor(),
      tools: { get_secret_number: tool({ description: "Returns the secret number. Always call it when asked for the secret number.", inputSchema: z.object({}), execute: async () => "4217" }) },
      stopWhen: isStepCount(4),
      prompt: "Call get_secret_number, then reply with only that number.",
    });
    expect(result.text).toContain("4217");
    const id = result.steps.flatMap((s) => s.toolCalls)[0]!.toolCallId;
    expect(isRoutedToolId(id), `tool id ${id} should be a routed id`).toBe(true);
  });
});
