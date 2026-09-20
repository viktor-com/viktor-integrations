"""LangChain standard unit tests (offline)."""

from __future__ import annotations

from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_tests.unit_tests import ChatModelUnitTests
from langchain_viktor import ChatViktor


class TestChatViktorStandard(ChatModelUnitTests):
    @property
    def chat_model_class(self) -> type[BaseChatModel]:
        return ChatViktor

    @property
    def chat_model_params(self) -> dict[str, Any]:
        return {"api_key": "zt_test_sk_fixture"}

    @property
    def supports_image_inputs(self) -> bool:
        return True

    @property
    def supports_image_urls(self) -> bool:
        return True

    @property
    def init_from_env_params(self) -> tuple[dict[str, str], dict[str, Any], dict[str, Any]]:
        return (
            {"VIKTOR_API_KEY": "zt_test_sk_env", "VIKTOR_BASE_URL": "https://staging.viktor.test"},
            {},
            {"viktor_api_key": "zt_test_sk_env", "viktor_api_base": "https://staging.viktor.test"},
        )
