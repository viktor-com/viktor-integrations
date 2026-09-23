// Runnable example: Viktor as a LangChain agent model, streaming, with one caller-side tool.
//   VIKTOR_API_KEY=zt_live_sk_... npm start          (live, against api.viktor.com)
//   npm run start:offline                            (replays recorded fixtures, no key needed)
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatViktor, threadIdFrom } from "@viktor-com/langchain";
import { createAgent } from "langchain";
import { z } from "zod";

const offline = process.env.VIKTOR_EXAMPLE_OFFLINE === "1";
let fetchImpl: typeof fetch | undefined;
if (offline) {
  const { createFixtureFetch } = await import("@viktor-com/integrations-core/testing");
  fetchImpl = createFixtureFetch("chat-stream-tool-call", "chat-stream-text") as unknown as typeof fetch;
}

const model = new ChatViktor({
  apiKey: offline ? "zt_test_sk_offline" : undefined,
  configuration: fetchImpl ? { fetch: fetchImpl } : undefined,
});

const getWeather = tool(
  async ({ city }) => {
    console.log(`\n[tool] get_weather(${city})`);
    return `Sunny, 24C in ${city}`;
  },
  {
    name: "get_weather",
    description: "Get the weather for a city",
    schema: z.object({ city: z.string(), units: z.string().optional() }),
  },
);

const agent = createAgent({ model, tools: [getWeather] });

const stream = await agent.stream(
  { messages: [{ role: "user", content: "What is the weather in Berlin? Use the tool, then answer in one line." }] },
  { streamMode: "messages", recursionLimit: 10 },
);

const toolCallIds: string[] = [];
for await (const [message] of stream) {
  if (AIMessageChunk.isInstance(message)) process.stdout.write(message.text);
  if (ToolMessage.isInstance(message)) toolCallIds.push(message.tool_call_id);
}

console.log(`\n\ntool calls: ${toolCallIds.join(", ") || "none"}`);
console.log(`viktor thread: ${toolCallIds.map((id) => threadIdFrom(id)).find(Boolean) ?? "n/a"}`);
