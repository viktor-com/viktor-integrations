import * as acp from "@agentclientprotocol/sdk";
import { createFixtureFetch } from "@viktor-com/integrations-core/testing";
import { describe, expect, it } from "vitest";
import { AUTH_METHOD_ID, connectViktorAgent, toResponsesInput } from "../src/agent.js";

/** A real ACP client and the Viktor agent, connected through in-memory byte streams. */
async function session<T>(fixtures: string[], run: (ctx: { prompt: (text: string) => Promise<{ text: string; stopReason: string }> }, init: acp.InitializeResponse) => Promise<T>) {
  const fetch = createFixtureFetch(...fixtures);
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  connectViktorAgent(acp.ndJsonStream(toClient.writable, toAgent.readable), { apiKey: "zt_test_sk_fixture", baseURL: "https://viktor.test", fetch, onWarning: () => {} });
  const result = await acp
    .client({ name: "test-client" })
    .connectWith(acp.ndJsonStream(toAgent.writable, toClient.readable), async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      return ctx.buildSession("/tmp/project").withSession((s) =>
        run(
          {
            prompt: async (text) => {
              s.prompt(text);
              let out = "";
              for (;;) {
                const message = await s.nextUpdate();
                if (message.kind === "stop") return { text: out, stopReason: message.response.stopReason };
                const update = message.notification.update;
                if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") out += update.content.text;
              }
            },
          },
          init,
        ),
      );
    });
  return { result, fetch };
}

describe("viktor-acp", () => {
  it("completes the ACP v1 handshake and advertises the API-key auth method", async () => {
    const { result } = await session(["responses-stream-text"], async (_s, init) => init);
    expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(result.authMethods?.[0]?.id).toBe(AUTH_METHOD_ID);
    expect(result.agentCapabilities?.promptCapabilities?.image).toBe(true);
  });

  it("streams Viktor's reply as agent_message_chunk updates and ends the turn", async () => {
    const { result, fetch } = await session(["responses-stream-text"], (s) => s.prompt("Say hello"));
    expect(result).toEqual({ text: "Hello from Viktor.", stopReason: "end_turn" });
    const req = fetch.requests[0]!;
    expect(req.url).toBe("https://viktor.test/api/compat/v1/responses");
    expect(req.headers.authorization).toBe("Bearer zt_test_sk_fixture");
    expect((req.body as { previous_response_id?: string }).previous_response_id).toBeUndefined();
  });

  it("maps a session to one Viktor thread: the second prompt continues it with previous_response_id", async () => {
    const { fetch } = await session(["responses-stream-text"], async (s) => {
      await s.prompt("first");
      return s.prompt("second");
    });
    expect(fetch.requests).toHaveLength(2);
    expect((fetch.requests[1]!.body as { previous_response_id: string }).previous_response_id).toBe("zwKTTPTKCc9TVsSMgJuGh");
  });

  it("reports a failed Viktor run as a request error with Viktor's message, without leaking the stream-error text", async () => {
    const failure = session(["responses-stream-failed"], (s) => s.prompt("x"));
    await expect(failure).rejects.toThrow(/empty response twice/);
  });

  it("converts ACP content blocks to Responses input parts", () => {
    expect(
      toResponsesInput([
        { type: "text", text: "look" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "resource_link", name: "spec", uri: "file:///spec.md" },
        { type: "resource", resource: { uri: "file:///a.ts", text: "const a = 1;" } },
      ] as never),
    ).toEqual([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      { type: "input_text", text: "[spec](file:///spec.md)" },
      { type: "input_text", text: "File file:///a.ts:\n\nconst a = 1;" },
    ]);
  });
});
