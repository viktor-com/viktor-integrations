import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createFixtureFetch, loadFixture, type FixtureFetch } from "@viktor/integrations-core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChatViktor, ViktorAuthError, ViktorEmptyReplyError, ViktorRateLimitError, ViktorRunFailedError, type ChatViktorFields } from "../src/index.js";

const ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3";

function chat(fetch: FixtureFetch, extra: ChatViktorFields = {}) {
  return new ChatViktor({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", configuration: { fetch }, ...extra });
}

const getWeather = tool(async ({ city }: { city: string }) => `Sunny, 24C in ${city}`, {
  name: "get_weather",
  description: "Get weather",
  schema: z.object({ city: z.string(), units: z.string().optional() }),
});

interface ChatBody {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
  tools?: Array<{ type: string; function: { name: string; parameters: unknown } }>;
}
const body = (fetch: FixtureFetch, index = 0) => fetch.requests[index]!.body as ChatBody;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ChatViktor.invoke", () => {
  it("answers with only an API key, sends bearer auth and model viktor", async () => {
    const fetch = createFixtureFetch("chat-text");
    const reply = await chat(fetch).invoke("Say hello in one sentence.");
    expect(reply.text).toContain("Viktor");
    expect(reply.usage_metadata?.total_tokens).toBe(801);
    const req = fetch.requests[0]!;
    expect(req.url).toBe("https://viktor.test/api/compat/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer zt_test_sk_fixture");
    expect(body(fetch).model).toBe("viktor");
    expect(reply.response_metadata.viktor_thread_id).toBeNull();
    expect(reply.response_metadata.run_cap_reached).toBe(false);
  });

  it("reads VIKTOR_API_KEY lazily from the environment and VIKTOR_BASE_URL at construction", async () => {
    const fetch = createFixtureFetch("chat-text");
    vi.stubEnv("VIKTOR_BASE_URL", "https://env.viktor.test/");
    const model = new ChatViktor({ configuration: { fetch } });
    vi.stubEnv("VIKTOR_API_KEY", "zt_test_sk_env");
    await model.invoke("hi");
    expect(fetch.requests[0]!.url).toBe("https://env.viktor.test/api/compat/v1/chat/completions");
    expect(fetch.requests[0]!.headers.authorization).toBe("Bearer zt_test_sk_env");
  });

  it("fails with a clear message when no API key is configured", async () => {
    vi.stubEnv("VIKTOR_API_KEY", "");
    const fetch = createFixtureFetch("chat-text");
    await expect(new ChatViktor({ baseURL: "https://viktor.test", configuration: { fetch } }).invoke("hi")).rejects.toThrow(/VIKTOR_API_KEY/);
    expect(fetch.requests).toHaveLength(0);
  });

  it("identifies itself as a Viktor model with Viktor defaults", () => {
    const model = chat(createFixtureFetch("chat-text"));
    expect(ChatViktor.lc_name()).toBe("ChatViktor");
    expect(model._llmType()).toBe("viktor");
    expect(model.model).toBe("viktor");
    expect(model.timeout).toBe(660_000);
    expect((model.caller as unknown as { maxRetries: number }).maxRetries).toBe(0);
    expect(model.lc_secrets).toEqual({ apiKey: "VIKTOR_API_KEY" });
    expect(model.getLsParams({} as never).ls_provider).toBe("viktor");
    expect(JSON.stringify(model.toJSON())).not.toContain("zt_test_sk_fixture");
  });

  it("tool loop: routed tool-call id goes back byte for byte and tools are re-declared", async () => {
    const fetch = createFixtureFetch("chat-tool-call", "chat-tool-result-followup");
    const model = chat(fetch).bindTools([getWeather]);
    expect(model).toBeInstanceOf(ChatViktor);
    const question = new HumanMessage("weather in Berlin?");
    const first = await model.invoke([question]);
    expect(first.tool_calls).toHaveLength(1);
    expect(first.tool_calls![0]!.id).toBe(ROUTED_ID);
    expect(first.response_metadata.viktor_thread_id).toBe("zwKTTPTKCc9TVsSMgJuGh");

    const toolMessage: ToolMessage = await getWeather.invoke(first.tool_calls![0]!);
    const assistant = new AIMessage({ content: first.content, tool_calls: first.tool_calls });
    const second = await model.invoke([question, assistant, toolMessage]);
    expect(second.text).toMatch(/sunny/i);

    expect(fetch.requests).toHaveLength(2);
    const followup = body(fetch, 1);
    expect(followup.messages.at(-1)!.role).toBe("tool");
    expect(followup.messages.at(-1)!.tool_call_id).toBe(ROUTED_ID);
    expect(followup.messages.at(-2)!.tool_calls![0]!.id).toBe(ROUTED_ID);
    expect(followup.tools).toHaveLength(1);
    expect(followup.tools![0]!.function.name).toBe("get_weather");
    expect(followup.tools).toEqual(body(fetch, 0).tools);
  });

  it("flags the 600 s run cap in response_metadata", async () => {
    const reply = await chat(createFixtureFetch("chat-timeout-length")).invoke("long");
    expect(reply.response_metadata.finish_reason).toBe("length");
    expect(reply.response_metadata.run_cap_reached).toBe(true);
  });

  it("rejects hosted tools before any request", async () => {
    const fetch = createFixtureFetch("chat-text");
    const model = chat(fetch).bindTools([{ type: "web_search_preview" }]);
    await expect(model.invoke("x")).rejects.toThrow(/hosted tool "web_search_preview"/);
    expect(fetch.requests).toHaveLength(0);
  });
});

