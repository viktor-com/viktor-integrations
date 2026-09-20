// Runnable example: a Mastra agent on the Viktor model, streaming, with a caller-side tool.
//   VIKTOR_API_KEY=zt_live_sk_... npm start     (live)
//   npm run start:offline                       (replays recorded fixtures, no key needed)
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { viktorModel } from "@viktor/mastra";
import { z } from "zod";

const offline = process.env.VIKTOR_EXAMPLE_OFFLINE === "1";
let fetchImpl: typeof fetch | undefined;
if (offline) {
  const { createFixtureFetch } = await import("@viktor/integrations-core/testing");
  fetchImpl = createFixtureFetch("chat-stream-tool-call", "chat-stream-text") as unknown as typeof fetch;
}

const getWeather = createTool({
  id: "get_weather",
  description: "Get the weather for a city",
  inputSchema: z.object({ city: z.string(), units: z.string().optional() }),
  execute: async (input) => {
    const { city } = input as { city: string };
    console.log(`\n[tool] get_weather(${city})`);
    return `Sunny, 24C in ${city}`;
  },
});

const agent = new Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "Use tools when they help. Answer in one line.",
  model: viktorModel({ fetch: fetchImpl as never, apiKey: offline ? "zt_test_sk_offline" : undefined }),
  tools: { get_weather: getWeather },
});

const stream = await agent.stream("What is the weather in Berlin?");
for await (const chunk of stream.textStream) process.stdout.write(chunk);
console.log("\n\ndone");
