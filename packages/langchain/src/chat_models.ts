import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import { AsyncCaller } from "@langchain/core/utils/async_caller";
import { ChatOpenAI, convertMessagesToCompletionsMessageParams, type ChatOpenAICallOptions, type ChatOpenAIFields, type ClientOptions } from "@langchain/openai";
import {
  DEFAULT_TIMEOUT_MS,
  VIKTOR_MODEL_ID,
  ViktorEmptyReplyError,
  ViktorError,
  ViktorInvalidRequestError,
  ViktorRunFailedError,
  errorFromResponse,
  isEmptyAssistantMessage,
  longRunningFetch,
  parseErrorBody,
  resolveApiKey,
  resolveBaseURL,
  threadIdFrom,
  validateChatImages,
} from "@viktor-com/integrations-core";

export interface ChatViktorFields extends Omit<ChatOpenAIFields, "model" | "modelName" | "apiKey" | "n" | "completions" | "responses"> {
  /** Viktor API key (`zt_live_sk_…`). Defaults to the `VIKTOR_API_KEY` environment variable, read when a request is made. */
  apiKey?: string;
  /** Viktor host, without a path. Defaults to `VIKTOR_BASE_URL`, then `https://api.viktor.com`. `/api/compat/v1` is appended. */
  baseURL?: string;
  /**
   * Abort a request after this many milliseconds. Default 660 000: a Viktor run can take up to 600 s
   * while Viktor works in its own tools, and the server should be the one to end it.
   */
  timeout?: number;
  /**
   * Default 0. A failed Viktor run (502 `run_failed`) was billed and may already have acted, so it is
   * never retried, whatever this is set to. Raise it to let LangChain retry 429s and network errors.
   */
  maxRetries?: number;
  /** Throw `ViktorEmptyReplyError` when Viktor answers with no text and no tool calls. Default `false`: log a warning. */
  strictEmptyReply?: boolean;
  /**
   * Use Viktor's Responses API instead of Chat Completions. The response id is the durable Viktor
   * thread id, so passing it back as `previous_response_id` continues the same thread.
   */
  useResponsesApi?: boolean;
}

export type ChatViktorCallOptions = ChatOpenAICallOptions;

const EMPTY_REPLY_WARNING =
  "Viktor returned an empty reply (no text and no tool calls). The run's event stream may have ended before output was delivered. Retrying usually helps.";

/**
 * The `openai` SDK keeps only the `error` member of an error body, which drops Viktor's REST-style
 * `{"detail":…}` envelope (401/403). Remember the full body per response, keyed by the Headers
 * object that the SDK copies onto its `APIError`.
 */
const errorBodies = new WeakMap<object, unknown>();

function rememberErrorBodies(baseFetch: NonNullable<ClientOptions["fetch"]>): NonNullable<ClientOptions["fetch"]> {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response.ok) errorBodies.set(response.headers, await response.clone().json().catch(() => undefined));
    return response;
  };
}

interface OpenAIErrorLike {
  status?: number;
  headers?: Headers | Record<string, string>;
  error?: unknown;
  cause?: unknown;
  lc_error_code?: string;
}

/**
 * Convert an error thrown by the wrapped `ChatOpenAI` (an `openai` SDK `APIError`) into the typed
 * Viktor error. The original error is kept as `cause`. Anything that is not an API error passes through.
 */
export function toViktorError(error: unknown): unknown {
  if (error instanceof ViktorError || typeof error !== "object" || error === null) return error;
  const e = error as OpenAIErrorLike;
  if (e.cause instanceof ViktorError) return e.cause;
  let mapped: ViktorError;
  if (typeof e.status === "number") {
    const body = (e.headers && errorBodies.get(e.headers)) ?? (e.error === undefined ? undefined : { error: e.error });
    mapped = errorFromResponse({ status: e.status, headers: e.headers, body });
  } else if (typeof e.error === "object" && e.error !== null) {
    // Viktor sends {"error":{message,type,code}} instead of a finish chunk when a streamed run fails.
    const parsed = parseErrorBody({ error: e.error });
    const requestId = e.headers instanceof Headers ? (e.headers.get("x-request-id") ?? undefined) : e.headers?.["x-request-id"];
    mapped = new ViktorRunFailedError(parsed.message ?? "unknown error", { status: 200, detailCode: parsed.detailCode, body: e.error, requestId });
  } else {
    return error;
  }
  Object.assign(mapped, { cause: error }, e.lc_error_code ? { lc_error_code: e.lc_error_code } : {});
  return mapped;
}

/** LangChain's default retry policy (no retry on 4xx, quota errors, aborts); it is not exported on its own. */
const defaultFailedAttemptHandler = new (class extends AsyncCaller {
  get handler() {
    return this.onFailedAttempt;
  }
})({}).handler;

/**
 * Chat model for Viktor, the AI employee, over Viktor's OpenAI-compatible API.
 *
 * ```ts
 * const model = new ChatViktor(); // reads VIKTOR_API_KEY
 * const reply = await model.invoke("Summarise yesterday's support tickets.");
 * ```
 */
export class ChatViktor extends ChatOpenAI<ChatViktorCallOptions> {
  static override lc_name(): string {
    return "ChatViktor";
  }

  override lc_namespace = ["viktor", "langchain", "chat_models"];

  strictEmptyReply: boolean;

  private readonly viktorFields: ChatViktorFields;

