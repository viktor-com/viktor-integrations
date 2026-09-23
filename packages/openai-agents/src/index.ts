import { Agent, setDefaultModelProvider, setTracingDisabled, tool, UserError } from "@openai/agents";
import type { AgentConfiguration, Model, ModelProvider, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { createViktor, type ViktorProviderSettings } from "@viktor-com/ai-sdk-provider";
import {
  ViktorError,
  ViktorRateLimitError,
  ViktorRunFailedError,
  createViktorClient,
  delegateToViktor,
  delegateToolSpec,
  formatDelegateResult,
  type DelegateInput,
} from "@viktor-com/integrations-core";

export type ViktorSettings = ViktorProviderSettings;

function viktorCause(error: unknown): ViktorError | undefined {
  for (let e: unknown = error, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if (e instanceof ViktorError) return e;
  }
  return undefined;
}

/**
 * Viktor as an OpenAI Agents SDK `Model`. Built on the Viktor AI SDK provider through the SDK's
 * own `aisdk()` bridge, so errors, image checks and tool-call id pass-through behave the same in
 * every Viktor integration.
 */
export class ViktorModel implements Model {
  readonly #inner: ReturnType<typeof aisdk>;

  constructor(settings: ViktorSettings = {}) {
    this.#inner = aisdk(createViktor(settings)());
  }

  #checkTools(request: ModelRequest): void {
    const hosted = request.tools.filter((t) => t.type !== "function");
    if (hosted.length > 0) {
      throw new UserError(
        `Viktor cannot run hosted tools (${hosted.map((t) => t.name).join(", ")}). Pass function tools, or let Viktor use its own tools.`,
      );
    }
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.#checkTools(request);
    try {
      return await this.#inner.getResponse(request);
    } catch (error) {
      throw viktorCause(error) ?? error;
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.#checkTools(request);
    try {
      yield* this.#inner.getStreamedResponse(request);
    } catch (error) {
      throw viktorCause(error) ?? error;
    }
  }

  /** A failed Viktor run was billed and may have acted: never replay it. Rate limits are safe to retry. */
  getRetryAdvice(args: { error: unknown }) {
    const cause = viktorCause(args.error);
    if (cause instanceof ViktorRunFailedError) return { suggested: false, replaySafety: "unsafe" as const, reason: cause.message };
    if (cause instanceof ViktorRateLimitError) {
      return { suggested: true, replaySafety: "safe" as const, retryAfterMs: cause.retryAfterSeconds ? cause.retryAfterSeconds * 1000 : undefined };
    }
    return undefined;
  }
}

/** `ModelProvider` that answers every model name with Viktor. Use in `new Runner({ modelProvider })`. */
export class ViktorProvider implements ModelProvider {
  readonly #model: ViktorModel;
  constructor(settings: ViktorSettings = {}) {
    this.#model = new ViktorModel(settings);
  }
  getModel(_modelName?: string): Model {
    return this.#model;
  }
}

export function viktorModel(settings: ViktorSettings = {}): ViktorModel {
  return new ViktorModel(settings);
}

export interface ConfigureViktorOptions extends ViktorSettings {
  /** The SDK uploads traces to OpenAI with an OpenAI key. With a Viktor key that fails, so tracing is turned off unless you keep it. */
  keepTracing?: boolean;
}

/** Make Viktor the default model for every agent, and turn off OpenAI trace uploads. */
export function configureViktor(options: ConfigureViktorOptions = {}): ViktorProvider {
  const { keepTracing, ...settings } = options;
  if (!keepTracing) setTracingDisabled(true);
  const provider = new ViktorProvider(settings);
  setDefaultModelProvider(provider);
  return provider;
}

export interface ViktorAgentOptions extends ViktorSettings {
  name?: string;
  instructions?: string;
  handoffDescription?: string;
  tools?: AgentConfiguration["tools"];
}

/** A ready-made Viktor agent: use it in another agent's `handoffs`, or as a tool through `.asTool()`. */
export function viktorAgent(options: ViktorAgentOptions = {}): Agent {
  const { name, instructions, handoffDescription, tools, ...settings } = options;
  return new Agent({
    name: name ?? "Viktor",
    instructions: instructions ?? "You are Viktor, the team's AI employee. Do the task with your own tools and report the result.",
    handoffDescription:
      handoffDescription ??
      "Viktor, an AI employee with access to the team's tools (Slack, connected integrations, files, a code sandbox). Hand off multi-step work that needs those systems.",
    model: new ViktorModel(settings),
    tools: tools ?? [],
  });
}

export interface ViktorDelegateToolOptions extends Pick<ViktorSettings, "apiKey" | "baseURL" | "headers"> {
  fetch?: typeof globalThis.fetch;
  description?: string;
  pollIntervalMs?: number;
  onStatus?: (status: string) => void;
}

/** Function tool `delegate_to_viktor`: hands a task to Viktor over its task API and waits for the result. */
export function viktorDelegateTool(options: ViktorDelegateToolOptions = {}) {
  const { description, pollIntervalMs, onStatus, ...clientOptions } = options;
  return tool({
    name: delegateToolSpec.name,
    description: description ?? delegateToolSpec.description,
    parameters: delegateToolSpec.input_schema as never,
    strict: false,
    execute: async (input: unknown, _context, details) => {
      const result = await delegateToViktor(createViktorClient(clientOptions), input as DelegateInput, {
        signal: details?.signal,
        pollIntervalMs,
        onStatus,
      });
      return formatDelegateResult(result);
    },
  });
}

export { ViktorError, ViktorRunFailedError, ViktorRateLimitError } from "@viktor-com/integrations-core";
export { ViktorAuthError, ViktorEmptyReplyError, ViktorInvalidRequestError, threadIdFrom, isRoutedToolId } from "@viktor-com/integrations-core";
