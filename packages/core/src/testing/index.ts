import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../client.js";

export interface Fixture {
  name: string;
  provenance: "contract" | "live";
  source?: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body?: unknown; sse?: string[] };
  assert?: Record<string, unknown>;
}

/** Locate the repo-level `fixtures/` directory by walking up from this file. */
export function fixturesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      if (readdirSync(join(dir, "fixtures")).some((f) => f.endsWith(".json"))) return join(dir, "fixtures");
    } catch {
      /* keep walking */
    }
    dir = dirname(dir);
  }
  throw new Error("fixtures/ directory not found");
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(fixturesDir(), `${name}.json`), "utf8")) as Fixture;
}

export function listFixtures(): string[] {
  return readdirSync(fixturesDir()).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FixtureFetch extends FetchLike {
  requests: RecordedRequest[];
}

function toResponse(fx: Fixture): Response {
  const { status, headers, body, sse } = fx.response;
  if (sse) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split frames across chunk boundaries on purpose so parsers must buffer correctly.
        for (const frame of sse) {
          const text = `${frame}\n\n`;
          const cut = Math.max(1, Math.floor(text.length / 2));
          controller.enqueue(encoder.encode(text.slice(0, cut)));
          controller.enqueue(encoder.encode(text.slice(cut)));
        }
        controller.close();
      },
    });
    return new Response(stream, { status, headers });
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * A `fetch` that replays recorded fixtures instead of calling Viktor. Pass one fixture name to
 * answer every request with it, or several to answer requests in order. Requests are recorded
 * on `.requests` for assertions (for example that tool-call ids were passed back unchanged).
 */
export function createFixtureFetch(...names: string[]): FixtureFetch {
  const fixtures = names.map(loadFixture);
  let i = 0;
  const requests: RecordedRequest[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = init?.method ?? req?.method ?? "GET";
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? req?.headers).forEach((v, k) => (headers[k] = v));
    const raw = init?.body ?? (req ? await req.text() : undefined);
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep raw */
      }
    }
    requests.push({ url, method, headers, body });
    const fx = fixtures[Math.min(i, fixtures.length - 1)]!;
    i += 1;
    return toResponse(fx);
  }) as FixtureFetch;
  fn.requests = requests;
  return fn;
}

/** True when live contract tests can run. */
export function hasLiveKey(): boolean {
  return Boolean(process.env.VIKTOR_API_KEY);
}

export const LIVE_SKIP_MESSAGE =
  "LIVE CONTRACT TEST SKIPPED: set VIKTOR_API_KEY (scope chat:completions) and optionally VIKTOR_BASE_URL to run it.";