describe("ChatViktor Responses API", () => {
  it("useResponsesApi: previous_response_id goes out and the response id is surfaced as viktor_thread_id", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const reply = {
        id: "zwKTTPTKCc9TVsSMgJuGh",
        object: "response",
        created_at: 1758300000,
        status: "completed",
        model: "viktor",
        output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Still here.", annotations: [] }] }],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    };
    const model = new ChatViktor({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", configuration: { fetch }, useResponsesApi: true });
    const reply = await model.invoke("And then?", { previous_response_id: "zwKTTPTKCc9TVsSMgJuGh" });
    expect(requests[0]!.url).toBe("https://viktor.test/api/compat/v1/responses");
    expect(requests[0]!.body).toMatchObject({ model: "viktor", previous_response_id: "zwKTTPTKCc9TVsSMgJuGh" });
    expect(reply.text).toBe("Still here.");
    expect(reply.response_metadata.viktor_thread_id).toBe("zwKTTPTKCc9TVsSMgJuGh");
  });
});

describe("ChatViktor.stream", () => {
  it("streams text; keep-alive comments never surface", async () => {
    const fetch = createFixtureFetch("chat-stream-text");
    const chunks: AIMessageChunk[] = [];
    for await (const chunk of await chat(fetch).stream("Stream a short greeting.")) chunks.push(chunk);
    expect(chunks.map((c) => c.text).join("")).toBe("Hello from Viktor.");
    expect(chunks.some((c) => c.text.includes("keep-alive"))).toBe(false);
    const full = chunks.reduce((a, b) => a.concat(b));
    expect(full.usage_metadata?.total_tokens).toBe(843);
    expect(full.response_metadata.run_cap_reached).toBe(false);
    expect(body(fetch).stream).toBe(true);
    expect(body(fetch).model).toBe("viktor");
  });

  it("assembles fragmented tool-call arguments and keeps the routed id unchanged", async () => {
    const model = chat(createFixtureFetch("chat-stream-tool-call")).bindTools([getWeather]);
    let full: AIMessageChunk | undefined;
    for await (const chunk of await model.stream("weather in Berlin?")) full = full ? full.concat(chunk) : chunk;
    expect(full!.tool_calls).toHaveLength(1);
    expect(full!.tool_calls![0]).toMatchObject({ id: ROUTED_ID, name: "get_weather", args: { city: "Berlin", units: "metric" } });
    expect(full!.response_metadata.finish_reason).toBe("tool_calls");
    expect(full!.response_metadata.viktor_thread_id).toBe("zwKTTPTKCc9TVsSMgJuGh");
  });

  it("in-stream error frame: ViktorRunFailedError with the worker message, not a silent end of stream", async () => {
    const consume = async () => {
      for await (const _ of await chat(createFixtureFetch("chat-stream-run-failed")).stream("x")) void _;
    };
    const err = await consume().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViktorRunFailedError);
    expect((err as ViktorRunFailedError).message).toMatch(/The model returned an empty response twice/);
    expect((err as ViktorRunFailedError).detailCode).toBe("run_failed");
    expect((err as Error).cause).toBeInstanceOf(Error);
  });

  it("in-stream error frame also fails the content-block event stream (streamEvents v3)", async () => {
    const consume = async () => {
      for await (const _ of chat(createFixtureFetch("chat-stream-run-failed")).streamEvents("x")) void _;
    };
    await expect(consume()).rejects.toBeInstanceOf(ViktorRunFailedError);
  });

  it("in-stream error frame fails invoke() on a model constructed with streaming: true", async () => {
    await expect(chat(createFixtureFetch("chat-stream-run-failed"), { streaming: true }).invoke("x")).rejects.toBeInstanceOf(ViktorRunFailedError);
  });

  it("stream that ended without output: warning by default, ViktorEmptyReplyError in strict mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for await (const _ of await chat(createFixtureFetch("chat-stream-ended-without-output")).stream("x")) void _;
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/empty reply/));
    const strict = async () => {
      for await (const _ of await chat(createFixtureFetch("chat-stream-ended-without-output"), { strictEmptyReply: true }).stream("x")) void _;
    };
    await expect(strict()).rejects.toBeInstanceOf(ViktorEmptyReplyError);
  });
});

