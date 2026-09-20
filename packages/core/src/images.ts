import { ViktorInvalidRequestError } from "./errors.js";

export const MAX_IMAGES_PER_REQUEST = 10;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const MIME_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };

/**
 * Viktor silently skips images it cannot use (http URLs, unsupported types, more than 10 per
 * request). Failing on the client is the only way a developer notices, so validate before sending.
 */
export function validateImageUrl(url: string): void {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)[;,]/.exec(url);
    const mime = m ? (MIME_ALIASES[m[1]!.toLowerCase()] ?? m[1]!.toLowerCase()) : "";
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mime)) {
      throw new ViktorInvalidRequestError(
        `Viktor accepts ${ALLOWED_IMAGE_MIME_TYPES.join(", ")} images; got "${mime || "unknown"}".`,
      );
    }
    const base64 = url.slice(url.indexOf(",") + 1);
    if (base64.length * 0.75 > MAX_IMAGE_BYTES) {
      throw new ViktorInvalidRequestError("Image is larger than Viktor's 20 MiB limit.");
    }
    return;
  }
  if (url.startsWith("https://")) return;
  if (url.startsWith("http://")) {
    throw new ViktorInvalidRequestError("Viktor only fetches images over https. Use an https URL or a data URL.");
  }
  throw new ViktorInvalidRequestError("Image must be an https URL or a data URL.");
}

interface ChatMessageLike {
  content?: unknown;
}

/** Validate every `image_url` part in an OpenAI-shaped message list. */
export function validateChatImages(messages: readonly ChatMessageLike[]): void {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part?.type !== "image_url") continue;
      count += 1;
      const image = part.image_url as { url?: unknown } | string | undefined;
      const url = typeof image === "string" ? image : image?.url;
      if (typeof url !== "string") throw new ViktorInvalidRequestError("image_url part is missing a url.");
      validateImageUrl(url);
    }
  }
  if (count > MAX_IMAGES_PER_REQUEST) {
    throw new ViktorInvalidRequestError(
      `Viktor accepts at most ${MAX_IMAGES_PER_REQUEST} images per request; got ${count}. Extra images would be ignored.`,
    );
  }
}
