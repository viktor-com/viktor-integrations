import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { NoSuchModelError, type LanguageModelV4, type ProviderV4 } from "@ai-sdk/provider";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { DEFAULT_TIMEOUT_MS, VIKTOR_MODEL_ID, longRunningFetch, resolveApiKey, resolveBaseURL } from "@viktor-com/integrations-core";
import { wrapLanguageModel } from "ai";
import { viktorMiddleware } from "./viktor-middleware.js";

/** Viktor exposes exactly one model. Any other id is sent as `viktor`. */
export type ViktorModelId = "viktor" | (string & {});

export interface ViktorProviderSettings {
  /** Viktor API key (`zt_live_sk_…`). Defaults to the `VIKTOR_API_KEY` environment variable. */
  apiKey?: string;
  /** Viktor host, without a path. Defaults to `VIKTOR_BASE_URL`, then `https://api.viktor.com`. */
  baseURL?: string;
  /** Extra headers for every request. */
  headers?: Record<string, string>;
  /** Custom fetch, for tests or proxies. */
  fetch?: FetchFunction;
  /**
   * Throw `ViktorEmptyReplyError` when Viktor answers with no text and no tool calls.
   * Default `false`: the result carries a warning instead.
   */
  strictEmptyReply?: boolean;
  /**
   * Abort a request after this many milliseconds. Default 660 000: a Viktor run can take up to
   * 600 s while Viktor works in its own tools, and the server should be the one to end it.
   */
  timeoutMs?: number;
}

export interface ViktorProvider extends ProviderV4 {
  (modelId?: ViktorModelId): LanguageModelV4;
  languageModel(modelId?: ViktorModelId): LanguageModelV4;
  chatModel(modelId?: ViktorModelId): LanguageModelV4;
}

export function createViktor(settings: ViktorProviderSettings = {}): ViktorProvider {
  // Node's default fetch gives up after 300 s without headers; a non-streaming Viktor run can take 600 s.
  const baseFetch: FetchFunction = settings.fetch ?? (longRunningFetch(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS) as FetchFunction);

  // The key is resolved per request so `VIKTOR_API_KEY` can be set after import, and a missing
  // key fails with a clear message at call time instead of at module load.
  const fetchWithAuth: FetchFunction = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${resolveApiKey(settings.apiKey)}`);
    const timeout = AbortSignal.timeout(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return baseFetch(input, { ...init, headers, signal });
  };

  const compatible = createOpenAICompatible({
    name: "viktor",
    baseURL: `${resolveBaseURL(settings.baseURL)}/api/compat/v1`,
    headers: settings.headers,
    fetch: fetchWithAuth,
    includeUsage: true,
    supportsStructuredOutputs: true,
    // Viktor fetches https images itself; everything else is inlined by the AI SDK as a data URL.
    supportedUrls: () => ({ "image/*": [/^https:\/\/.+$/] }),
    transformRequestBody: (body) => ({ ...body, model: VIKTOR_MODEL_ID }),
  });

  const createModel = (modelId: ViktorModelId = VIKTOR_MODEL_ID): LanguageModelV4 =>
    wrapLanguageModel({
      model: compatible.chatModel(modelId),
      middleware: viktorMiddleware({ strictEmptyReply: settings.strictEmptyReply }),
      modelId: VIKTOR_MODEL_ID,
      providerId: "viktor",
    }) as LanguageModelV4;

  const provider = ((modelId?: ViktorModelId) => createModel(modelId)) as ViktorProvider;
  Object.assign(provider, {
    specificationVersion: "v4",
    languageModel: createModel,
    chatModel: createModel,
    embeddingModel: (modelId: string) => {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
    imageModel: (modelId: string) => {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" });
    },
  });
  return provider;
}

/** Default provider instance. Reads `VIKTOR_API_KEY` and `VIKTOR_BASE_URL` when a request is made. */
export const viktor: ViktorProvider = createViktor();
