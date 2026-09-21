// LIVE CONTRACT TEST against the real Viktor API. Runs only when VIKTOR_API_KEY is set.
// Budget: 4 run creations (entry tier allows 10/min). Serial on purpose.
import { describe, expect, it } from "vitest";
import { ViktorAuthError, createViktorClient, isRoutedToolId, type ChatStreamPart } from "../src/index.js";
import { LIVE_SKIP_MESSAGE, hasLiveKey } from "../src/testing/index.js";

if (!hasLiveKey()) console.warn(LIVE_SKIP_MESSAGE);

const tools = [{ type: "function", function: { name: "get_secret_number", description: "Returns the secret number. Always call it when asked for the secret number.", parameters: { type: "object", properties: {} } } }];

describe.skipIf(!hasLiveKey()).sequential("live: Viktor compat API contract", { timeout: 660_000 }, () => {
  const client = createViktorClient({ strictEmptyReply: true });

  it("lists exactly the viktor model", async () => {
    expect((await client.listModels()).map((m) => m.id)).toEqual(["viktor"]);
  });

  it("answers a plain prompt with non-empty text", async () => {
    const res = await client.chatCompletion({ messages: [{ role: "user", content: "Reply with the single word: pong" }] });
    expect(res.model).toBe("viktor");
    expect(res.choices[0]!.message.content?.toLowerCase()).toContain("pong");
  });

  it("streams, calls a caller tool with a routed id, and resumes the thread with the result", async () => {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "Call get_secret_number, then reply with only that number." }];
    const parts: ChatStreamPart[] = [];
    for await (const p of client.chatCompletionStream({ messages, tools, tool_choice: "auto" })) parts.push(p);
    const call = parts.find((p) => p.type === "tool-call") as Extract<ChatStreamPart, { type: "tool-call" }> | undefined;
    expect(call, "Viktor should call the caller tool").toBeDefined();
    expect(isRoutedToolId(call!.toolCall.id), `tool id ${call!.toolCall.id} should be a routed id`).toBe(true);
    expect((parts.at(-1) as { finishReason: string }).finishReason).toBe("tool_calls");

    messages.push({ role: "assistant", content: null, tool_calls: [{ id: call!.toolCall.id, type: "function", function: { name: call!.toolCall.name, arguments: call!.toolCall.arguments || "{}" } }] });
    messages.push({ role: "tool", tool_call_id: call!.toolCall.id, content: "4217" });
    const final = await client.chatCompletion({ messages, tools });
    expect(final.choices[0]!.message.content).toContain("4217");
  });

  it("rejects a bad key with ViktorAuthError invalid_api_key", async () => {
    const bad = createViktorClient({ apiKey: "zt_live_sk_00000000000000000000000000000000_invalid" });
    const err = await bad.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(ViktorAuthError);
    expect(err.detailCode).toBe("invalid_api_key");
  });
});
