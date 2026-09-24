/**
 * Viktor error taxonomy. The table of conditions lives in spec/errors.json;
 * this file is its TypeScript implementation.
 */

export type ViktorErrorCode =
  | "run_failed"
  | "empty_reply"
  | "auth"
  | "rate_limit"
  | "request_too_large"
  | "response_format_not_satisfied"
  | "invalid_request"
  | "server_error";

export interface ViktorErrorOptions {
  status?: number;
  requestId?: string;
  /** Viktor's own error code from the wire (for example `identity_denied`, `insufficient_quota`). */
  detailCode?: string;
  body?: unknown;
  cause?: unknown;
}

export class ViktorError extends Error {
  readonly code: ViktorErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly detailCode?: string;
  readonly body?: unknown;
  /** Whether retrying the same request can succeed. */
  readonly isRetryable: boolean = false;

  constructor(code: ViktorErrorCode, message: string, options: ViktorErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.detailCode = options.detailCode;
    this.body = options.body;
  }
}

/** The Viktor run failed server-side: HTTP 502 `run_failed` or an in-stream error frame. */
export class ViktorRunFailedError extends ViktorError {
  constructor(message: string, options?: ViktorErrorOptions) {
    super("run_failed", `Viktor run failed: ${message}`, options);
  }
}

/**
 * HTTP 200 with no text and no tool calls. It cannot be told apart from a truly empty answer.
 */
/** One wording for the empty-reply condition, shared by every adapter's warning and error. */
export const EMPTY_REPLY_MESSAGE =
  "Viktor returned an empty reply (no text and no tool calls). The run's event stream may have ended " +
  "before output was delivered. Retrying usually helps.";

export class ViktorEmptyReplyError extends ViktorError {
  override readonly isRetryable = true;
  constructor(options?: ViktorErrorOptions) {
    super("empty_reply", EMPTY_REPLY_MESSAGE, options);
  }
}

/**
 * Build the error for Viktor's in-stream failure frame: `{"error":{message,type,code}}` sent as an
 * SSE data frame instead of a finish chunk. Accepts the frame or the bare `error` object, because
 * SDKs surface either.
 */
export function runFailedFromStreamFrame(frame: unknown, options: ViktorErrorOptions = {}): ViktorRunFailedError {
  // Some SDK versions surface only the message string of the frame.
  if (typeof frame === "string") return new ViktorRunFailedError(frame || "unknown error", { status: 200, body: frame, ...options });
  const envelope = frame && typeof frame === "object" && "error" in frame ? frame : { error: frame };
  const parsed = parseErrorBody(envelope);
  return new ViktorRunFailedError(parsed.message ?? "unknown error", { status: 200, detailCode: parsed.detailCode, body: frame, ...options });
}

export class ViktorAuthError extends ViktorError {
  constructor(message: string, options?: ViktorErrorOptions) {
    super("auth", message, options);
  }
}

