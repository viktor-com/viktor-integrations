import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { createFixtureFetch, type FixtureFetch } from "@viktor-com/integrations-core/testing";
import { createAgent } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChatViktor } from "../src/index.js";
import { createViktorAgent, createViktorHandoffTool } from "../src/langgraph.js";

const ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3";

interface ChatBody {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
  tools?: Array<{ function: { name: string } }>;
}

const getWeather = tool(async ({ city }: { city: string }) => `Sunny, 24C in ${city}`, {
  name: "get_weather",
  description: "Get weather",
  schema: z.object({ city: z.string(), units: z.string().optional() }),
});

const settings = (fetch: FixtureFetch | typeof globalThis.fetch) => ({ apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", configuration: { fetch } });

describe("createAgent with ChatViktor", () => {
  it("agent loop: createAgent runs the tool and resumes the Viktor thread with the routed id", async () => {
    const fetch = createFixtureFetch("chat-tool-call", "chat-tool-result-followup");
    const agent = createAgent({ model: new ChatViktor(settings(fetch)), tools: [getWeather] });
    const result = await agent.invoke({ messages: [new HumanMessage("weather in Berlin?")] });

    const messages = result.messages as BaseMessage[];
    expect(messages.map((m) => m.getType())).toEqual(["human", "ai", "tool", "ai"]);
    expect((messages[1] as AIMessage).tool_calls![0]!.id).toBe(ROUTED_ID);
    expect((messages[2] as ToolMessage).tool_call_id).toBe(ROUTED_ID);
    expect((messages[2] as ToolMessage).content).toBe("Sunny, 24C in Berlin");
    expect(messages[3]!.text).toMatch(/sunny/i);

    expect(fetch.requests).toHaveLength(2);
    const followup = fetch.requests[1]!.body as ChatBody;
    expect(followup.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: ROUTED_ID });
    expect(followup.messages.at(-2)!.tool_calls![0]!.id).toBe(ROUTED_ID);
    expect(followup.tools!.map((t) => t.function.name)).toEqual(["get_weather"]);
  });

  it("createViktorAgent builds a createAgent graph named viktor around ChatViktor", async () => {
    const fetch = createFixtureFetch("chat-tool-call", "chat-tool-result-followup");
    const agent = createViktorAgent({ model: settings(fetch), tools: [getWeather] });
    const result = await agent.invoke({ messages: [new HumanMessage("weather in Berlin?")] });
    expect((result.messages as BaseMessage[]).at(-1)!.text).toMatch(/sunny/i);
    expect(fetch.requests).toHaveLength(2);
    expect((fetch.requests[0]!.body as { model: string }).model).toBe("viktor");
  });
});

describe("createViktorHandoffTool", () => {
  it("handoff tool: returns a Command that moves the parent graph to the viktor node", async () => {
    const handoff = createViktorHandoffTool();
    expect(handoff.name).toBe("transfer_to_viktor");
    expect(createViktorHandoffTool({ agentName: "ops", description: "d" })).toMatchObject({ name: "transfer_to_ops", description: "d" });

    // A scripted triage model that always asks for the handoff.
    const triageFetch = async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-triage",
          object: "chat.completion",
          model: "triage",
          choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_handoff_1", type: "function", function: { name: "transfer_to_viktor", arguments: "{}" } }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const viktorFetch = createFixtureFetch("chat-text");
    const triage = createAgent({ model: new ChatViktor(settings(triageFetch)), tools: [handoff] });
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("triage", triage.graph, { ends: ["viktor"] })
      .addNode("viktor", createViktorAgent({ model: settings(viktorFetch) }).graph)
      .addEdge(START, "triage")
      .addEdge("viktor", END)
      .compile();

    const result = await graph.invoke({ messages: [new HumanMessage("Please ask Viktor to say hello.")] });
    expect(viktorFetch.requests).toHaveLength(1);
    const seen = (viktorFetch.requests[0]!.body as ChatBody).messages;
    expect(seen[0]).toMatchObject({ role: "user", content: "Please ask Viktor to say hello." });
    expect(seen.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_handoff_1", content: "Successfully transferred to viktor" });
    expect(result.messages.at(-1)!.text).toContain("Viktor");
  });
});
