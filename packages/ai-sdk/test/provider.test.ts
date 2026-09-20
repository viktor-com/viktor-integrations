import { APICallError } from "@ai-sdk/provider";
import { createFixtureFetch, loadFixture } from "@viktor/integrations-core/testing";
import { generateText, isStepCount, jsonSchema, streamText, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  VIKTOR_DELEGATE_TOOL_NAME,
  ViktorAuthError,
  ViktorEmptyReplyError,
  ViktorRateLimitError,
  ViktorRunFailedError,
  createViktor,
  viktorDelegate,
} from "../src/index.js";

const ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3";

function provider(fetch: ReturnType<typeof createFixtureFetch>, extra: Record<string, unknown> = {}) {
  return createViktor({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", fetch: fetch as never, ...extra });
}

const weather = tool({
  description: "Get weather",
  inputSchema: z.object({ city: z.string(), units: z.string().optional() }),
  execute: async ({ city }) => `Sunny, 24C in ${city}`,
});

describe("generateText", () => {
  it("answers with only an API key, sends bearer auth and model viktor", async () => {
    const fetch = createFixtureFetch("chat-text");
    const result = await generateText({ model: provider(fetch)(), prompt: "Say hello in one sentence." });
    expect(result.text).toContain("Viktor");
    expect(result.usage.totalTokens).toBe(801);
    const req = fetch.requests[0]!;
    expect(req.url).toBe("https://viktor.test/api/compat/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer zt_test_sk_fixture");
    expect((req.body as { model: string }).model).toBe("viktor");
  });

  it("reads VIKTOR_API_KEY lazily from the environment", async () => {
    vi.stubEnv("VIKTOR_API_KEY", "zt_test_sk_env");
    const fetch = createFixtureFetch("chat-text");
    await generateText({ model: createViktor({ baseURL: "https://viktor.test", fetch: fetch as never })(), prompt: "hi" });
    expect(fetch.requests[0]!.headers.authorization).toBe("Bearer zt_test_sk_env");
    vi.unstubAllEnvs();
  });

  it("runs a tool loop: routed tool-call id goes back byte for byte and tools are re-declared", async () => {
    const fetch = createFixtureFetch("chat-tool-call", "chat-tool-result-followup");
    const result = await generateText({
      model: provider(fetch)(),
      tools: { get_weather: weather },
      stopWhen: isStepCount(3),
      prompt: "weather in Berlin?",
    });
    expect(result.text).toMatch(/sunny/i);
    expect(result.steps[0]!.toolCalls[0]!.toolCallId).toBe(ROUTED_ID);
    expect(fetch.requests).toHaveLength(2);
    const followup = fetch.requests[1]!.body as { messages: Array<Record<string, unknown>>; tools: unknown[] };
    const toolMsg = followup.messages.at(-1)!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe(ROUTED_ID);
    const assistant = followup.messages.at(-2) as { tool_calls: Array<{ id: string }> };
    expect(assistant.tool_calls[0]!.id).toBe(ROUTED_ID);
    expect(followup.tools).toHaveLength(1);
    expect(result.steps[0]!.providerMetadata?.viktor?.threadId).toBe("zwKTTPTKCc9TVsSMgJuGh");
  });

  it("flags the 600 s run cap in provider metadata", async () => {
    const result = await generateText({ model: provider(createFixtureFetch("chat-timeout-length"))(), prompt: "long" });
    expect(result.finishReason).toBe("length");
    expect(result.providerMetadata?.viktor?.runCapReached).toBe(true);
  });
});

describe("streamText", () => {
  it("streams text and ignores keep-alive comments", async () => {
    const result = streamText({ model: provider(createFixtureFetch("chat-stream-text"))(), prompt: "Stream a short greeting." });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe("Hello from Viktor.");
    expect((await result.usage).totalTokens).toBe(843);
  });

  it("yields tool calls with the routed id unchanged", async () => {
    const result = streamText({
      model: provider(createFixtureFetch("chat-stream-tool-call"))(),
      tools: { get_weather: tool({ description: "Get weather", inputSchema: z.object({ city: z.string(), units: z.string().optional() }) }) },
      prompt: "weather in Berlin?",
    });
    const calls = await result.toolCalls;
    expect(calls[0]!.toolCallId).toBe(ROUTED_ID);
    expect(calls[0]!.input).toEqual({ city: "Berlin", units: "metric" });
    expect(await result.finishReason).toBe("tool-calls");
  });

  it("surfaces Viktor's in-stream error frame as ViktorRunFailedError with the worker message", async () => {
    const errors: unknown[] = [];
    const result = streamText({
      model: provider(createFixtureFetch("chat-stream-run-failed"))(),
      prompt: "x",
      onError: ({ error }) => void errors.push(error),
    });
    await result.consumeStream();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ViktorRunFailedError);
    expect((errors[0] as Error).message).toMatch(/run failed: The model returned an empty response twice/);
  });

  it("reports a stream that ended without output in strict mode", async () => {
    const errors: unknown[] = [];
    const result = streamText({
      model: provider(createFixtureFetch("chat-stream-ended-without-output"), { strictEmptyReply: true })(),
      prompt: "x",
      onError: ({ error }) => void errors.push(error),
    });
    await result.consumeStream();
    expect(errors[0]).toBeInstanceOf(ViktorEmptyReplyError);
  });
});

describe("errors", () => {
  it("502 run_failed: APICallError with ViktorRunFailedError cause, and the billed run is not retried", async () => {
    const fetch = createFixtureFetch("chat-run-failed");
    const err = await generateText({ model: provider(fetch)(), prompt: "x" }).catch((e) => e);
    expect(APICallError.isInstance(err)).toBe(true);
    expect(err.isRetryable).toBe(false);
    expect(err.cause).toBeInstanceOf(ViktorRunFailedError);
    expect(err.message).toMatch(/empty response twice/);
    expect(fetch.requests).toHaveLength(1);
  });

  it("401: explains how to fix the key", async () => {
    const err = await generateText({ model: provider(createFixtureFetch("chat-auth-401"))(), prompt: "x", maxRetries: 0 }).catch((e) => e);
    expect(err.cause).toBeInstanceOf(ViktorAuthError);
    expect(err.message).toMatch(/VIKTOR_API_KEY/);
    expect(err.data.viktor.detailCode).toBe("invalid_api_key");
  });

  it("429: retryable with Retry-After preserved", async () => {
    const err = await generateText({ model: provider(createFixtureFetch("chat-rate-limit"))(), prompt: "x", maxRetries: 0 }).catch((e) => e);
    expect(err.cause).toBeInstanceOf(ViktorRateLimitError);
    expect(err.cause.retryAfterSeconds).toBe(17);
    expect(err.isRetryable).toBe(true);
  });

  it("empty 200 reply: warning by default, ViktorEmptyReplyError in strict mode", async () => {
    const lenient = await generateText({ model: provider(createFixtureFetch("chat-empty-reply"))(), prompt: "x" });
    expect(lenient.warnings?.some((w) => w.type === "other" && /empty reply/.test(w.message))).toBe(true);
    const strict = generateText({ model: provider(createFixtureFetch("chat-empty-reply"), { strictEmptyReply: true })(), prompt: "x", maxRetries: 0 });
    await expect(strict).rejects.toBeInstanceOf(ViktorEmptyReplyError);
  });
});

describe("images", () => {
  const png = (loadFixture("chat-image").request.body as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> }).messages[0]!.content[1]!.image_url!.url;

  it("sends data-URL and https images as image_url parts", async () => {
    const fetch = createFixtureFetch("chat-image");
    await generateText({
      model: provider(fetch)(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this picture?" },
            { type: "file", mediaType: "image/png", data: png.split(",")[1]! },
            { type: "file", mediaType: "image/png", data: new URL("https://example.com/cat.png") },
          ],
        },
      ],
    });
    const parts = (fetch.requests[0]!.body as { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> }).messages[0]!.content;
    expect(parts[1]!.image_url!.url).toMatch(/^data:image\/png;base64,/);
    expect(parts[2]!.image_url!.url).toBe("https://example.com/cat.png");
  });

  it("rejects non-image files and more than 10 images before any request", async () => {
    const fetch = createFixtureFetch("chat-text");
    const pdf = generateText({
      model: provider(fetch)(),
      messages: [{ role: "user", content: [{ type: "file", mediaType: "application/pdf", data: "AAAA" }] }],
    });
    await expect(pdf).rejects.toThrow(/image attachments only/);
    const many = generateText({
      model: provider(fetch)(),
      messages: [{ role: "user", content: Array.from({ length: 11 }, () => ({ type: "file" as const, mediaType: "image/png", data: png.split(",")[1]! })) }],
    });
    await expect(many).rejects.toThrow(/at most 10/);
    expect(fetch.requests).toHaveLength(0);
  });
});

