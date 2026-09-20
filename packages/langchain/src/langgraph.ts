/**
 * LangGraph helpers. Import from `@viktor/langchain/langgraph`; this entry needs the optional
 * peers `@langchain/langgraph` and `langchain`, the main entry does not.
 */
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { createAgent, type CreateAgentParams } from "langchain";
import { ChatViktor, type ChatViktorFields } from "./chat_models.js";

export interface ViktorHandoffToolOptions {
  /** Name of the graph node that runs Viktor. Default `viktor`. */
  agentName?: string;
  /** When the calling agent should hand off. */
  description?: string;
}

/**
 * A handoff tool for LangGraph multi-agent graphs: the calling agent stops and the parent graph
 * continues at the Viktor node with the conversation so far.
 *
 * ```ts
 * const triage = createAgent({ model, tools: [createViktorHandoffTool()] });
 * const graph = new StateGraph(MessagesAnnotation)
 *   .addNode("triage", triage.graph, { ends: ["viktor"] })
 *   .addNode("viktor", createViktorAgent().graph)
 *   .addEdge(START, "triage");
 * ```
 */
export function createViktorHandoffTool(options: ViktorHandoffToolOptions = {}): DynamicStructuredTool {
  const agentName = options.agentName ?? "viktor";
  const name = `transfer_to_${agentName}`;
  return tool(
    async (_input: Record<string, never>, config: RunnableConfig & { toolCall?: { id?: string } }) => {
      const toolMessage = new ToolMessage({ content: `Successfully transferred to ${agentName}`, name, tool_call_id: config.toolCall?.id ?? "" });
      const state = getCurrentTaskInput<{ messages?: BaseMessage[] }>(config);
      return new Command({ goto: agentName, graph: Command.PARENT, update: { messages: [...(state.messages ?? []), toolMessage] } });
    },
    {
      name,
      description:
        options.description ??
        "Hand the conversation to Viktor, an AI employee that works inside the team's tools (Slack, integrations, files, code sandbox). Use it for multi-step work or work that needs the team's connected systems.",
      schema: { type: "object", properties: {}, additionalProperties: false },
    },
  ) as unknown as DynamicStructuredTool;
}

export interface ViktorAgentOptions extends Omit<CreateAgentParams, "model"> {
  /** Settings for the underlying `ChatViktor`, or a ready instance. */
  model?: ChatViktor | ChatViktorFields;
}

/** Viktor as a LangChain agent (`createAgent`), usable on its own or as a node in a LangGraph graph. Default node name: `viktor`. */
export function createViktorAgent(options: ViktorAgentOptions = {}) {
  const { model, ...rest } = options;
  const params: CreateAgentParams = { name: "viktor", ...rest, model: model instanceof ChatViktor ? model : new ChatViktor(model) };
  return createAgent(params);
}
