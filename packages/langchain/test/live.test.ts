// LIVE SMOKE TEST through LangChain.js against the real Viktor API. Runs only when VIKTOR_API_KEY is set.
// Budget: 3 run creations.
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { LIVE_SKIP_MESSAGE, hasLiveKey } from "@viktor-com/integrations-core/testing";
import { createAgent } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatViktor, isRoutedToolId } from "../src/index.js";

if (!hasLiveKey()) console.warn(LIVE_SKIP_MESSAGE);

describe.skipIf(!hasLiveKey()).sequential("live: ChatViktor", { timeout: 660_000 }, () => {
  it("streams a reply", async () => {
    let text = "";
    for await (const chunk of await new ChatViktor({ strictEmptyReply: true }).stream("Reply with the single word: pong")) text += chunk.text;
    expect(text.toLowerCase()).toContain("pong");
  });

  it("completes a createAgent tool loop with routed ids", async () => {
    const getSecretNumber = tool(async () => "4217", {
      name: "get_secret_number",
      description: "Returns the secret number. Always call it when asked for the secret number.",
      schema: z.object({}),
    });
    const agent = createAgent({ model: new ChatViktor({ strictEmptyReply: true }), tools: [getSecretNumber] });
    const result = await agent.invoke({ messages: [new HumanMessage("Call get_secret_number, then reply with only that number.")] }, { recursionLimit: 8 });
    expect(result.messages.at(-1)!.text).toContain("4217");
    const id = result.messages.flatMap((m) => ("tool_calls" in m ? ((m.tool_calls as Array<{ id?: string }>) ?? []) : []))[0]!.id!;
    expect(isRoutedToolId(id), `tool id ${id} should be a routed id`).toBe(true);
  });
});