describe("viktorDelegate tool", () => {
  it("uses the shared spec for name, description and schema", async () => {
    const spec = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../../../spec/delegate-tool.json", import.meta.url), "utf8"));
    const t = viktorDelegate();
    expect(VIKTOR_DELEGATE_TOOL_NAME).toBe(spec.name);
    expect(t.description).toBe(spec.description);
    expect((t.inputSchema as ReturnType<typeof jsonSchema>).jsonSchema).toEqual(spec.input_schema);
  });

  it("delegates over REST and gives the model a readable result", async () => {
    const calls: string[] = [];
    const replies: Record<string, unknown> = {
      "POST /api/public/v1/threads": { thread: { id: "thr_1" }, message: { id: "m1" }, run: { id: "run_1", status: "queued" } },
      "GET /api/public/v1/runs/run_1": { id: "run_1", thread_id: "thr_1", status: "completed", error: null },
      "GET /api/public/v1/runs/run_1/result": { run_id: "run_1", status: "completed", markdown: "Report is ready.", json: null, artifacts: [] },
    };
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(input).replace("https://viktor.test", "")}`;
      calls.push(key);
      return new Response(JSON.stringify(replies[key]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const t = viktorDelegate({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", fetch, pollIntervalMs: 1 });
    const output = await t.execute!({ task: "Write the Q3 report" }, { toolCallId: "c1", messages: [] } as never);
    expect(output).toMatchObject({ status: "completed", markdown: "Report is ready.", thread_id: "thr_1" });
    const modelOutput = await t.toModelOutput!({ toolCallId: "c1", input: { task: "x" }, output } as never);
    expect(modelOutput).toMatchObject({ type: "text" });
    expect((modelOutput as { value: string }).value).toContain("thread_id: thr_1");
    expect(calls[0]).toBe("POST /api/public/v1/threads");
  });
});
