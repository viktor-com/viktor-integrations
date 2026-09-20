import type { RunnableConfig } from "@langchain/core/runnables";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import {
  createViktorClient,
  delegateToViktor,
  delegateToolSpec,
  formatDelegateResult,
  type DelegateInput,
  type DelegateResult,
  type ViktorClientOptions,
} from "@viktor/integrations-core";

export interface ViktorDelegateToolOptions extends Pick<ViktorClientOptions, "apiKey" | "baseURL" | "fetch" | "headers"> {
  /** Override the tool description shown to the model. */
  description?: string;
  /** How often to poll the Viktor run. Default 2500 ms. */
  pollIntervalMs?: number;
  /** Observe run status changes (`queued`, `in_progress`, …). */
  onStatus?: (status: string) => void;
}

/** Tool name used across all Viktor integrations. */
export const VIKTOR_DELEGATE_TOOL_NAME = delegateToolSpec.name;

/**
 * A tool that hands a task to Viktor over the native REST API and waits for the result, so your
 * own agent can use Viktor as a teammate. The model reads the formatted text; the full
 * `DelegateResult` (thread id, run id, files) is the `ToolMessage.artifact`.
 *
 * ```ts
 * const agent = createAgent({ model: "openai:gpt-5", tools: [viktorDelegateTool()] });
 * ```
 */
export function viktorDelegateTool(options: ViktorDelegateToolOptions = {}): DynamicStructuredTool {
  const { description, pollIntervalMs, onStatus, ...clientOptions } = options;
  return tool(
    async (input: DelegateInput, config?: RunnableConfig): Promise<[string, DelegateResult]> => {
      const result = await delegateToViktor(createViktorClient(clientOptions), input, { signal: config?.signal, pollIntervalMs, onStatus });
      return [formatDelegateResult(result), result];
    },
    {
      name: VIKTOR_DELEGATE_TOOL_NAME,
      description: description ?? delegateToolSpec.description,
      // The shared JSON Schema is passed as is; LangChain sends it to the model unchanged.
      schema: delegateToolSpec.input_schema as unknown as Record<string, unknown>,
      responseFormat: "content_and_artifact",
    },
  ) as unknown as DynamicStructuredTool;
}
