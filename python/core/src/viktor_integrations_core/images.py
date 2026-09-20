"""Client-side image checks. Viktor silently skips images it cannot use, so fail early instead."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

from .errors import ViktorInvalidRequestError

MAX_IMAGES_PER_REQUEST = 10
MAX_IMAGE_BYTES = 20 * 1024 * 1024
ALLOWED_IMAGE_MIME_TYPES = ("image/jpeg", "image/png", "image/gif", "image/webp")
_ALIASES = {"image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png"}
_DATA_URL = re.compile(r"^data:([^;,]+)[;,]")


def validate_image_url(url: str) -> None:
    if url.startswith("data:"):
        m = _DATA_URL.match(url)
        mime = m.group(1).lower() if m else ""
        mime = _ALIASES.get(mime, mime)
        if mime not in ALLOWED_IMAGE_MIME_TYPES:
            allowed = ", ".join(ALLOWED_IMAGE_MIME_TYPES)
            raise ViktorInvalidRequestError(f'Viktor accepts {allowed} images; got "{mime or "unknown"}".')
        if len(url) - url.find(",") - 1 > MAX_IMAGE_BYTES * 4 / 3:
            raise ViktorInvalidRequestError("Image is larger than Viktor's 20 MiB limit.")
        return
    if url.startswith("https://"):
        return
    if url.startswith("http://"):
        raise ViktorInvalidRequestError("Viktor only fetches images over https. Use an https URL or a data URL.")
    raise ViktorInvalidRequestError("Image must be an https URL or a data URL.")


def validate_chat_images(messages: Iterable[Mapping[str, Any]]) -> None:
    """Validate every ``image_url`` part in an OpenAI-shaped message list."""
    count = 0
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, Mapping) or part.get("type") != "image_url":
                continue
            count += 1
            image = part.get("image_url")
            url = image if isinstance(image, str) else (image or {}).get("url")
            if not isinstance(url, str):
                raise ViktorInvalidRequestError("image_url part is missing a url.")
            validate_image_url(url)
    if count > MAX_IMAGES_PER_REQUEST:
        raise ViktorInvalidRequestError(
            f"Viktor accepts at most {MAX_IMAGES_PER_REQUEST} images per request; got {count}. "
            "Extra images would be ignored."
        )
