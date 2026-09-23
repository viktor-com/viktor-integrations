import { jsonSchema, tool } from "@ai-sdk/provider-utils";
import {
  createViktorClient,
  delegateToViktor,
  delegateToolSpec,
  formatDelegateResult,
  type DelegateInput,
  type DelegateResult,
  type ViktorClientOptions,
} from "@viktor-com/integrations-core";

export interface ViktorDelegateOptions extends Pick<ViktorClientOptions, "apiKey" | "baseURL" | "fetch" | "headers"> {
  /** Override the tool description shown to the model. */
  description?: string;
  /** How often to poll the Viktor run. Default 2500 ms. */
  pollIntervalMs?: number;
  /** Observe run status changes (`queued`, `in_progress`, …). */
  onStatus?: (status: string) => void;
}

/**
 * A tool that hands a task to Viktor over the native REST API and waits for the result.
 * Use it to make Viktor a teammate of your own agent: the model decides when to delegate.
 *
 * ```ts
 * const result = await generateText({ model, tools: { delegate_to_viktor: viktorDelegate() }, prompt });
 * ```
 */
export function viktorDelegate(options: ViktorDelegateOptions = {}) {
  const { description, pollIntervalMs, onStatus, ...clientOptions } = options;
  return tool<DelegateInput, DelegateResult, {}>({
    description: description ?? delegateToolSpec.description,
    inputSchema: jsonSchema<DelegateInput>(delegateToolSpec.input_schema as never),
    execute: async (input, { abortSignal }) =>
      delegateToViktor(createViktorClient(clientOptions), input, { signal: abortSignal, pollIntervalMs, onStatus }),
    toModelOutput: ({ output }) => ({ type: "text", value: formatDelegateResult(output) }),
  });
}

/** Tool name used across all Viktor integrations, for `tools: { [VIKTOR_DELEGATE_TOOL_NAME]: viktorDelegate() }`. */
export const VIKTOR_DELEGATE_TOOL_NAME = delegateToolSpec.name;
