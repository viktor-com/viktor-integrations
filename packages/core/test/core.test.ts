import { describe, expect, it, vi } from "vitest";
import {
  ViktorAuthError,
  ViktorEmptyReplyError,
  ViktorInvalidRequestError,
  ViktorRateLimitError,
  ViktorRunFailedError,
  createViktorClient,
  delegateToViktor,
  delegateToolSpec,
  formatDelegateResult,
  isRoutedToolId,
  threadIdFrom,
  type ChatStreamPart,
  type FetchLike,
} from "../src/index.js";
import { createFixtureFetch, listFixtures, loadFixture } from "../src/testing/index.js";

const ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3";

function client(fetch: FetchLike, extra: Record<string, unknown> = {}) {
  return createViktorClient({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", fetch, onWarning: () => {}, ...extra });
}

async function collect(gen: AsyncGenerator<ChatStreamPart>): Promise<ChatStreamPart[]> {
  const out: ChatStreamPart[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

describe("client basics", () => {
  it("sends bearer auth, forces model viktor, and targets the compat path", async () => {
    const fetch = createFixtureFetch("chat-text");
    const res = await client(fetch).chatCompletion({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.choices[0]!.message.content).toContain("Viktor");
    const req = fetch.requests[0]!;
    expect(req.url).toBe("https://viktor.test/api/compat/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer zt_test_sk_fixture");
    expect((req.body as { model: string }).model).toBe("viktor");
  });

  it("reads VIKTOR_API_KEY and VIKTOR_BASE_URL from the environment", async () => {
    vi.stubEnv("VIKTOR_API_KEY", "zt_test_sk_env");
    vi.stubEnv("VIKTOR_BASE_URL", "https://staging.viktor.test/");
    const fetch = createFixtureFetch("chat-text");
    const c = createViktorClient({ fetch });
    await c.chatCompletion({ messages: [{ role: "user", content: "hi" }] });
    expect(fetch.requests[0]!.url).toBe("https://staging.viktor.test/api/compat/v1/chat/completions");
    expect(fetch.requests[0]!.headers.authorization).toBe("Bearer zt_test_sk_env");
    expect(c.anthropicBaseURL).toBe("https://staging.viktor.test/api/compat");
    vi.unstubAllEnvs();
  });

  it("fails with a clear message when no key is configured", async () => {
    vi.stubEnv("VIKTOR_API_KEY", "");
    await expect(createViktorClient({ fetch: createFixtureFetch("chat-text") }).chatCompletion({ messages: [] })).rejects.toThrow(/VIKTOR_API_KEY/);
    vi.unstubAllEnvs();
  });
});

describe("streaming", () => {
  it("yields text deltas, ignores keep-alive comments, and reports usage", async () => {
    const parts = await collect(client(createFixtureFetch("chat-stream-text")).chatCompletionStream({ messages: [{ role: "user", content: "hi" }] }));
    const text = parts.filter((p) => p.type === "text-delta").map((p) => (p as { text: string }).text).join("");
    expect(text).toBe("Hello from Viktor.");
    expect(text).not.toContain("keep-alive");
    const finish = parts.at(-1) as Extract<ChatStreamPart, { type: "finish" }>;
    expect(finish.finishReason).toBe("stop");
    expect(finish.usage?.total_tokens).toBe(843);
  });

  it("assembles fragmented tool-call arguments by index and keeps the routed id", async () => {
    const parts = await collect(client(createFixtureFetch("chat-stream-tool-call")).chatCompletionStream({ messages: [{ role: "user", content: "weather?" }] }));
    const call = parts.find((p) => p.type === "tool-call") as Extract<ChatStreamPart, { type: "tool-call" }>;
    expect(call.toolCall.id).toBe(ROUTED_ID);
    expect(call.toolCall.name).toBe("get_weather");
    expect(JSON.parse(call.toolCall.arguments)).toEqual({ city: "Berlin", units: "metric" });
    expect((parts.at(-1) as { finishReason: string }).finishReason).toBe("tool_calls");
  });

  it("surfaces the in-stream error frame as ViktorRunFailedError with the worker message", async () => {
    const run = collect(client(createFixtureFetch("chat-stream-run-failed")).chatCompletionStream({ messages: [{ role: "user", content: "x" }] }));
    await expect(run).rejects.toBeInstanceOf(ViktorRunFailedError);
    await expect(collect(client(createFixtureFetch("chat-stream-run-failed")).chatCompletionStream({ messages: [] }))).rejects.toThrow(/empty response twice/);
  });

  it("flags a stream that ended without output: warning by default, error in strict mode", async () => {
    const warnings: string[] = [];
    await collect(client(createFixtureFetch("chat-stream-ended-without-output"), { onWarning: (m: string) => warnings.push(m) }).chatCompletionStream({ messages: [] }));
    expect(warnings.join()).toMatch(/ended without output/);
    const strict = collect(client(createFixtureFetch("chat-stream-ended-without-output"), { strictEmptyReply: true }).chatCompletionStream({ messages: [] }));
    await expect(strict).rejects.toBeInstanceOf(ViktorEmptyReplyError);
  });
});

describe("errors", () => {
  it("maps 502 run_failed", async () => {
    const err = await client(createFixtureFetch("chat-run-failed")).chatCompletion({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ViktorRunFailedError);
    expect(err.message).toMatch(/empty response twice/);
    expect(err.requestId).toBe("req_fixture_0001");
    expect(err.status).toBe(502);
  });

  it("maps an empty 200 reply: warning by default, ViktorEmptyReplyError in strict mode", async () => {
    const warnings: string[] = [];
    await client(createFixtureFetch("chat-empty-reply"), { onWarning: (m: string) => warnings.push(m) }).chatCompletion({ messages: [] });
    expect(warnings).toHaveLength(1);
    const err = await client(createFixtureFetch("chat-empty-reply"), { strictEmptyReply: true }).chatCompletion({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ViktorEmptyReplyError);
    expect(err.isRetryable).toBe(true);
  });

  it("maps 401 detail envelopes and 403 scope strings to ViktorAuthError with a hint", async () => {
    const e401 = await client(createFixtureFetch("chat-auth-401")).chatCompletion({ messages: [] }).catch((e) => e);
    expect(e401).toBeInstanceOf(ViktorAuthError);
    expect(e401.detailCode).toBe("invalid_api_key");
    expect(e401.message).toMatch(/VIKTOR_API_KEY/);
    const e403 = await client(createFixtureFetch("chat-scope-403")).chatCompletion({ messages: [] }).catch((e) => e);
    expect(e403).toBeInstanceOf(ViktorAuthError);
    expect(e403.detailCode).toBe("missing_scope");
  });

  it("maps 429 with Retry-After", async () => {
    const err = await client(createFixtureFetch("chat-rate-limit")).chatCompletion({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ViktorRateLimitError);
    expect(err.retryAfterSeconds).toBe(17);
    expect(err.detailCode).toBe("rate_limit_exceeded");
  });

  it("keeps finish_reason length visible (600 s cap)", async () => {
    const res = await client(createFixtureFetch("chat-timeout-length")).chatCompletion({ messages: [{ role: "user", content: "x" }] });
    expect(res.choices[0]!.finish_reason).toBe("length");
  });
});

describe("continuation", () => {
  it("extracts the thread id from routed ids and Responses ids only", () => {
    expect(threadIdFrom(ROUTED_ID)).toBe("zwKTTPTKCc9TVsSMgJuGh");
    expect(threadIdFrom("toolu_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3")).toBe("zwKTTPTKCc9TVsSMgJuGh");
    expect(threadIdFrom("zwKTTPTKCc9TVsSMgJuGh")).toBe("zwKTTPTKCc9TVsSMgJuGh");
    expect(threadIdFrom("call_abc123")).toBeNull();
    expect(threadIdFrom("chatcmpl-fx1")).toBeNull();
    expect(isRoutedToolId("call_abc123")).toBe(false);
  });

  it("sends tool results with the routed id unchanged and re-declares tools", async () => {
    const fx = loadFixture("chat-tool-result-followup");
    const fetch = createFixtureFetch("chat-tool-result-followup");
    const body = fx.request.body as { messages: never[]; tools: never[] };
    const res = await client(fetch).chatCompletion({ messages: body.messages, tools: body.tools });
    expect(res.choices[0]!.message.content).toMatch(/sunny/i);
    const sent = fetch.requests[0]!.body as { messages: Array<{ tool_call_id?: string }>; tools: unknown[] };
    expect(sent.messages.at(-1)!.tool_call_id).toBe(ROUTED_ID);
    expect(sent.tools).toHaveLength(1);
  });
});

describe("images", () => {
  it("accepts https and data URLs", async () => {
    const fx = loadFixture("chat-image");
    const fetch = createFixtureFetch("chat-image");
    await client(fetch).chatCompletion(fx.request.body as never);
    expect(fetch.requests).toHaveLength(1);
  });

  it("rejects http URLs, unsupported types and more than 10 images before any request", async () => {
    const fetch = createFixtureFetch("chat-text");
    const img = (url: string) => ({ type: "image_url", image_url: { url } });
    const c = client(fetch);
    await expect(c.chatCompletion({ messages: [{ role: "user", content: [img("http://example.com/a.png")] }] })).rejects.toThrow(/https/);
    await expect(c.chatCompletion({ messages: [{ role: "user", content: [img("data:image/tiff;base64,AAAA")] }] })).rejects.toBeInstanceOf(ViktorInvalidRequestError);
    const eleven = Array.from({ length: 11 }, () => img("https://example.com/a.png"));
    await expect(c.chatCompletion({ messages: [{ role: "user", content: eleven }] })).rejects.toThrow(/at most 10/);
    expect(fetch.requests).toHaveLength(0);
  });
});

describe("delegate tool", () => {
  function restFetch(script: Array<{ match: RegExp; status?: number; body: unknown }>): FetchLike & { calls: string[] } {
    const calls: string[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(input).replace("https://viktor.test", "")}`;
      calls.push(key);
      const idx = script.findIndex((s) => s.match.test(key));
      if (idx === -1) throw new Error(`unexpected request ${key}`);
      const [step] = script.splice(idx, 1);
      return new Response(JSON.stringify(step!.body), { status: step!.status ?? 200, headers: { "content-type": "application/json" } });
    }) as FetchLike & { calls: string[] };
    fn.calls = calls;
    return fn;
  }

  it("has one spec shared by every adapter", () => {
    expect(delegateToolSpec.name).toBe("delegate_to_viktor");
    expect(delegateToolSpec.input_schema.required).toEqual(["task"]);
  });

  it("creates a thread, polls the run, and returns result with resolved artifacts", async () => {
    const fetch = restFetch([
      { match: /^POST \/api\/public\/v1\/threads$/, status: 202, body: { thread: { id: "thr_1" }, message: { id: "m1" }, run: { id: "run_1", status: "queued" } } },
      { match: /^GET \/api\/public\/v1\/runs\/run_1$/, body: { id: "run_1", thread_id: "thr_1", status: "in_progress", error: null } },
      { match: /^GET \/api\/public\/v1\/runs\/run_1$/, body: { id: "run_1", thread_id: "thr_1", status: "completed", error: null } },
      { match: /^GET \/api\/public\/v1\/runs\/run_1\/result$/, body: { run_id: "run_1", status: "completed", markdown: "Done.", json: null, artifacts: [{ id: "ftok", display_name: "report.pdf", content_type: "application/pdf" }] } },
      { match: /^GET \/api\/public\/v1\/files\/ftok\/download-url$/, body: { run_id: "run_1", url: "/api/public/v1/files/downloads/signed", expires_at: "2026-09-20T12:00:00Z" } },
    ]);
    const statuses: string[] = [];
    const result = await delegateToViktor(client(fetch), { task: "Write the report" }, { pollIntervalMs: 1, onStatus: (s) => statuses.push(s) });
    expect(result).toMatchObject({ status: "completed", markdown: "Done.", thread_id: "thr_1", run_id: "run_1" });
    expect(result.artifacts[0]!.download_url).toBe("https://viktor.test/api/public/v1/files/downloads/signed");
    expect(statuses).toEqual(["in_progress", "completed"]);
    expect(formatDelegateResult(result)).toContain("thread_id: thr_1");
  });

  it("posts to an existing thread when thread_id is given and reports requires_action as a result", async () => {
    const fetch = restFetch([
      { match: /^POST \/api\/public\/v1\/threads\/thr_1\/messages$/, status: 202, body: { message: { id: "m2" }, run: { id: "run_2", status: "queued" } } },
      { match: /^GET \/api\/public\/v1\/runs\/run_2$/, body: { id: "run_2", thread_id: "thr_1", status: "requires_action", error: null } },
      { match: /^GET \/api\/public\/v1\/runs\/run_2\/result$/, body: { run_id: "run_2", status: "requires_action", markdown: "Which quarter?", json: null, artifacts: [] } },
    ]);
    const result = await delegateToViktor(client(fetch), { task: "Q3", thread_id: "thr_1" }, { pollIntervalMs: 1 });
    expect(result.status).toBe("requires_action");
    expect(formatDelegateResult(result)).toMatch(/needs input/);
    expect(fetch.calls[0]).toBe("POST /api/public/v1/threads/thr_1/messages");
  });

  it("returns timed_out with the run id and does not cancel the run", async () => {
    const fetch = restFetch([
      { match: /^POST \/api\/public\/v1\/threads$/, status: 202, body: { thread: { id: "thr_3" }, message: { id: "m" }, run: { id: "run_3", status: "queued" } } },
      { match: /^GET \/api\/public\/v1\/runs\/run_3$/, body: { id: "run_3", thread_id: "thr_3", status: "in_progress", error: null } },
    ]);
    const result = await delegateToViktor(client(fetch), { task: "long", timeout_seconds: 0 }, { pollIntervalMs: 1 });
    expect(result).toMatchObject({ status: "timed_out", run_id: "run_3", thread_id: "thr_3" });
    expect(fetch.calls.some((c) => c.includes("cancel"))).toBe(false);
  });
});

describe("fixtures", () => {
  it("are all well-formed and declare their provenance", () => {
    const names = listFixtures();
    expect(names.length).toBeGreaterThanOrEqual(14);
    for (const n of names) {
      const fx = loadFixture(n);
      expect(["contract", "live"]).toContain(fx.provenance);
      expect(fx.response.body !== undefined || fx.response.sse !== undefined).toBe(true);
    }
  });
});

describe("helpers for adapters", () => {
  it("builds the run-failed error from a stream frame or a bare error object, keeping the cause", async () => {
    const { runFailedFromStreamFrame, errorFromResponse, EMPTY_REPLY_MESSAGE, ViktorEmptyReplyError: Empty } = await import("../src/index.js");
    const cause = new Error("sdk error");
    const a = runFailedFromStreamFrame({ error: { message: "boom", code: "run_failed" } }, { cause });
    const b = runFailedFromStreamFrame({ message: "boom", code: "run_failed" });
    expect(a.message).toBe("Viktor run failed: boom");
    expect(b.detailCode).toBe("run_failed");
    expect(a.cause).toBe(cause);
    expect(errorFromResponse({ status: 401, body: { detail: { error: "invalid_api_key", message: "x" } }, cause }).cause).toBe(cause);
    expect(new Empty().message).toBe(EMPTY_REPLY_MESSAGE);
  });
});

describe("responses wire", () => {
  it("streams text deltas and exposes the response id, which is the Viktor thread id", async () => {
    const events = [];
    for await (const e of client(createFixtureFetch("responses-stream-text")).responseStream({ input: "hi" })) events.push(e);
    const text = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
    expect(text).toBe("Hello from Viktor.");
    const done = events.at(-1) as { type: string; response: { id: string } };
    expect(done.type).toBe("response.completed");
    expect(threadIdFrom(done.response.id)).toBe("zwKTTPTKCc9TVsSMgJuGh");
  });

  it("raises ViktorRunFailedError on response.failed and drops the [Stream error: …] text delta", async () => {
    const seen: string[] = [];
    const run = (async () => {
      for await (const e of client(createFixtureFetch("responses-stream-failed")).responseStream({ input: "x" })) {
        if (e.type === "response.output_text.delta") seen.push(String(e.delta));
      }
    })();
    await expect(run).rejects.toBeInstanceOf(ViktorRunFailedError);
    expect(seen).toEqual([]);
  });

  it("sends previous_response_id through on non-streaming calls", async () => {
    const fetch = createFixtureFetch("responses-text");
    const res = await client(fetch).response({ input: "Say hello.", previous_response_id: "zwKTTPTKCc9TVsSMgJuGh" });
    expect(res.id).toBe("zwKTTPTKCc9TVsSMgJuGh");
    expect((fetch.requests[0]!.body as { previous_response_id: string; model: string }).previous_response_id).toBe("zwKTTPTKCc9TVsSMgJuGh");
  });
});

describe("stream frame shapes across SDK versions", () => {
  it("accepts the frame as an object, a bare error object, or only the message string", async () => {
    const { runFailedFromStreamFrame } = await import("../src/index.js");
    expect(runFailedFromStreamFrame("boom").message).toBe("Viktor run failed: boom");
    expect(runFailedFromStreamFrame({ message: "boom" }).message).toBe("Viktor run failed: boom");
    expect(runFailedFromStreamFrame({ error: { message: "boom" } }).message).toBe("Viktor run failed: boom");
  });
});

describe("anthropic wire", () => {
  it("treats event: error as terminal: raises ViktorRunFailedError and never yields the [Stream error: …] text block", async () => {
    const fetch = createFixtureFetch("anthropic-stream-failed");
    const seen: string[] = [];
    const run = (async () => {
      for await (const e of client(fetch).anthropicMessageStream({ messages: [{ role: "user", content: "x" }] })) seen.push(e.type);
    })();
    await expect(run).rejects.toThrow(/empty response twice/);
    expect(seen).toEqual(["message_start", "ping"]);
    const req = fetch.requests[0]!;
    expect(req.url).toBe("https://viktor.test/api/compat/v1/messages");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
  });
});
