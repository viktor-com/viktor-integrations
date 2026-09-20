import { Agent, Runner, Usage, run, setTracingDisabled, tool, webSearchTool, type Model, type ModelRequest, type ModelResponse, type StreamEvent } from "@openai/agents";
import { createFixtureFetch, loadFixture } from "@viktor/integrations-core/testing";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ViktorAuthError,
  ViktorEmptyReplyError,
  ViktorProvider,
  ViktorRateLimitError,
  ViktorRunFailedError,
  viktorAgent,
  viktorDelegateTool,
  viktorModel,
} from "../src/index.js";

const ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3";
const base = { apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test" };
const settings = (fetch: ReturnType<typeof createFixtureFetch>, extra: Record<string, unknown> = {}) => ({ ...base, fetch: fetch as never, ...extra });

const getWeather = tool({
  name: "get_weather",
  description: "Get weather",
  parameters: z.object({ city: z.string(), units: z.string().nullable().optional() }),
  execute: async ({ city }) => `Sunny, 24C in ${city}`,
});

beforeAll(() => setTracingDisabled(true));

describe("run", () => {
  it("answers with only an API key: bearer auth, model viktor, compat path", async () => {
    const fetch = createFixtureFetch("chat-text");
    const agent = new Agent({ name: "A", instructions: "Be brief.", model: viktorModel(settings(fetch)) });
    const result = await run(agent, "Say hello in one sentence.");
    expect(result.finalOutput).toContain("Viktor");
    const req = fetch.requests[0]!;
    expect(req.url).toBe("https://viktor.test/api/compat/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer zt_test_sk_fixture");
    expect((req.body as { model: string }).model).toBe("viktor");
  });

  it("works as a ModelProvider for any model name", async () => {
    const fetch = createFixtureFetch("chat-text");
    const runner = new Runner({ modelProvider: new ViktorProvider(settings(fetch)), tracingDisabled: true });
    const result = await runner.run(new Agent({ name: "A", model: "gpt-whatever" }), "hi");
    expect(result.finalOutput).toContain("Viktor");
    expect((fetch.requests[0]!.body as { model: string }).model).toBe("viktor");
  });

  it("runs a tool loop: routed id goes back byte for byte and tools are re-declared", async () => {
    const fetch = createFixtureFetch("chat-tool-call", "chat-tool-result-followup");
    const agent = new Agent({ name: "A", model: viktorModel(settings(fetch)), tools: [getWeather] });
    const result = await run(agent, "weather in Berlin?");
    expect(result.finalOutput).toMatch(/sunny/i);
    expect(fetch.requests).toHaveLength(2);
    const followup = fetch.requests[1]!.body as { messages: Array<Record<string, unknown>>; tools: unknown[] };
    expect(followup.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: ROUTED_ID });
    expect((followup.messages.at(-2) as { tool_calls: Array<{ id: string }> }).tool_calls[0]!.id).toBe(ROUTED_ID);
    expect(followup.tools).toHaveLength(1);
  });

  it("streams text and a tool call, keeping the routed id and never leaking keep-alives", async () => {
    const fetch = createFixtureFetch("chat-stream-tool-call", "chat-stream-text");
    const agent = new Agent({ name: "A", model: viktorModel(settings(fetch)), tools: [getWeather] });
    const stream = await run(agent, "weather in Berlin?", { stream: true });
    let text = "";
    for await (const chunk of stream.toTextStream()) text += chunk;
    await stream.completed;
    expect(text).toContain("Hello from Viktor.");
    expect(text).not.toContain("keep-alive");
    const followup = fetch.requests[1]!.body as { messages: Array<Record<string, unknown>> };
    expect(followup.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: ROUTED_ID });
  });

  it("sends images as image_url parts", async () => {
    const png = (loadFixture("chat-image").request.body as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> }).messages[0]!.content[1]!.image_url!.url;
    const fetch = createFixtureFetch("chat-image");
    const agent = new Agent({ name: "A", model: viktorModel(settings(fetch)) });
    await run(agent, [{ role: "user", content: [{ type: "input_text", text: "What is in this picture?" }, { type: "input_image", image: png }] }]);
    const parts = (fetch.requests[0]!.body as { messages: Array<{ role: string; content: Array<{ type: string; image_url?: { url: string } }> }> }).messages.find((m) => m.role === "user")!.content;
    expect(parts.find((p) => p.type === "image_url")!.image_url!.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe("errors", () => {
  const agentOn = (fetch: ReturnType<typeof createFixtureFetch>, extra = {}) => new Agent({ name: "A", model: viktorModel(settings(fetch, extra)) });

  it("502 run_failed surfaces Viktor's message and the billed run is not retried", async () => {
    const fetch = createFixtureFetch("chat-run-failed");
    const err = await run(agentOn(fetch), "x").catch((e) => e);
    expect(err).toBeInstanceOf(ViktorRunFailedError);
    expect(err.message).toMatch(/empty response twice/);
    expect(fetch.requests).toHaveLength(1);
    expect(viktorModel(base).getRetryAdvice({ error: err })).toMatchObject({ suggested: false, replaySafety: "unsafe" });
  });

  it("an in-stream error frame fails the streamed run with ViktorRunFailedError", async () => {
    const stream = await run(agentOn(createFixtureFetch("chat-stream-run-failed")), "x", { stream: true });
    const failure = (async () => {
      for await (const _ of stream.toTextStream()) void _;
      await stream.completed;
    })();
    await expect(failure).rejects.toThrow(/run failed: The model returned an empty response twice/);
  });

  it("401 and 429 map to typed errors with hints and retry-after", async () => {
    const e401 = await run(agentOn(createFixtureFetch("chat-auth-401")), "x").catch((e) => e);
    expect(e401).toBeInstanceOf(ViktorAuthError);
    expect(e401.message).toMatch(/VIKTOR_API_KEY/);
    const e429 = await run(agentOn(createFixtureFetch("chat-rate-limit")), "x").catch((e) => e);
    expect(e429).toBeInstanceOf(ViktorRateLimitError);
    expect(viktorModel(base).getRetryAdvice({ error: e429 })).toMatchObject({ suggested: true, retryAfterMs: 17000 });
  });

  it("empty 200 reply is an error in strict mode", async () => {
    const err = await run(agentOn(createFixtureFetch("chat-empty-reply"), { strictEmptyReply: true }), "x").catch((e) => e);
    expect(err).toBeInstanceOf(ViktorEmptyReplyError);
  });

  it("rejects hosted tools before any request", async () => {
    const fetch = createFixtureFetch("chat-text");
    const agent = new Agent({ name: "A", model: viktorModel(settings(fetch)), tools: [webSearchTool()] });
    await expect(run(agent, "x")).rejects.toThrow(/cannot run hosted tools/);
    expect(fetch.requests).toHaveLength(0);
  });
});

describe("delegate tool and handoff", () => {
  it("uses the shared spec and runs the REST lifecycle", async () => {
    const spec = JSON.parse(readFileSync(new URL("../../../spec/delegate-tool.json", import.meta.url), "utf8"));
    const replies: Record<string, unknown> = {
      "POST /api/public/v1/threads": { thread: { id: "thr_1" }, message: { id: "m1" }, run: { id: "run_1", status: "queued" } },
      "GET /api/public/v1/runs/run_1": { id: "run_1", thread_id: "thr_1", status: "completed", error: null },
      "GET /api/public/v1/runs/run_1/result": { run_id: "run_1", status: "completed", markdown: "Report is ready.", json: null, artifacts: [] },
    };
    const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify(replies[`${init?.method ?? "GET"} ${String(input).replace("https://viktor.test", "")}`]), { status: 200 })) as typeof globalThis.fetch;
    const t = viktorDelegateTool({ ...base, fetch, pollIntervalMs: 1 });
    expect(t.name).toBe(spec.name);
    expect(t.description).toBe(spec.description);
    expect(t.parameters).toEqual(spec.input_schema);
    const out = await t.invoke({} as never, JSON.stringify({ task: "Write the Q3 report" }));
    expect(String(out)).toContain("Report is ready.");
    expect(String(out)).toContain("thread_id: thr_1");
  });

  it("a triage agent hands off to the Viktor agent", async () => {
    // Scripted triage model: asks for the handoff tool once.
    class TriageModel implements Model {
      async getResponse(request: ModelRequest): Promise<ModelResponse> {
        const handoff = request.handoffs[0]!;
        return {
          usage: new Usage(),
          output: [{ type: "function_call", callId: "call_triage_1", name: handoff.toolName, arguments: "{}", status: "completed" }],
        };
      }
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        throw new Error("not used");
      }
    }
    const fetch = createFixtureFetch("chat-text");
    const viktor = viktorAgent(settings(fetch));
    const triage = new Agent({ name: "Triage", instructions: "Route work.", model: new TriageModel(), handoffs: [viktor] });
    const result = await run(triage, "Please have Viktor say hello.");
    expect(result.lastAgent?.name).toBe("Viktor");
    expect(result.finalOutput).toContain("Viktor");
    expect(fetch.requests).toHaveLength(1);
  });
});
