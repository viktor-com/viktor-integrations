"""LIVE CONTRACT TEST against the real Viktor API. Runs only when VIKTOR_API_KEY is set. Budget: 3 run creations."""

import pytest
from viktor_integrations_core import ChatStreamResult, ViktorAuthError, ViktorClient, is_routed_tool_id
from viktor_integrations_core.testing import LIVE_SKIP_MESSAGE, has_live_key

pytestmark = [pytest.mark.live, pytest.mark.skipif(not has_live_key(), reason=LIVE_SKIP_MESSAGE)]

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_secret_number",
            "description": "Returns the secret number. Always call it when asked for the secret number.",
            "parameters": {"type": "object", "properties": {}},
        },
    }
]


@pytest.fixture(scope="module")
def client():
    return ViktorClient(strict_empty_reply=True)


def test_lists_exactly_the_viktor_model(client):
    assert [m["id"] for m in client.list_models()] == ["viktor"]


def test_plain_prompt(client):
    res = client.chat_completion(messages=[{"role": "user", "content": "Reply with the single word: pong"}])
    assert res["model"] == "viktor" and "pong" in res["choices"][0]["message"]["content"].lower()


def test_stream_tool_call_with_routed_id_then_resume(client):
    messages = [{"role": "user", "content": "Call get_secret_number, then reply with only that number."}]
    final = list(client.chat_completion_stream(messages=messages, tools=TOOLS, tool_choice="required"))[-1]
    assert isinstance(final, ChatStreamResult) and final.finish_reason == "tool_calls"
    call = final.tool_calls[0]
    assert is_routed_tool_id(call.id), call.id
    messages += [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments or "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": call.id, "content": "4217"},
    ]
    res = client.chat_completion(messages=messages, tools=TOOLS)
    assert "4217" in res["choices"][0]["message"]["content"]


def test_bad_key_is_auth_error():
    with pytest.raises(ViktorAuthError) as exc:
        ViktorClient(api_key="zt_live_sk_00000000000000000000000000000000_invalid").list_models()
    assert exc.value.detail_code == "invalid_api_key"
