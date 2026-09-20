/**
 * Viktor tool-call ids are routing tokens: `call_vk1_<thread>_<c|t|b>_<suffix>` on OpenAI wires
 * and `toolu_vk1_…` on the Anthropic wire. They embed the durable thread id, so a follow-up request
 * whose trailing tool results carry them resumes that thread. Never rewrite or regenerate them.
 */
const PATTERN = /^call_vk1_([A-Za-z0-9]{20,24})_([ctb])_([A-Za-z0-9_-]{1,64})$/;

export interface RoutedToolId {
  threadId: string;
  kind: "c" | "t" | "b";
  suffix: string;
}

export function parseRoutedToolId(id: string): RoutedToolId | null {
  if (!id) return null;
  const normalized = id.startsWith("toolu_") ? `call_${id.slice(6)}` : id;
  const m = PATTERN.exec(normalized);
  if (!m) return null;
  return { threadId: m[1]!, kind: m[2] as RoutedToolId["kind"], suffix: m[3]! };
}

export function isRoutedToolId(id: string): boolean {
  return parseRoutedToolId(id) !== null;
}

const THREAD_ID = /^[A-Za-z0-9]{20,24}$/;

/**
 * Extract the Viktor thread id from a routed tool-call id or from a Responses API response id
 * (on Viktor the response id IS the thread id). Returns null for anything else, including
 * Chat Completions ids (`chatcmpl-…`) and non-routed tool ids.
 */
export function threadIdFrom(id: string | null | undefined): string | null {
  if (!id) return null;
  const routed = parseRoutedToolId(id);
  if (routed) return routed.threadId;
  return THREAD_ID.test(id) ? id : null;
}
