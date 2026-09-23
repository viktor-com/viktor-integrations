// Runnable example: a triage agent hands off to Viktor, which streams and calls a function tool.
//   VIKTOR_API_KEY=zt_live_sk_... npm start     (live)
//   npm run start:offline                       (replays recorded fixtures, no key needed)
import { Agent, run, setTracingDisabled, tool } from "@openai/agents";
import { viktorAgent } from "@viktor-com/openai-agents";
import { z } from "zod";

setTracingDisabled(true);
const offline = process.env.VIKTOR_EXAMPLE_OFFLINE === "1";
let fetchImpl: typeof fetch | undefined;
if (offline) {
  const { createFixtureFetch } = await import("@viktor-com/integrations-core/testing");
  fetchImpl = createFixtureFetch("chat-stream-tool-call", "chat-stream-text") as unknown as typeof fetch;
}

const getWeather = tool({
  name: "get_weather",
  description: "Get the weather for a city",
  parameters: z.object({ city: z.string(), units: z.string().nullable().optional() }),
  execute: async ({ city }) => {
    console.log(`\n[tool] get_weather(${city})`);
    return `Sunny, 24C in ${city}`;
  },
});

const viktor = viktorAgent({ tools: [getWeather], fetch: fetchImpl as never, apiKey: offline ? "zt_test_sk_offline" : undefined });
const stream = await run(viktor, "What is the weather in Berlin? Use the tool, then answer in one line.", { stream: true });
for await (const text of stream.toTextStream()) process.stdout.write(text);
await stream.completed;
console.log(`\n\nagent: ${stream.lastAgent?.name}, final: ${stream.finalOutput}`);
