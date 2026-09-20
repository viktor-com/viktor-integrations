import {
  APICallError,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Middleware,
  type LanguageModelV4StreamPart,
  type SharedV4Warning,
} from "@ai-sdk/provider";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  EMPTY_REPLY_MESSAGE,
  MAX_IMAGES_PER_REQUEST,
  ViktorEmptyReplyError,
  ViktorError,
  ViktorInvalidRequestError,
  ViktorRunFailedError,
  errorFromResponse,
  runFailedFromStreamFrame,
  threadIdFrom,
} from "@viktor/integrations-core";

export interface ViktorMiddlewareOptions {
  /** Throw when Viktor answers 200 with no text and no tool calls. Default: add a warning. */
  strictEmptyReply?: boolean;
}

const EMPTY_REPLY_WARNING = EMPTY_REPLY_MESSAGE;

/**
 * Convert an AI SDK APICallError raised by the wrapped OpenAI-compatible model into one that
 * carries Viktor's diagnosis. It stays an APICallError so AI SDK retry and error handling keep
 * working; the typed ViktorError is attached as `cause`.
 */
export function toViktorApiCallError(error: unknown): unknown {
  if (!APICallError.isInstance(error) || error.cause instanceof ViktorError) return error;
  const status = error.statusCode;
  if (status === undefined) return error;
  let body: unknown = error.responseBody;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* keep text */
    }
  }
  const viktorError = errorFromResponse({ status, headers: error.responseHeaders, body });
  return new APICallError({
    message: viktorError.message,
    url: error.url,
    requestBodyValues: error.requestBodyValues,
    statusCode: status,
    responseHeaders: error.responseHeaders,
    responseBody: error.responseBody,
    // A failed Viktor run was billed and had side effects; never retry it blindly.
    isRetryable: viktorError instanceof ViktorRunFailedError ? false : viktorError.isRetryable,
    data: { viktor: { code: viktorError.code, detailCode: viktorError.detailCode, requestId: viktorError.requestId } },
    cause: viktorError,
  });
}

function checkPrompt(params: LanguageModelV4CallOptions): void {
  let images = 0;
  for (const message of params.prompt) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "file") continue;
      const mediaType = part.mediaType.toLowerCase();
      if (!mediaType.startsWith("image/")) {
        throw new ViktorInvalidRequestError(
          `Viktor's chat API accepts image attachments only; got "${part.mediaType}". Send the file's text, or delegate the task with viktorDelegate().`,
        );
      }
      if (mediaType !== "image/*" && !(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mediaType === "image/jpg" ? "image/jpeg" : mediaType)) {
        throw new ViktorInvalidRequestError(`Viktor accepts ${ALLOWED_IMAGE_MIME_TYPES.join(", ")} images; got "${part.mediaType}".`);
      }
      images += 1;
    }
  }
  if (images > MAX_IMAGES_PER_REQUEST) {
    throw new ViktorInvalidRequestError(
      `Viktor accepts at most ${MAX_IMAGES_PER_REQUEST} images per request; got ${images}. Extra images would be silently ignored.`,
    );
  }
  for (const tool of params.tools ?? []) {
    if (tool.type !== "function") {
      throw new ViktorInvalidRequestError(`Viktor cannot run provider-executed tool "${tool.name}". Pass function tools only.`);
    }
  }
}

function firstThreadId(ids: Iterable<string>): string | null {
  for (const id of ids) {
    const threadId = threadIdFrom(id);
    if (threadId) return threadId;
  }
  return null;
}

export function viktorMiddleware(options: ViktorMiddlewareOptions = {}): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",

    transformParams: async ({ params }) => {
      checkPrompt(params);
      return params;
    },

    wrapGenerate: async ({ doGenerate }) => {
      let result;
      try {
        result = await doGenerate();
      } catch (error) {
        throw toViktorApiCallError(error);
      }
      const hasOutput = result.content.some((c) => (c.type === "text" && c.text.length > 0) || c.type === "tool-call");
      let warnings: SharedV4Warning[] = result.warnings ?? [];
      if (!hasOutput && result.finishReason.unified === "stop") {
        if (options.strictEmptyReply) throw new ViktorEmptyReplyError({ status: 200 });
        warnings = [...warnings, { type: "other", message: EMPTY_REPLY_WARNING }];
      }
      const threadId = firstThreadId(result.content.flatMap((c) => (c.type === "tool-call" ? [c.toolCallId] : [])));
      const timedOut = result.finishReason.raw === "length";
      return {
        ...result,
        warnings,
        providerMetadata: {
          ...result.providerMetadata,
          viktor: { ...(result.providerMetadata?.viktor ?? {}), threadId, runCapReached: timedOut },
        },
      };
    },

    wrapStream: async ({ doStream }) => {
      let result;
      try {
        result = await doStream();
      } catch (error) {
        throw toViktorApiCallError(error);
      }
      let hasOutput = false;
      let threadId: string | null = null;
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta" && part.delta.length > 0) hasOutput = true;
            if (part.type === "tool-call") {
              hasOutput = true;
              threadId ??= threadIdFrom(part.toolCallId);
            }
            if (part.type === "error" && !(part.error instanceof Error)) {
              // Viktor sends {"error":{message,type,code}} instead of a finish chunk when the run fails.
              controller.enqueue({ type: "error", error: runFailedFromStreamFrame(part.error) });
              return;
            }
            if (part.type === "finish") {
              if (!hasOutput && part.finishReason.unified === "stop") {
                if (options.strictEmptyReply) {
                  controller.enqueue({ type: "error", error: new ViktorEmptyReplyError({ status: 200 }) });
                  return;
                }
                console.warn(`[viktor] ${EMPTY_REPLY_WARNING}`);
              }
              controller.enqueue({
                ...part,
                providerMetadata: {
                  ...part.providerMetadata,
                  viktor: { ...(part.providerMetadata?.viktor ?? {}), threadId, runCapReached: part.finishReason.raw === "length" },
                },
              });
              return;
            }
            controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream };
    },
  };
}
