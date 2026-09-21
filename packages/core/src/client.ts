import { ViktorEmptyReplyError, ViktorInvalidRequestError, ViktorServerError, errorFromResponse, isEmptyAssistantMessage } from "./errors.js";
import { validateChatImages } from "./images.js";
import { longRunningFetch } from "./long-fetch.js";
import {
  parseSse,
  readAnthropicStream,
  readChatCompletionStream,
  readResponsesStream,
  type ChatStreamPart,
  type ViktorUsage,
} from "./sse.js";

export const DEFAULT_BASE_URL = "https://api.viktor.com";
export const VIKTOR_MODEL_ID = "viktor";
/** Viktor caps a compat run at 600 s; stay above it so the server, not the client, ends the request. */
export const DEFAULT_TIMEOUT_MS = 660_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ViktorClientOptions {
  /** Defaults to env `VIKTOR_API_KEY`. */
  apiKey?: string;
  /** Host only, without `/api/compat`. Defaults to env `VIKTOR_BASE_URL`, then https://api.viktor.com. */
  baseURL?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Throw ViktorEmptyReplyError on a 200 reply with no text and no tool calls. Default: false (warn). */
  strictEmptyReply?: boolean;
  onWarning?: (message: string) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface ChatCompletionRequest {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  response_format?: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
  }>;
  usage?: ViktorUsage;
  [key: string]: unknown;
}

/**
 * The narrow client the integration adapters depend on. It is intentionally small so it can be
 * re-implemented on top of the Viktor SDK without touching any adapter (ADR-0002).
 */
