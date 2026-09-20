import { ViktorRunFailedError, parseErrorBody } from "./errors.js";

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Parse a byte stream as Server-Sent Events. Comment lines (Viktor sends `: keep-alive`
 * every 15 s while it works) and `retry:` lines are dropped and never surface as content.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const flush = function* (): Generator<SseEvent> {
    if (data.length > 0) yield { event, data: data.join("\n") };
    event = undefined;
    data = [];
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += value;
      let idx: number;
      while ((idx = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === "\r" ? 2 : 1));
        if (line === "") {
          yield* flush();
        } else if (line.startsWith(":")) {
          // comment / keep-alive
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        }
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}

export type ViktorFinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface ViktorUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ViktorToolCall {
  index: number;
  /** Viktor routed id. Pass it back unchanged as `tool_call_id`. */
  id: string;
  name: string;
  /** Complete JSON string of the arguments. */
  arguments: string;
}

export type ChatStreamPart =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: "tool-call"; toolCall: ViktorToolCall }
  | { type: "finish"; finishReason: ViktorFinishReason | null; usage?: ViktorUsage; responseId?: string };

/**
 * Interpret Chat Completions SSE events from Viktor. Assembles fragmented tool-call
 * arguments by index, and throws ViktorRunFailedError on the in-stream `{"error":…}` frame
 * that Viktor sends instead of a finish chunk when the run fails.
 */
export async function* readChatCompletionStream(
  events: AsyncIterable<SseEvent>,
  context: { requestId?: string } = {},
): AsyncGenerator<ChatStreamPart> {
  const calls = new Map<number, ViktorToolCall>();
  let finishReason: ViktorFinishReason | null = null;
  let usage: ViktorUsage | undefined;
  let responseId: string | undefined;
  let sawFinish = false;

  for await (const ev of events) {
    if (ev.data === "[DONE]") break;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue; // tolerate non-JSON frames
    }
    if (chunk.error && typeof chunk.error === "object") {
      const parsed = parseErrorBody(chunk);
      throw new ViktorRunFailedError(parsed.message ?? "unknown error", {
        status: 200,
        requestId: context.requestId,
        detailCode: parsed.detailCode,
        body: chunk,
      });
    }
    if (typeof chunk.id === "string") responseId = chunk.id;
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage as ViktorUsage;

    const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Record<string, unknown> | undefined) : undefined;
    if (!choice) continue;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text-delta", text: delta.content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
        const index = typeof raw.index === "number" ? raw.index : 0;
        const fn = (raw.function ?? {}) as Record<string, unknown>;
        const current = calls.get(index) ?? { index, id: "", name: "", arguments: "" };
        if (typeof raw.id === "string") current.id = raw.id;
        if (typeof fn.name === "string") current.name = fn.name;
        const argumentsDelta = typeof fn.arguments === "string" ? fn.arguments : "";
        current.arguments += argumentsDelta;
        calls.set(index, current);
        yield {
          type: "tool-call-delta",
          index,
          id: typeof raw.id === "string" ? raw.id : undefined,
          name: typeof fn.name === "string" ? fn.name : undefined,
          argumentsDelta,
        };
      }
    }
    if (typeof choice.finish_reason === "string") {
      finishReason = choice.finish_reason as ViktorFinishReason;
      sawFinish = true;
    }
  }

  for (const toolCall of [...calls.values()].sort((a, b) => a.index - b.index)) {
    yield { type: "tool-call", toolCall };
  }
  yield { type: "finish", finishReason: sawFinish ? finishReason : null, usage, responseId };
}

/** Responses API stream: yields raw events; throws on `response.failed`. */
export async function* readResponsesStream(
  events: AsyncIterable<SseEvent>,
  context: { requestId?: string } = {},
): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  for await (const ev of events) {
    if (ev.data === "[DONE]") break;
    let payload: { type?: string; [key: string]: unknown };
    try {
      payload = JSON.parse(ev.data) as { type?: string };
    } catch {
      continue;
    }
    const type = payload.type ?? ev.event ?? "";
    if (type === "response.failed") {
      const response = (payload.response ?? {}) as { error?: { message?: string; code?: string } };
      throw new ViktorRunFailedError(response.error?.message ?? "unknown error", {
        status: 200,
        requestId: context.requestId,
        detailCode: response.error?.code,
        body: payload,
      });
    }
    if (type === "response.output_text.delta" && typeof payload.delta === "string" && STREAM_ERROR_TEXT.test(payload.delta)) {
      continue; // Viktor emits "[Stream error: …]" as text right before response.failed; drop it
    }
    yield { ...payload, type };
  }
}

/** Anthropic Messages stream: yields raw events; throws on `event: error`. */
export async function* readAnthropicStream(
  events: AsyncIterable<SseEvent>,
  context: { requestId?: string } = {},
): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  for await (const ev of events) {
    let payload: { type?: string; [key: string]: unknown };
    try {
      payload = JSON.parse(ev.data) as { type?: string };
    } catch {
      continue;
    }
    const type = payload.type ?? ev.event ?? "";
    if (type === "error") {
      const parsed = parseErrorBody(payload);
      throw new ViktorRunFailedError(parsed.message ?? "unknown error", {
        status: 200,
        requestId: context.requestId,
        detailCode: parsed.detailCode,
        body: payload,
      });
    }
    yield { ...payload, type };
  }
}

const STREAM_ERROR_TEXT = /^\s*\[Stream error: /;
