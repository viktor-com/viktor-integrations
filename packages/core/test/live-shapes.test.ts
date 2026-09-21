// Replays fixtures/live/*.json (recorded from the real Viktor API) through the core, so the parsers and
// error mapping are checked against real wire shapes, not only against contract-derived fixtures.
import { describe, expect, it } from "vitest";
import { ViktorAuthError, ViktorRunFailedError, createViktorClient, isRoutedToolId, threadIdFrom, type ChatStreamPart } from "../src/index.js";
import { createFixtureFetch, loadFixture } from "../src/testing/index.js";

const client = (name: string) => createViktorClient({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", fetch: createFixtureFetch(`live/${name}`), onWarning: () => {} });
const msgs = [{ role: "user", content: "x" }];

describe("live recordings", () => {
  it("are marked provenance live", () => {
    for (const n of ["chat-text", "chat-stream-text", "chat-stream-tool-call", "chat-tool-call", "chat-tool-result-followup", "chat-image", "chat-auth-401", "chat-tool-choice-required", "responses-stream-text", "responses-text", "anthropic-text", "anthropic-stream-text"]) {
      expect(loadFixture(`live/${n}`).provenance).toBe("live");
    }
  });

  it("chat: text, streamed text and usage parse", async () => {
    expect((await client("chat-text").chatCompletion({ messages: msgs })).choices[0]!.message.content).toContain("Hello from Viktor");
    const parts: ChatStreamPart[] = [];
    for await (const p of client("chat-stream-text").chatCompletionStream({ messages: msgs })) parts.push(p);
    expect(parts.filter((p) => p.type === "text-delta").map((p) => (p as { text: string }).text).join("")).toContain("Hello from Viktor");
    const finish = parts.at(-1) as Extract<ChatStreamPart, { type: "finish" }>;
    expect(finish.finishReason).toBe("stop");
    expect(finish.usage!.total_tokens).toBeGreaterThan(0);
  });

  it("chat: real tool-call ids are routed ids that embed a thread id, streamed and not", async () => {
    const parts: ChatStreamPart[] = [];
    for await (const p of client("chat-stream-tool-call").chatCompletionStream({ messages: msgs })) parts.push(p);
    const call = parts.find((p) => p.type === "tool-call") as Extract<ChatStreamPart, { type: "tool-call" }>;
    expect(isRoutedToolId(call.toolCall.id)).toBe(true);
    expect(call.toolCall.id.length).toBeLessThanOrEqual(64);
    expect(JSON.parse(call.toolCall.arguments).city).toMatch(/berlin/i);
    const res = await client("chat-tool-call").chatCompletion({ messages: msgs });
    expect(threadIdFrom(res.choices[0]!.message.tool_calls![0]!.id)).toMatch(/^[A-Za-z0-9]{20,24}$/);
    expect((await client("chat-tool-result-followup").chatCompletion({ messages: msgs })).choices[0]!.message.content).toMatch(/sunny/i);
  });

  it("errors: a real 401 maps to ViktorAuthError; a real failed run arrives as an opaque HTML 502 and is still ViktorRunFailedError", async () => {
    await expect(client("chat-auth-401").chatCompletion({ messages: msgs })).rejects.toBeInstanceOf(ViktorAuthError);
    const err = await client("chat-tool-choice-required").chatCompletion({ messages: msgs }).catch((e) => e);
    expect(err).toBeInstanceOf(ViktorRunFailedError);
    expect(err.isRetryable).toBe(false);
    expect(err.detailCode).toBe("run_failed_opaque");
    expect(err.message).not.toMatch(/<html|DOCTYPE/i);
  });

  it("responses: the streamed response id is the thread id and previous_response_id continues it", async () => {
    const events = [];
    for await (const e of client("responses-stream-text").responseStream({ input: "x" })) events.push(e);
    const done = events.at(-1) as { type: string; response: { id: string } };
    expect(done.type).toBe("response.completed");
    expect(threadIdFrom(done.response.id)).toBe(done.response.id);
    const next = loadFixture("live/responses-text");
    expect((next.response.body as { id: string }).id).toBe((next.request.body as { previous_response_id: string }).previous_response_id);
  });

  it("anthropic: streamed and non-streamed messages parse", async () => {
    const types: string[] = [];
    for await (const e of client("anthropic-stream-text").anthropicMessageStream({ messages: msgs })) types.push(e.type);
    expect(types[0]).toBe("message_start");
    expect(types.at(-1)).toBe("message_stop");
    const res = (await client("anthropic-text").anthropicMessage({ messages: msgs })) as { content: Array<{ text: string }>; stop_reason: string };
    expect(res.content[0]!.text).toContain("Hello from Viktor");
    expect(res.stop_reason).toBe("end_turn");
  });
});