export interface ViktorClient {
  readonly baseURL: string;
  readonly compatBaseURL: string;
  readonly anthropicBaseURL: string;
  chatCompletion(body: ChatCompletionRequest, options?: RequestOptions): Promise<ChatCompletionResponse>;
  chatCompletionStream(body: ChatCompletionRequest, options?: RequestOptions): AsyncGenerator<ChatStreamPart>;
  response(body: Record<string, unknown>, options?: RequestOptions): Promise<Record<string, unknown>>;
  responseStream(body: Record<string, unknown>, options?: RequestOptions): AsyncGenerator<{ type: string; [k: string]: unknown }>;
  anthropicMessage(body: Record<string, unknown>, options?: RequestOptions): Promise<Record<string, unknown>>;
  anthropicMessageStream(body: Record<string, unknown>, options?: RequestOptions): AsyncGenerator<{ type: string; [k: string]: unknown }>;
  listModels(options?: RequestOptions): Promise<Array<{ id: string }>>;
  /** Raw JSON request against any Viktor path (used by the delegate tool for the native REST API). */
  request<T = unknown>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T>;
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

export function resolveApiKey(apiKey?: string): string {
  const key = apiKey ?? env("VIKTOR_API_KEY");
  if (!key) {
    throw new ViktorInvalidRequestError(
      "Missing Viktor API key. Pass `apiKey` or set the VIKTOR_API_KEY environment variable.",
    );
  }
  return key;
}

/**
 * Viktor host without a path. Accepts a value that already includes the compat path
 * (`…/api/compat` or `…/api/compat/v1`), because OpenAI-style tools are configured that way.
 */
export function resolveBaseURL(baseURL?: string): string {
  return (baseURL || env("VIKTOR_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/api\/compat(\/v1)?$/, "");
}

export function createViktorClient(options: ViktorClientOptions = {}): ViktorClient {
  const baseURL = resolveBaseURL(options.baseURL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike = options.fetch ?? longRunningFetch(timeoutMs);
  const warn = options.onWarning ?? ((m: string) => console.warn(`[viktor] ${m}`));

  async function send(method: string, path: string, body: unknown, opts: RequestOptions = {}, accept = "application/json"): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${resolveApiKey(options.apiKey)}`,
      accept,
      ...options.headers,
      ...opts.headers,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(`${baseURL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (cause) {
      if (opts.signal?.aborted) throw cause;
      throw new ViktorServerError(`Could not reach Viktor at ${baseURL}: ${(cause as Error)?.message ?? cause}`, { cause });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      throw errorFromResponse({ status: res.status, headers: res.headers, body: parsed });
    }
    return res;
  }

  async function json<T>(method: string, path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    const res = await send(method, path, body, opts);
    return (await res.json()) as T;
  }

  function chatBody(body: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
    validateChatImages(body.messages);
    if (typeof body.n === "number" && body.n > 1) {
      throw new ViktorInvalidRequestError("Viktor always returns one choice; `n` greater than 1 is not supported.");
    }
    const out: Record<string, unknown> = { ...body, model: VIKTOR_MODEL_ID, stream };
    if (stream) out.stream_options = { include_usage: true, ...(body.stream_options as object | undefined) };
    return out;
  }

  return {
    baseURL,
    compatBaseURL: `${baseURL}/api/compat/v1`,
    anthropicBaseURL: `${baseURL}/api/compat`,

    async chatCompletion(body, opts) {
      const res = await send("POST", "/api/compat/v1/chat/completions", chatBody(body, false), opts);
      const data = (await res.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "stop" && isEmptyAssistantMessage(choice.message)) {
        const requestId = res.headers.get("x-request-id") ?? undefined;
        if (options.strictEmptyReply) throw new ViktorEmptyReplyError({ status: 200, requestId, body: data });
        warn(`empty reply from Viktor (request ${requestId ?? "unknown"}); the stream may have ended before output`);
      }
      return data;
    },

    async *chatCompletionStream(body, opts) {
      const res = await send("POST", "/api/compat/v1/chat/completions", chatBody(body, true), opts, "text/event-stream");
      if (!res.body) throw new ViktorServerError("Viktor returned no response body for a streaming request.");
      const requestId = res.headers.get("x-request-id") ?? undefined;
      let sawOutput = false;
      for await (const part of readChatCompletionStream(parseSse(res.body), { requestId })) {
        if (part.type === "text-delta" || part.type === "tool-call") sawOutput = true;
        if (part.type === "finish" && !sawOutput && (part.finishReason === "stop" || part.finishReason === null)) {
          if (options.strictEmptyReply) throw new ViktorEmptyReplyError({ status: 200, requestId });
          warn(`stream from Viktor ended without output (request ${requestId ?? "unknown"})`);
        }
        yield part;
      }
    },

    response(body, opts) {
      return json("POST", "/api/compat/v1/responses", { ...body, model: VIKTOR_MODEL_ID, stream: false }, opts);
    },

    async *responseStream(body, opts) {
      const res = await send("POST", "/api/compat/v1/responses", { ...body, model: VIKTOR_MODEL_ID, stream: true }, opts, "text/event-stream");
      if (!res.body) throw new ViktorServerError("Viktor returned no response body for a streaming request.");
      yield* readResponsesStream(parseSse(res.body), { requestId: res.headers.get("x-request-id") ?? undefined });
    },

    anthropicMessage(body, opts) {
      return json("POST", "/api/compat/v1/messages", { max_tokens: 4096, ...body, model: VIKTOR_MODEL_ID, stream: false }, {
        ...opts,
        headers: { "anthropic-version": "2023-06-01", ...opts?.headers },
      });
    },

    async *anthropicMessageStream(body, opts) {
      const res = await send(
        "POST",
        "/api/compat/v1/messages",
        { max_tokens: 4096, ...body, model: VIKTOR_MODEL_ID, stream: true },
        { ...opts, headers: { "anthropic-version": "2023-06-01", ...opts?.headers } },
        "text/event-stream",
      );
      if (!res.body) throw new ViktorServerError("Viktor returned no response body for a streaming request.");
      yield* readAnthropicStream(parseSse(res.body), { requestId: res.headers.get("x-request-id") ?? undefined });
    },

    async listModels(opts) {
      const data = await json<{ data: Array<{ id: string }> }>("GET", "/api/compat/v1/models", undefined, opts);
      return data.data;
    },

    request(method, path, body, opts) {
      return json(method, path, body, opts);
    },
  };
}