  constructor(fields: ChatViktorFields = {}) {
    const { baseURL, strictEmptyReply, ...rest } = fields;
    const userHandler = fields.onFailedAttempt ?? defaultFailedAttemptHandler;
    super({
      ...rest,
      model: VIKTOR_MODEL_ID,
      // Resolved per request so VIKTOR_API_KEY can be set after construction; a missing key fails with a clear message.
      apiKey: fields.apiKey ?? (async () => resolveApiKey()),
      timeout: fields.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: fields.maxRetries ?? 0,
      onFailedAttempt: (error: unknown) => {
        const mapped = toViktorError(error);
        // A failed Viktor run was billed and may have acted: stop retrying whatever maxRetries says.
        if (mapped instanceof ViktorRunFailedError) throw mapped;
        return userHandler?.(error);
      },
      configuration: {
        ...fields.configuration,
        baseURL: `${resolveBaseURL(baseURL)}/api/compat/v1`,
        fetch: rememberErrorBodies(fields.configuration?.fetch ?? (longRunningFetch(fields.timeout ?? DEFAULT_TIMEOUT_MS) as NonNullable<ClientOptions["fetch"]>)),
      },
    });
    this.viktorFields = fields;
    this.strictEmptyReply = strictEmptyReply ?? false;
  }

  override _llmType(): string {
    return "viktor";
  }

  override get lc_secrets(): { [key: string]: string } {
    return { apiKey: "VIKTOR_API_KEY" };
  }

  override getLsParams(options: this["ParsedCallOptions"]) {
    return { ...super.getLsParams(options), ls_provider: "viktor" };
  }

  // ChatOpenAI.withConfig (used by bindTools) rebuilds a plain ChatOpenAI; keep the Viktor subclass.
  override withConfig(config: Partial<ChatViktorCallOptions>): ChatViktor {
    const next = new ChatViktor(this.viktorFields);
    next.defaultOptions = { ...this.defaultOptions, ...config };
    return next;
  }

  /** Fail before the request on input Viktor would silently ignore or cannot run. */
  protected checkRequest(messages: BaseMessage[], options: this["ParsedCallOptions"]): void {
    const converted = convertMessagesToCompletionsMessageParams({ messages, model: this.model });
    for (const message of converted) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type === "file" || part.type === "input_audio") {
          throw new ViktorInvalidRequestError(
            "Viktor's chat API accepts image attachments only. Send the file's text, or delegate the task with viktorDelegateTool().",
          );
        }
      }
    }
    validateChatImages(converted);
    for (const tool of options.tools ?? []) {
      const type = (tool as { type?: unknown }).type;
      if (typeof type === "string" && type !== "function") {
        throw new ViktorInvalidRequestError(`Viktor cannot run the hosted tool "${type}". Pass function tools only.`);
      }
    }
  }

  private handleEmptyReply(): void {
    if (this.strictEmptyReply) throw new ViktorEmptyReplyError({ status: 200 });
    console.warn(`[viktor] ${EMPTY_REPLY_WARNING}`);
  }

  override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    this.checkRequest(messages, options);
    let result: ChatResult;
    try {
      result = await super._generate(messages, options, runManager);
    } catch (error) {
      throw toViktorError(error);
    }
    for (const generation of result.generations) {
      const message = generation.message as BaseMessage & { tool_calls?: Array<{ id?: string }> };
      const metadata = message.response_metadata as Record<string, unknown>;
      const finishReason = generation.generationInfo?.finish_reason ?? metadata.finish_reason;
      if (finishReason === "stop" && isEmptyAssistantMessage({ content: message.content, tool_calls: message.tool_calls })) this.handleEmptyReply();
      const ids = [...(message.tool_calls ?? []).map((call) => call.id), metadata.id as string | undefined];
      message.response_metadata = {
        ...metadata,
        viktor_thread_id: ids.map((id) => threadIdFrom(id)).find((id) => id !== null) ?? null,
        run_cap_reached: finishReason === "length",
      };
    }
    return result;
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.checkRequest(messages, options);
    let hasOutput = false;
    let threadId: string | null = null;
    let finishReason: unknown;
    try {
      for await (const chunk of super._streamResponseChunks(messages, options, runManager)) {
        const message = chunk.message as BaseMessage & { tool_call_chunks?: Array<{ id?: string }> };
        if (chunk.text.length > 0 || (message.tool_call_chunks?.length ?? 0) > 0) hasOutput = true;
        for (const call of message.tool_call_chunks ?? []) threadId ??= threadIdFrom(call.id);
        threadId ??= threadIdFrom((message.response_metadata as { id?: string }).id);
        const reason: unknown = chunk.generationInfo?.finish_reason;
        if (reason != null && finishReason === undefined) {
          finishReason = reason;
          if (!hasOutput && reason === "stop") this.handleEmptyReply();
          // Set once, on the finish chunk: AIMessageChunk.concat would join repeated string values.
          message.response_metadata = { ...message.response_metadata, viktor_thread_id: threadId, run_cap_reached: reason === "length" };
        }
        yield chunk;
      }
    } catch (error) {
      throw toViktorError(error);
    }
  }

  // Route the content-block event protocol through the checked chunk stream above.
  override async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatModelStreamEvent> {
    yield* BaseChatModel.prototype._streamChatModelEvents.call(this, messages, this._combineCallOptions(options), runManager);
  }
}
