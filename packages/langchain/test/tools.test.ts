import { readFile } from "node:fs/promises";
import type { ToolMessage } from "@langchain/core/messages";
import { createFixtureFetch } from "@viktor-com/integrations-core/testing";
import { describe, expect, it } from "vitest";
import { ChatViktor, VIKTOR_DELEGATE_TOOL_NAME, viktorDelegateTool, type DelegateResult } from "../src/index.js";

const spec = JSON.parse(await readFile(new URL("../../../spec/delegate-tool.json", import.meta.url), "utf8")) as {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

function scriptedRest(replies: Record<string, unknown>) {
  const calls: Array<{ key: string; authorization: string | null; body: unknown }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input).replace("https://viktor.test", "")}`;
    calls.push({ key, authorization: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(replies[key]), { status: key in replies ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("viktorDelegateTool", () => {
  it("delegate tool schema: what LangChain sends to the model equals spec/delegate-tool.json", async () => {
    const delegate = viktorDelegateTool();
    expect(VIKTOR_DELEGATE_TOOL_NAME).toBe(spec.name);
    expect(delegate.name).toBe("delegate_to_viktor");
    expect(delegate.description).toBe(spec.description);

    const fetch = createFixtureFetch("chat-text");
    const model = new ChatViktor({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", configuration: { fetch } });
    await model.bindTools([delegate]).invoke("hi");
    const sent = (fetch.requests[0]!.body as { tools: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }> }).tools;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("function");
    expect(sent[0]!.function.name).toBe(spec.name);
    expect(sent[0]!.function.description).toBe(spec.description);
    expect(sent[0]!.function.parameters).toEqual(spec.input_schema);
  });

  it("delegate tool executes the REST lifecycle; text for the model, DelegateResult as artifact", async () => {
    const { fetch, calls } = scriptedRest({
      "POST /api/public/v1/threads": { thread: { id: "thr_1" }, message: { id: "m1" }, run: { id: "run_1", status: "queued" } },
      "GET /api/public/v1/runs/run_1": { id: "run_1", thread_id: "thr_1", status: "completed", error: null },
      "GET /api/public/v1/runs/run_1/result": { run_id: "run_1", status: "completed", markdown: "Report is ready.", json: null, artifacts: [] },
    });
    const statuses: string[] = [];
    const delegate = viktorDelegateTool({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", fetch, pollIntervalMs: 1, onStatus: (s) => void statuses.push(s) });
    const message: ToolMessage = await delegate.invoke({ type: "tool_call", id: "call_1", name: delegate.name, args: { task: "Write the Q3 report" } });

    expect(calls.map((c) => c.key)).toEqual(["POST /api/public/v1/threads", "GET /api/public/v1/runs/run_1", "GET /api/public/v1/runs/run_1/result"]);
    expect(calls[0]!.authorization).toBe("Bearer zt_test_sk_fixture");
    expect(JSON.stringify(calls[0]!.body)).toContain("Write the Q3 report");
    expect(message.tool_call_id).toBe("call_1");
    expect(message.content).toContain("Report is ready.");
    expect(message.content).toContain("thread_id: thr_1");
    expect(message.artifact as DelegateResult).toMatchObject({ status: "completed", markdown: "Report is ready.", thread_id: "thr_1", run_id: "run_1" });
    expect(statuses).toContain("completed");
  });

  it("delegate tool rejects input that violates the shared schema before calling Viktor", async () => {
    const { fetch, calls } = scriptedRest({});
    const delegate = viktorDelegateTool({ apiKey: "k", baseURL: "https://viktor.test", fetch });
    await expect(delegate.invoke({ speed: "warp" } as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
