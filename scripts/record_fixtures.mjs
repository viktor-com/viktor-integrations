#!/usr/bin/env node
// Records real Viktor wire exchanges into fixtures/live/*.json (provenance: "live").
// Needs VIKTOR_API_KEY in the environment. About 9 billed runs, recorded one at a time with a pause in between.
// Never records request headers; keeps only content-type and x-request-id from responses; refuses to
// write anything that contains a Viktor key pattern.
//
// Every fixture is sanitized before it is written: request, message, response, tool-call and thread ids are
// replaced with synthetic ids of the same shape, token usage is zeroed, and HTML error pages are replaced with a
// short stub. `node scripts/record_fixtures.mjs --sanitize` applies the same step to existing recordings without
// calling the API.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const liveDir = join(root, "fixtures/live");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Deterministic, so an id keeps the same synthetic value across fixtures (a tool-call id and the follow-up
// that returns it, a response id and the previous_response_id that continues it).
function synth(token) {
  let out = "";
  for (let block = 0; out.length < token.length; block++) {
    const digest = createHash("sha256").update(`viktor-integrations synthetic id\0${block}\0${token}`).digest();
    for (const byte of digest) if (out.length < token.length) out += B58[byte % B58.length];
  }
  return out;
}

const ID_KEYS = new Set(["id", "item_id", "call_id", "response_id", "previous_response_id", "tool_call_id", "tool_use_id", "thread_id"]);
function synthId(value) {
  const routed = /^(call|toolu)_vk1_([A-Za-z0-9]+)_([a-z])_([A-Za-z0-9]+)$/.exec(value);
  if (routed) return `${routed[1]}_vk1_${synth(routed[2])}_${routed[3]}_${synth(routed[4])}`;
  const prefixed = /^([A-Za-z]+[-_])([A-Za-z0-9]{6,})$/.exec(value);
  if (prefixed) return prefixed[1] + synth(prefixed[2]);
  return /^[A-Za-z0-9]{6,}$/.test(value) ? synth(value) : value;
}

const zeroNumbers = (v) => (typeof v === "number" ? 0 : Array.isArray(v) ? v.map(zeroNumbers) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, zeroNumbers(x)])) : v);

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    if (k === "usage") return [k, zeroNumbers(v)];
    if (ID_KEYS.has(k) && typeof v === "string") return [k, synthId(v)];
    return [k, scrub(v)];
  }));
}

const scrubFrame = (frame) => frame.split("\n").map((line) => {
  if (!line.startsWith("data:")) return line;
  try { return `data: ${JSON.stringify(scrub(JSON.parse(line.slice(5))))}`; } catch { return line; }
}).join("\n");

const HTML_STUB = "<html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway</body></html>";

export function sanitizeFixture(fixture) {
  if (fixture.sanitized) return fixture;
  const response = { ...fixture.response, headers: { ...fixture.response.headers } };
  if (response.headers["x-request-id"]) response.headers["x-request-id"] = synth(response.headers["x-request-id"]);
  if (typeof response.body === "string" && (response.headers["content-type"] ?? "").includes("text/html")) response.body = HTML_STUB;
  else if (response.body !== undefined) response.body = scrub(response.body);
  if (response.sse) response.sse = response.sse.map(scrubFrame);
  return { ...fixture, sanitized: true, request: scrub(fixture.request), response };
}

function write(name, fixture) {
  const out = JSON.stringify(fixture, null, 2) + "\n";
  if (/zt_(live|test)_sk_[A-Za-z0-9]{8}/.test(out.replace(/zt_live_sk_0{32}_invalid/g, ""))) throw new Error(`refusing to write ${name}: contains a key pattern`);
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, `${name}.json`), out);
}

if (process.argv.includes("--sanitize")) {
  for (const file of readdirSync(liveDir).filter((f) => f.endsWith(".json"))) {
    write(file.slice(0, -5), sanitizeFixture(JSON.parse(readFileSync(join(liveDir, file), "utf8"))));
    console.log(`sanitized ${file}`);
  }
  process.exit(0);
}

