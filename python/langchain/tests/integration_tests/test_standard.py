"""LangChain standard integration tests against the real Viktor API. Each test is a billed Viktor run."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_tests.integration_tests import ChatModelIntegrationTests
from langchain_viktor import ChatViktor
from viktor_integrations_core.testing import LIVE_SKIP_MESSAGE, has_live_key

pytestmark = [pytest.mark.live, pytest.mark.skipif(not has_live_key(), reason=LIVE_SKIP_MESSAGE)]


class TestChatViktorIntegration(ChatModelIntegrationTests):
    @property
    def chat_model_class(self) -> type[BaseChatModel]:
        return ChatViktor

    @property
    def chat_model_params(self) -> dict[str, Any]:
        return {}

    @property
    def supports_image_inputs(self) -> bool:
        return True

    @property
    def supports_image_urls(self) -> bool:
        return True

    @property
    def has_tool_choice(self) -> bool:
        return True

    @property
    def supports_json_mode(self) -> bool:
        return True
