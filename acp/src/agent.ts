import * as acp from "@agentclientprotocol/sdk";
import { ViktorError, createViktorClient, type ViktorClient, type ViktorClientOptions } from "@viktor-com/integrations-core";

export const AUTH_METHOD_ID = "viktor-api-key";

interface Session {
  /** Viktor thread id. On Viktor the Responses API response id IS the durable thread id. */
  threadId?: string;
  pending?: AbortController;
}

type PromptBlock = acp.PromptRequest["prompt"][number];

/** Convert ACP content blocks into Responses API input parts. */
export function toResponsesInput(prompt: PromptBlock[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const block of prompt) {
    if (block.type === "text") parts.push({ type: "input_text", text: block.text });
    else if (block.type === "image") parts.push({ type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` });
    else if (block.type === "resource_link") parts.push({ type: "input_text", text: `[${block.name ?? "link"}](${block.uri})` });
    else if (block.type === "resource" && "text" in block.resource) {
      parts.push({ type: "input_text", text: `File ${block.resource.uri}:\n\n${block.resource.text}` });
    }
  }
  return parts;
}

/**
 * Viktor as an Agent Client Protocol agent. One ACP session maps to one Viktor thread: the first prompt
 * starts a thread, later prompts continue it through `previous_response_id`, so Viktor keeps its
 * sandbox state and context for the whole editor session. Viktor works in its own cloud sandbox with
 * the team's tools; it does not read or write the local workspace.
 */
export class ViktorAcpAgent {
  readonly sessions = new Map<string, Session>();
  readonly #client: ViktorClient;

  constructor(options: ViktorClientOptions = {}) {
    this.#client = createViktorClient(options);
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true } },
      authMethods: [
        { id: AUTH_METHOD_ID, name: "Viktor API key", description: "Set the VIKTOR_API_KEY environment variable to a Viktor API key (zt_live_sk_…) with the chat:completions scope." },
      ],
    };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    await this.#client.listModels(); // throws ViktorAuthError with a fix hint when the key is wrong
    return {};
  }

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {});
    return { sessionId };
  }

  async prompt(params: acp.PromptRequest, notify: (update: acp.SessionNotification) => Promise<void>): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);
    session.pending?.abort();
    const pending = (session.pending = new AbortController());
    let stopReason: acp.PromptResponse["stopReason"] = "end_turn";
    try {
      const body: Record<string, unknown> = { input: [{ role: "user", content: toResponsesInput(params.prompt) }] };
      if (session.threadId) body.previous_response_id = session.threadId;
      for await (const event of this.#client.responseStream(body, { signal: pending.signal })) {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
          await notify({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta } } });
        } else if (event.type === "response.completed" || event.type === "response.incomplete") {
          const response = event.response as { id?: string } | undefined;
          if (response?.id) session.threadId = response.id;
          if (event.type === "response.incomplete") stopReason = "max_tokens";
        }
      }
    } catch (error) {
      if (pending.signal.aborted) return { stopReason: "cancelled" };
      if (error instanceof ViktorError) throw acp.RequestError.internalError({ code: error.code, detailCode: error.detailCode, requestId: error.requestId }, error.message);
      throw error;
    } finally {
      if (session.pending === pending) session.pending = undefined;
    }
    return { stopReason };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pending?.abort();
  }
}

/** Wire the agent to an ACP stream (stdio in the CLI). */
export function connectViktorAgent(stream: acp.Stream, options: ViktorClientOptions = {}) {
  const agent = new ViktorAcpAgent(options);
  const connection = acp
    .agent({ name: "viktor" })
    .onRequest("initialize", (ctx) => agent.initialize(ctx.params))
    .onRequest("authenticate", (ctx) => agent.authenticate(ctx.params))
    .onRequest("session/new", (ctx) => agent.newSession(ctx.params))
    .onRequest("session/prompt", (ctx) => agent.prompt(ctx.params, (update) => ctx.client.notify(acp.methods.client.session.update, update)))
    .onNotification("session/cancel", (ctx) => agent.cancel(ctx.params))
    .connect(stream);
  return { agent, connection };
}