describe("ChatViktor errors", () => {
  it("502 run_failed: ViktorRunFailedError carrying Viktor's message; the billed run is not retried", async () => {
    const fetch = createFixtureFetch("chat-run-failed");
    const err = await chat(fetch).invoke("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViktorRunFailedError);
    expect((err as ViktorRunFailedError).message).toMatch(/empty response twice/);
    expect((err as ViktorRunFailedError).status).toBe(502);
    expect((err as ViktorRunFailedError).requestId).toBe("req_fixture_0001");
    expect((err as Error).cause).toMatchObject({ status: 502 });
    expect(fetch.requests).toHaveLength(1);
  });

  it("502 run_failed is not retried even when maxRetries is raised", async () => {
    const fetch = createFixtureFetch("chat-run-failed");
    await expect(chat(fetch, { maxRetries: 3 }).invoke("x")).rejects.toBeInstanceOf(ViktorRunFailedError);
    expect(fetch.requests).toHaveLength(1);
  });

  it("401: ViktorAuthError with the fix hint", async () => {
    const fetch = createFixtureFetch("chat-auth-401");
    const err = await chat(fetch, { maxRetries: 3 }).invoke("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViktorAuthError);
    expect((err as ViktorAuthError).message).toMatch(/VIKTOR_API_KEY/);
    expect((err as ViktorAuthError).detailCode).toBe("invalid_api_key");
    expect((err as { lc_error_code?: string }).lc_error_code).toBe("MODEL_AUTHENTICATION");
    expect(fetch.requests).toHaveLength(1);
  });

  it("429: ViktorRateLimitError with retry-after", async () => {
    const err = await chat(createFixtureFetch("chat-rate-limit")).invoke("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViktorRateLimitError);
    expect((err as ViktorRateLimitError).retryAfterSeconds).toBe(17);
    expect((err as ViktorRateLimitError).isRetryable).toBe(true);
    expect((err as { lc_error_code?: string }).lc_error_code).toBe("MODEL_RATE_LIMIT");
  });

  it("empty 200 reply: warning by default, ViktorEmptyReplyError in strict mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lenient = await chat(createFixtureFetch("chat-empty-reply")).invoke("x");
    expect(lenient.text).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/empty reply/));
    await expect(chat(createFixtureFetch("chat-empty-reply"), { strictEmptyReply: true }).invoke("x")).rejects.toBeInstanceOf(ViktorEmptyReplyError);
  });
});

describe("ChatViktor images", () => {
  type ImageBody = { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> };
  const png = (loadFixture("chat-image").request.body as ImageBody).messages[0]!.content[1]!.image_url!.url;

  it("sends standard image blocks and image_url parts to Viktor as image_url", async () => {
    const fetch = createFixtureFetch("chat-image");
    const message = new HumanMessage({
      content: [
        { type: "text", text: "What is in this picture?" },
        { type: "image", source_type: "base64", mime_type: "image/png", data: png.split(",")[1]! },
        { type: "image", source_type: "url", url: "https://example.com/cat.png" },
        { type: "image_url", image_url: { url: png } },
      ],
    });
    await chat(fetch).invoke([message]);
    const parts = (fetch.requests[0]!.body as ImageBody).messages[0]!.content;
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url", "image_url", "image_url"]);
    expect(parts[1]!.image_url!.url).toBe(png);
    expect(parts[2]!.image_url!.url).toBe("https://example.com/cat.png");
    expect(parts[3]!.image_url!.url).toBe(png);
  });

  it("rejects http URLs, unsupported types, non-image files and more than 10 images before any request", async () => {
    const fetch = createFixtureFetch("chat-text");
    const model = chat(fetch);
    const ask = (content: Array<Record<string, unknown>>) => model.invoke([new HumanMessage({ content } as never)]);
    await expect(ask([{ type: "image_url", image_url: { url: "http://example.com/cat.png" } }])).rejects.toThrow(/https/);
    await expect(ask([{ type: "image", source_type: "base64", mime_type: "image/tiff", data: "AAAA" }])).rejects.toThrow(/image\/tiff/);
    await expect(ask([{ type: "file", source_type: "base64", mime_type: "application/pdf", data: "AAAA" }])).rejects.toThrow(/image attachments only/);
    await expect(ask(Array.from({ length: 11 }, () => ({ type: "image_url", image_url: { url: png } })))).rejects.toThrow(/at most 10/);
    const streamed = async () => {
      for await (const _ of await model.stream([new HumanMessage({ content: [{ type: "image_url", image_url: { url: "http://example.com/a.png" } }] })])) void _;
    };
    await expect(streamed()).rejects.toThrow(/https/);
    expect(fetch.requests).toHaveLength(0);
  });
});
