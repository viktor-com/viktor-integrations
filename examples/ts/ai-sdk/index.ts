// Runnable example: Viktor as an AI SDK model with streaming and a caller-side tool.
//   VIKTOR_API_KEY=zt_live_sk_... npm start          (live, against api.viktor.com)
//   npm run start:offline                            (replays recorded fixtures, no key needed)
import { createViktor } from "@viktor/ai-sdk-provider";
import { isStepCount, streamText, tool } from "ai";
import { z } from "zod";

const offline = process.env.VIKTOR_EXAMPLE_OFFLINE === "1";
let fetchImpl: typeof fetch | undefined;
if (offline) {
  const { createFixtureFetch } = await import("@viktor/integrations-core/testing");
  fetchImpl = createFixtureFetch("chat-stream-tool-call", "chat-stream-text") as unknown as typeof fetch;
}

const viktor = createViktor({ fetch: fetchImpl, apiKey: offline ? "zt_test_sk_offline" : undefined });

const result = streamText({
  model: viktor(),
  tools: {
    get_weather: tool({
      description: "Get the weather for a city",
      inputSchema: z.object({ city: z.string(), units: z.string().optional() }),
      execute: async ({ city }) => {
        console.log(`\n[tool] get_weather(${city})`);
        return `Sunny, 24C in ${city}`;
      },
    }),
  },
  stopWhen: isStepCount(4),
  prompt: "What is the weather in Berlin? Use the tool, then answer in one line.",
  onError: ({ error }) => console.error("\n[error]", error),
});

for await (const delta of result.textStream) process.stdout.write(delta);
const steps = await result.steps;
console.log(`\n\nsteps: ${steps.length}, tool calls: ${steps.flatMap((s) => s.toolCalls).map((c) => c.toolCallId).join(", ") || "none"}`);
console.log(`viktor thread: ${steps.map((s) => s.providerMetadata?.viktor?.threadId).find(Boolean) ?? "n/a"}`);
