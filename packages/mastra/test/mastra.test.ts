import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createFixtureFetch } from "@viktor-com/integrations-core/testing";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ViktorRunFailedError, viktorAgent, viktorDelegateTool, viktorModel, viktorModelConfig } from "../src/index.js";

const ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3";
const base = { apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test" };
const on = (fetch: ReturnType<typeof createFixtureFetch>, extra: Record<string, unknown> = {}) => ({ ...base, fetch: fetch as never, ...extra });

const getWeather = createTool({
  id: "get_weather",
  description: "Get weather",
  inputSchema: z.object({ city: z.string(), units: z.string().optional() }),
  execute: async (input) => `Sunny, 24C in ${(input as { city: string }).city}`,
});

function causeChain(e: unknown): unknown[] {
  const out: unknown[] = [];
  for (let c: unknown = e, i = 0; c && i < 6; c = (c as { cause?: unknown }).cause, i++) out.push(c);
  return out;
}

describe("Mastra agent on Viktor", () => {
  it("answers with only an API key: bearer auth, model viktor, compat path", async () => {
    const fetch = createFixtureFetch("chat-text");
    const agent = new Agent({ id: "a", name: "A", instructions: "Be brief.", model: viktorModel(on(fetch)) });
    const result = await agent.generate("Say hello in one sentence.");
    expect(result.text).toContain("Viktor");
    const req = fetch.requests[0]!;
    expect(req.url).toBe("https://viktor.test/api/compat/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer zt_test_sk_fixture");
    expect((req.body as { model: string }).model).toBe("viktor");
  });

  it("runs a tool loop: routed id goes back byte for byte and tools are re-declared", async () => {
    const fetch = createFixtureFetch("chat-tool-call", "chat-tool-result-followup");
    const agent = new Agent({ id: "a", name: "A", instructions: "Use tools.", model: viktorModel(on(fetch)), tools: { get_weather: getWeather } });
    const result = await agent.generate("weather in Berlin?");
    expect(result.text).toMatch(/sunny/i);
    expect(fetch.requests).toHaveLength(2);
    const followup = fetch.requests[1]!.body as { messages: Array<Record<string, unknown>>; tools: unknown[] };
    expect(followup.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: ROUTED_ID });
    expect((followup.messages.at(-2) as { tool_calls: Array<{ id: string }> }).tool_calls[0]!.id).toBe(ROUTED_ID);
    expect(followup.tools).toHaveLength(1);
  });

  it("streams text and a tool call without leaking keep-alives", async () => {
    const fetch = createFixtureFetch("chat-stream-tool-call", "chat-stream-text");
    const agent = new Agent({ id: "a", name: "A", instructions: "Use tools.", model: viktorModel(on(fetch)), tools: { get_weather: getWeather } });
    const stream = await agent.stream("weather in Berlin?");
    let text = "";
    for await (const chunk of stream.textStream) text += chunk;
    expect(text).toContain("Hello from Viktor.");
    expect(text).not.toContain("keep-alive");
    expect((fetch.requests[1]!.body as { messages: Array<Record<string, unknown>> }).messages.at(-1)).toMatchObject({ tool_call_id: ROUTED_ID });
  });

  it("502 run_failed carries Viktor's message and the billed run is not retried", async () => {
    const fetch = createFixtureFetch("chat-run-failed");
    const agent = new Agent({ id: "a", name: "A", instructions: "x", model: viktorModel(on(fetch)) });
    const err = await agent.generate("x").catch((e) => e);
    expect(causeChain(err).some((c) => c instanceof ViktorRunFailedError)).toBe(true);
    expect(String((err as Error).message)).toMatch(/empty response twice/);
    expect(fetch.requests).toHaveLength(1);
  });

  it("offers a config-only model for the model router", () => {
    expect(viktorModelConfig(base)).toEqual({ id: "viktor/viktor", url: "https://viktor.test/api/compat/v1", apiKey: "zt_test_sk_fixture", headers: undefined });
  });
});

describe("delegate tool and Viktor agent", () => {
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
    expect(t.id).toBe(spec.name);
    expect(t.description).toBe(spec.description);
    const out = (await t.execute!({ task: "Write the Q3 report" } as never, {} as never)) as { status: string; text: string };
    expect(out.status).toBe("completed");
    expect(out.text).toContain("thread_id: thr_1");
  });

  it("viktorAgent() is a named agent a supervisor can delegate to", async () => {
    const fetch = createFixtureFetch("chat-text");
    const viktor = viktorAgent(on(fetch));
    expect(viktor.id).toBe("viktor");
    expect(viktor.getDescription()).toMatch(/AI employee/);
    const result = await viktor.generate("hello");
    expect(result.text).toContain("Viktor");
  });
});
