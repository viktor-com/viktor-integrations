import type { RequestOptions, ViktorClient } from "./client.js";
import { ViktorError, ViktorRateLimitError } from "./errors.js";
import { DELEGATE_TOOL_SPEC } from "./generated/spec.js";

/** Name, description and JSON Schemas of the delegate tool. Single source: spec/delegate-tool.json. */
export const delegateToolSpec = DELEGATE_TOOL_SPEC;

export interface DelegateInput {
  task: string;
  thread_id?: string;
  response_schema?: Record<string, unknown>;
  speed?: "faster" | "smarter";
  timeout_seconds?: number;
}

export interface DelegateArtifact {
  display_name: string;
  content_type: string | null;
  download_url: string;
  expires_at: string | null;
}

export interface DelegateResult {
  status: "completed" | "requires_action" | "failed" | "cancelled" | "timed_out";
  markdown: string | null;
  json: unknown;
  artifacts: DelegateArtifact[];
  error: { code: string; message: string } | null;
  thread_id: string;
  run_id: string;
}

export interface DelegateOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  idempotencyKey?: string;
  /** Called on every poll with the current run status. */
  onStatus?: (status: string) => void;
  /** Resolve artifact download URLs (one extra request per artifact). Default: true. */
  resolveArtifacts?: boolean;
}

const ACTIVE = new Set(["queued", "in_progress", "cancellation_requested"]);
const REST = "/api/public/v1";

interface RunStatus {
  id: string;
  thread_id: string;
  status: string;
  error: { code: string; message: string } | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

/**
 * Delegate a task to Viktor over the native REST API: create a thread (or post to an existing
 * one), poll the run until it leaves the active states, then fetch the result and artifacts.
 * Unlike the chat wire this has no 600 s cap and reports `requires_action` explicitly.
 */
export async function delegateToViktor(client: ViktorClient, input: DelegateInput, options: DelegateOptions = {}): Promise<DelegateResult> {
  const { signal, pollIntervalMs = 2500, onStatus, resolveArtifacts = true } = options;
  const req: RequestOptions = { signal };
  const timeoutMs = (input.timeout_seconds ?? 600) * 1000;

  const body: Record<string, unknown> = {
    message: input.task,
    response_format: input.response_schema
      ? { type: "json_schema", json_schema: { name: "result", schema: input.response_schema } }
      : { type: "text" },
  };
  if (input.speed) body.speed = input.speed;

  const createOpts: RequestOptions = { ...req, idempotencyKey: options.idempotencyKey };
  let threadId: string;
  let runId: string;
  if (input.thread_id) {
    const created = await client.request<{ run: { id: string } }>("POST", `${REST}/threads/${encodeURIComponent(input.thread_id)}/messages`, body, createOpts);
    threadId = input.thread_id;
    runId = created.run.id;
  } else {
    const created = await client.request<{ thread: { id: string }; run: { id: string } }>("POST", `${REST}/threads`, body, createOpts);
    threadId = created.thread.id;
    runId = created.run.id;
  }

  const started = Date.now();
  let run: RunStatus;
  for (;;) {
    try {
      run = await client.request<RunStatus>("GET", `${REST}/runs/${encodeURIComponent(runId)}`, undefined, req);
    } catch (err) {
      if (err instanceof ViktorRateLimitError) {
        await sleep(Math.min((err.retryAfterSeconds ?? 5) * 1000, 30_000), signal);
        continue;
      }
      throw err;
    }
    onStatus?.(run.status);
    if (!ACTIVE.has(run.status)) break;
    if (Date.now() - started >= timeoutMs) {
      return { status: "timed_out", markdown: null, json: null, artifacts: [], error: null, thread_id: threadId, run_id: runId };
    }
    await sleep(pollIntervalMs, signal);
  }

  const base = { thread_id: threadId, run_id: runId };
  if (run.status === "cancelled") {
    return { status: "cancelled", markdown: null, json: null, artifacts: [], error: run.error, ...base };
  }

  let result: { status: string; markdown?: string | null; json?: unknown; artifacts?: Array<{ id: string; display_name?: string; content_type?: string | null }> };
  try {
    result = await client.request("GET", `${REST}/runs/${encodeURIComponent(runId)}/result`, undefined, req);
  } catch (err) {
    if (err instanceof ViktorError && err.status === 409) {
      const error = run.error ?? { code: err.detailCode ?? "result_not_available", message: err.message };
      return { status: run.status === "timed_out" ? "timed_out" : "failed", markdown: null, json: null, artifacts: [], error, ...base };
    }
    throw err;
  }

  const artifacts: DelegateArtifact[] = [];
  for (const a of result.artifacts ?? []) {
    let url = `${client.baseURL}${REST}/files/${encodeURIComponent(a.id)}/download-url`;
    let expires: string | null = null;
    if (resolveArtifacts) {
      try {
        const dl = await client.request<{ url: string; expires_at?: string }>("GET", `${REST}/files/${encodeURIComponent(a.id)}/download-url`, undefined, req);
        url = dl.url.startsWith("http") ? dl.url : `${client.baseURL}${dl.url}`;
        expires = dl.expires_at ?? null;
      } catch {
        /* keep the exchange URL; the caller can resolve it with the API key */
      }
    }
    artifacts.push({ display_name: a.display_name ?? a.id, content_type: a.content_type ?? null, download_url: url, expires_at: expires });
  }

  const status = run.status === "completed" || run.status === "requires_action" ? run.status : run.status === "timed_out" ? "timed_out" : "failed";
  return { status, markdown: result.markdown ?? null, json: result.json ?? null, artifacts, error: run.error, ...base } as DelegateResult;
}

/** Render a DelegateResult as the text a model should read as the tool result. */
export function formatDelegateResult(result: DelegateResult): string {
  const lines: string[] = [];
  if (result.status === "requires_action") lines.push("Viktor needs input before it can continue. Answer by calling this tool again with the same thread_id.");
  if (result.status === "timed_out") lines.push("Viktor is still working. Call this tool again later with the same thread_id to ask for the result.");
  if (result.status === "failed" || result.status === "cancelled") lines.push(`Viktor run ${result.status}${result.error ? `: ${result.error.message}` : "."}`);
  if (result.markdown) lines.push(result.markdown);
  if (result.json !== null && result.json !== undefined) lines.push("```json\n" + JSON.stringify(result.json, null, 2) + "\n```");
  for (const a of result.artifacts) lines.push(`File: ${a.display_name} (${a.content_type ?? "unknown type"}) ${a.download_url}`);
  lines.push(`(status: ${result.status}, thread_id: ${result.thread_id}, run_id: ${result.run_id})`);
  return lines.join("\n\n");
}