export class ViktorRateLimitError extends ViktorError {
  override readonly isRetryable = true;
  readonly retryAfterSeconds?: number;
  constructor(message: string, options?: ViktorErrorOptions & { retryAfterSeconds?: number }) {
    super("rate_limit", message, options);
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export class ViktorRequestTooLargeError extends ViktorError {
  constructor(message: string, options?: ViktorErrorOptions) {
    super("request_too_large", message, options);
  }
}

export class ViktorStructuredOutputError extends ViktorError {
  constructor(message: string, options?: ViktorErrorOptions) {
    super("response_format_not_satisfied", message, options);
  }
}

export class ViktorInvalidRequestError extends ViktorError {
  constructor(message: string, options?: ViktorErrorOptions) {
    super("invalid_request", message, options);
  }
}

export class ViktorServerError extends ViktorError {
  override readonly isRetryable = true;
  constructor(message: string, options?: ViktorErrorOptions) {
    super("server_error", message, options);
  }
}

const AUTH_HINTS: Record<string, string> = {
  invalid_api_key: "Check VIKTOR_API_KEY. Keys look like zt_live_sk_… and are shown once when created.",
  api_key_inactive: "The API key was deactivated. Create a new key in Viktor settings.",
  api_key_expired: "The API key expired. Create a new key in Viktor settings.",
  missing_scope:
    "The API key lacks the scope named above. The chat model needs chat:completions; the delegate tool needs threads:create, runs:create, runs:read, messages:create and files:read.",
  identity_denied:
    "The key's owner has no linked Slack or Teams identity, so Viktor cannot run as them. Link the account in Viktor.",
  identity_unsupported_platform: "The key owner's chat platform is not supported for API runs.",
  compat_api_not_enabled: "This Viktor environment does not serve the compatibility API.",
};

interface ParsedErrorBody {
  message?: string;
  detailCode?: string;
  type?: string;
}

/** Understands the three envelopes Viktor uses: REST `{detail}`, OpenAI `{error}`, Anthropic `{type:"error",error}`. */
export function parseErrorBody(body: unknown): ParsedErrorBody {
  if (body === null || typeof body !== "object") {
    return typeof body === "string" && body ? { message: body } : {};
  }
  const b = body as Record<string, unknown>;
  if ("detail" in b) {
    const d = b.detail;
    if (typeof d === "string") {
      if (d.includes("scope required")) return { message: d, detailCode: "missing_scope" };
      return { message: d, detailCode: d };
    }
    if (Array.isArray(d)) {
      const msgs = d.map((e) => (e && typeof e === "object" && "msg" in e ? String((e as { msg: unknown }).msg) : ""));
      return { message: msgs.filter(Boolean).join("; ") || "Request validation failed", detailCode: "validation_error" };
    }
    if (d && typeof d === "object") {
      const o = d as Record<string, unknown>;
      return { message: str(o.message), detailCode: str(o.error) };
    }
  }
  if ("error" in b && b.error && typeof b.error === "object") {
    const e = b.error as Record<string, unknown>;
    return { message: str(e.message), detailCode: str(e.code) ?? str(e.type), type: str(e.type) };
  }
  return {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export interface ErrorResponseInfo {
  status: number;
  headers?: Headers | Record<string, string>;
  body: unknown;
  /** The framework or SDK error this response came from; kept on the ViktorError as `cause`. */
  cause?: unknown;
}

function header(headers: ErrorResponseInfo["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, string>;
  return rec[name] ?? rec[name.toLowerCase()];
}

/** Map a non-2xx Viktor response to the matching error class. */
export function errorFromResponse(info: ErrorResponseInfo): ViktorError {
  const { status, body } = info;
  const parsed = parseErrorBody(body);
  const requestId = header(info.headers, "x-request-id");
  const base: ViktorErrorOptions = { status, requestId, detailCode: parsed.detailCode, body, cause: info.cause };
  const message = parsed.message ?? `Viktor API returned HTTP ${status}`;

  if (status === 401 || status === 403) {
    const hint = parsed.detailCode ? AUTH_HINTS[parsed.detailCode] : undefined;
    return new ViktorAuthError(hint ? `${message}. ${hint}` : message, base);
  }
  if (status === 429) {
    const raw = header(info.headers, "retry-after");
    const retryAfterSeconds = raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    return new ViktorRateLimitError(message, { ...base, retryAfterSeconds });
  }
  if (status === 413) return new ViktorRequestTooLargeError(message, base);
  if (status === 422 && parsed.detailCode === "response_format_not_satisfied") {
    return new ViktorStructuredOutputError(message, base);
  }
  if (status === 502 && parsed.detailCode === "run_failed") return new ViktorRunFailedError(message, base);
  // In production the CDN replaces the origin's JSON 502 body with its own HTML error page, so a failed
  // run often arrives as an opaque 502. It must still count as a failed (billed, never auto-retried) run.
  if (status === 502) {
    return new ViktorRunFailedError(
      "HTTP 502 from Viktor. The run most likely failed; a proxy replaced Viktor's error detail. Stream the request to see Viktor's own message.",
      { ...base, detailCode: parsed.detailCode ?? "run_failed_opaque", body: typeof body === "string" ? body.slice(0, 300) : body },
    );
  }
  if (status >= 500) return new ViktorServerError(message, base);
  return new ViktorInvalidRequestError(message, base);
}

/** True when a chat completion message carries neither text nor tool calls. */
export function isEmptyAssistantMessage(message: { content?: unknown; tool_calls?: unknown } | undefined): boolean {
  if (!message) return true;
  const hasText = typeof message.content === "string" ? message.content.length > 0 : Array.isArray(message.content) && message.content.length > 0;
  const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return !hasText && !hasTools;
}
