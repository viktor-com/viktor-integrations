#!/usr/bin/env node
// Records real Viktor wire exchanges into fixtures/live/*.json (provenance: "live").
// Needs VIKTOR_API_KEY in the environment. About 9 billed runs, paced under the 10-per-minute limit.
// Never records request headers; keeps only content-type and x-request-id from responses; refuses to
// write anything that contains a Viktor key pattern.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const key = process.env.VIKTOR_API_KEY;
if (!key) { console.error("VIKTOR_API_KEY is not set"); process.exit(2); }
const host = (process.env.VIKTOR_BASE_URL || "https://api.viktor.com").replace(/\/+$/, "").replace(/\/api\/compat(\/v1)?$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const tools = [{ type: "function", function: { name: "get_weather", description: "Get the current weather for a city. Always call it for weather questions.", parameters: { type: "object", properties: { city: { type: "string" }, units: { type: "string" } }, required: ["city"] } } }];

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
  const out = JSON.stringify(fixture, null, 2) + "\n";
  if (/zt_(live|test)_sk_[A-Za-z0-9]{8}/.test(out.replace(/zt_live_sk_0{32}_invalid/g, ""))) throw new Error(`refusing to write ${name}: contains a key pattern`);
  mkdirSync(join(root, "fixtures/live"), { recursive: true });
  writeFileSync(join(root, "fixtures/live", `${name}.json`), out);
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
