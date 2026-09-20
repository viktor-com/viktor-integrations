import type { FetchLike } from "./client.js";

/**
 * Node's built-in fetch (undici) gives up after 300 s without response headers, and after 300 s
 * between body chunks. A non-streaming Viktor run can legitimately take up to 600 s before the
 * first byte, so the default fetch would fail long runs with `UND_ERR_HEADERS_TIMEOUT`.
 *
 * `longRunningFetch` returns a fetch whose header and body timeouts are raised to `timeoutMs`.
 * It uses the `undici` package's own `fetch` + `Agent` pair (same version, so no dispatcher
 * mismatch with the runtime's bundled copy). Outside Node (edge runtimes, Deno, Bun, browsers)
 * it falls back to the global fetch, which has no such limit or manages it itself.
 */
export function longRunningFetch(timeoutMs: number): FetchLike {
  let resolved: Promise<FetchLike> | undefined;
  const resolve = (): Promise<FetchLike> =>
    (resolved ??= (async () => {
      const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
      const isNode = typeof process !== "undefined" && Boolean(process.versions?.node) && !("Bun" in globalThis) && !("Deno" in globalThis);
      if (!isNode) return globalFetch;
      try {
        const undici = await import("undici");
        const dispatcher = new undici.Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
        return ((input: string | URL | Request, init?: RequestInit) =>
          undici.fetch(input as never, { ...(init as object), dispatcher } as never) as unknown as Promise<Response>) as FetchLike;
      } catch {
        return globalFetch;
      }
    })());
  return async (input, init) => (await resolve())(input, init);
}
