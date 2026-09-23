import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig, OpenAICompatibleConfig } from "@mastra/core/llm";
import { createTool } from "@mastra/core/tools";
import { createViktor, type ViktorProviderSettings } from "@viktor-com/ai-sdk-provider";
import {
  createViktorClient,
  delegateToViktor,
  delegateToolSpec,
  formatDelegateResult,
  resolveApiKey,
  resolveBaseURL,
  type DelegateInput,
} from "@viktor-com/integrations-core";

export type ViktorSettings = ViktorProviderSettings;

/**
 * Viktor as a Mastra model. Returns the Viktor AI SDK model, which Mastra accepts directly, so you get
 * Viktor's typed errors, the no-retry rule for failed runs, image checks and tool-call id pass-through.
 *
 * ```ts
 * new Agent({ id: "assistant", name: "Assistant", instructions: "…", model: viktorModel() })
 * ```
 */
export function viktorModel(settings: ViktorSettings = {}): MastraModelConfig {
  // Mastra bundles its own copy of the AI SDK provider types; the model is a LanguageModelV4 at runtime.
  return createViktor(settings)() as unknown as MastraModelConfig;
}

/**
 * Config-only form for Mastra's model router: `{ id: "viktor/viktor", url, apiKey }`. Use it where a
 * plain config object is required (for example serialised agent definitions). It talks to the same
 * endpoint but without the Viktor-specific error handling that `viktorModel()` adds.
 */
export function viktorModelConfig(settings: Pick<ViktorSettings, "apiKey" | "baseURL" | "headers"> = {}): OpenAICompatibleConfig {
  return {
    id: "viktor/viktor",
    url: `${resolveBaseURL(settings.baseURL)}/api/compat/v1`,
    apiKey: resolveApiKey(settings.apiKey),
    headers: settings.headers,
  };
}

export interface ViktorDelegateToolOptions extends Pick<ViktorSettings, "apiKey" | "baseURL" | "headers"> {
  fetch?: typeof globalThis.fetch;
  description?: string;
  pollIntervalMs?: number;
  onStatus?: (status: string) => void;
}

/** Mastra tool `delegate_to_viktor`: hands a task to Viktor over its task API and waits for the result. */
export function viktorDelegateTool(options: ViktorDelegateToolOptions = {}) {
  const { description, pollIntervalMs, onStatus, ...clientOptions } = options;
  return createTool({
    id: delegateToolSpec.name,
    description: description ?? delegateToolSpec.description,
    inputSchema: delegateToolSpec.input_schema as never,
    execute: async (input: unknown, context?: { abortSignal?: AbortSignal }) => {
      const result = await delegateToViktor(createViktorClient(clientOptions), input as DelegateInput, {
        signal: context?.abortSignal,
        pollIntervalMs,
        onStatus,
      });
      return { ...result, text: formatDelegateResult(result) };
    },
  });
}

export interface ViktorAgentOptions extends ViktorSettings {
  id?: string;
  name?: string;
  description?: string;
  instructions?: string;
  tools?: ConstructorParameters<typeof Agent>[0]["tools"];
}

/** A ready-made Viktor agent for a supervisor's `agents: { viktor: viktorAgent() }` map. */
export function viktorAgent(options: ViktorAgentOptions = {}): Agent {
  const { id, name, description, instructions, tools, ...settings } = options;
  return new Agent({
    id: id ?? "viktor",
    name: name ?? "Viktor",
    description:
      description ??
      "Viktor, an AI employee with access to the team's tools (Slack, connected integrations, files, a code sandbox). Delegate multi-step work that needs those systems.",
    instructions: instructions ?? "You are Viktor, the team's AI employee. Do the task with your own tools and report the result.",
    model: viktorModel(settings),
    tools,
  });
}

export {
  ViktorError,
  ViktorRunFailedError,
  ViktorRateLimitError,
  ViktorAuthError,
  ViktorEmptyReplyError,
  ViktorInvalidRequestError,
  threadIdFrom,
  isRoutedToolId,
} from "@viktor-com/integrations-core";