const key = process.env.VIKTOR_API_KEY;
if (!key) { console.error("VIKTOR_API_KEY is not set"); process.exit(2); }
const host = (process.env.VIKTOR_BASE_URL || "https://api.viktor.com").replace(/\/+$/, "").replace(/\/api\/compat(\/v1)?$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const tools = [{ type: "function", function: { name: "get_weather", description: "Get the current weather for a city. Always call it for weather questions.", parameters: { type: "object", properties: { city: { type: "string" }, units: { type: "string" } }, required: ["city"] } } }];

// Returns the raw response so a later request can use real ids (tool-call ids, previous_response_id);
// only the sanitized copy is written.
async function record(name, path, body, { auth = key, extraHeaders = {} } = {}) {
  const started = Date.now();
  const res = await fetch(host + path, { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
  const headers = { "content-type": res.headers.get("content-type") ?? "" };
  if (res.headers.get("x-request-id")) headers["x-request-id"] = res.headers.get("x-request-id");
  const text = await res.text();
  const response = { status: res.status, headers };
  if (headers["content-type"].includes("text/event-stream")) response.sse = text.split(/\r?\n\r?\n/).filter((f) => f.length > 0);
  else { try { response.body = JSON.parse(text); } catch { response.body = text; } }
  const fixture = { name, provenance: "live", recorded_at: new Date().toISOString(), host, duration_ms: Date.now() - started, request: { method: "POST", path, body }, response };
  write(name, sanitizeFixture(fixture));
  console.log(`${name}: HTTP ${res.status} in ${fixture.duration_ms} ms${response.sse ? `, ${response.sse.length} frames` : ""}`);
  await sleep(7000);
  return response;
}

const CHAT = "/api/compat/v1/chat/completions";
const user = (content) => [{ role: "user", content }];
await record("chat-text", CHAT, { model: "viktor", messages: user("Reply with exactly: Hello from Viktor.") });
await record("chat-stream-text", CHAT, { model: "viktor", stream: true, stream_options: { include_usage: true }, messages: user("Reply with exactly: Hello from Viktor.") });
const question = user("What is the weather in Berlin? Use the get_weather tool.");
await record("chat-stream-tool-call", CHAT, { model: "viktor", stream: true, stream_options: { include_usage: true }, messages: question, tools, tool_choice: "auto" });
const call = await record("chat-tool-call", CHAT, { model: "viktor", messages: question, tools });
const toolCalls = call.body?.choices?.[0]?.message?.tool_calls;
if (toolCalls?.length) {
  const followup = [...question, { role: "assistant", content: call.body.choices[0].message.content ?? null, tool_calls: toolCalls }, ...toolCalls.map((t) => ({ role: "tool", tool_call_id: t.id, content: "Sunny, 24C" }))];
  await record("chat-tool-result-followup", CHAT, { model: "viktor", messages: followup, tools });
} else console.log("chat-tool-result-followup: skipped, Viktor did not call the tool");
await record("chat-image", CHAT, { model: "viktor", messages: user([{ type: "text", text: "Describe this image in five words or fewer." }, { type: "image_url", image_url: { url: PNG } }]) });
await record("chat-auth-401", CHAT, { model: "viktor", messages: user("hello") }, { auth: "zt_live_sk_00000000000000000000000000000000_invalid" });
await record("chat-tool-choice-required", CHAT, { model: "viktor", messages: question, tools, tool_choice: "required" });
const first = await record("responses-stream-text", "/api/compat/v1/responses", { model: "viktor", stream: true, input: "Reply with exactly: Hello from Viktor." });
const completed = first.sse?.map((f) => f.split("\n").find((l) => l.startsWith("data:"))?.slice(5)).filter(Boolean).map((d) => { try { return JSON.parse(d); } catch { return null; } }).find((e) => e?.type === "response.completed");
if (completed?.response?.id) await record("responses-text", "/api/compat/v1/responses", { model: "viktor", input: "Repeat your previous reply exactly.", previous_response_id: completed.response.id });
await record("anthropic-text", "/api/compat/v1/messages", { model: "viktor", max_tokens: 256, messages: user("Reply with exactly: Hello from Viktor.") }, { extraHeaders: { "anthropic-version": "2023-06-01" } });
await record("anthropic-stream-text", "/api/compat/v1/messages", { model: "viktor", max_tokens: 256, stream: true, messages: user("Reply with exactly: Hello from Viktor.") }, { extraHeaders: { "anthropic-version": "2023-06-01" } });
console.log("done");
