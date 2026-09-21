import json
import logging

import httpx
import pytest
from viktor_integrations_core import (
    AsyncViktorClient,
    ChatStreamResult,
    ViktorAuthError,
    ViktorClient,
    ViktorEmptyReplyError,
    ViktorInvalidRequestError,
    ViktorRateLimitError,
    ViktorRunFailedError,
    adelegate_to_viktor,
    delegate_to_viktor,
    delegate_tool_spec,
    is_routed_tool_id,
    thread_id_from,
)
from viktor_integrations_core.testing import FixtureTransport, fixtures_dir, list_fixtures, load_fixture

ROUTED_ID = "call_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3"


def client(*fixtures: str, **kwargs):
    transport = FixtureTransport(*fixtures)
    c = ViktorClient(
        api_key="zt_test_sk_fixture",
        base_url="https://viktor.test",
        http_client=httpx.Client(transport=transport),
        **kwargs,
    )
    return c, transport


def test_sends_bearer_auth_forces_model_viktor_and_targets_compat_path():
    c, t = client("chat-text")
    res = c.chat_completion(model="gpt-4o", messages=[{"role": "user", "content": "hi"}])
    assert "Viktor" in res["choices"][0]["message"]["content"]
    req = t.requests[0]
    assert req["url"] == "https://viktor.test/api/compat/v1/chat/completions"
    assert req["headers"]["authorization"] == "Bearer zt_test_sk_fixture"
    assert req["body"]["model"] == "viktor"


def test_reads_key_and_base_url_from_environment(monkeypatch):
    monkeypatch.setenv("VIKTOR_API_KEY", "zt_test_sk_env")
    monkeypatch.setenv("VIKTOR_BASE_URL", "https://staging.viktor.test/")
    t = FixtureTransport("chat-text")
    ViktorClient(http_client=httpx.Client(transport=t)).chat_completion(messages=[{"role": "user", "content": "hi"}])
    assert t.requests[0]["url"].startswith("https://staging.viktor.test/api/compat/v1/")
    assert t.requests[0]["headers"]["authorization"] == "Bearer zt_test_sk_env"


def test_missing_key_is_a_clear_error(monkeypatch):
    monkeypatch.delenv("VIKTOR_API_KEY", raising=False)
    with pytest.raises(ViktorInvalidRequestError, match="VIKTOR_API_KEY"):
        ViktorClient(http_client=httpx.Client(transport=FixtureTransport("chat-text"))).chat_completion(messages=[])


def test_stream_text_ignores_keepalives_and_reports_usage():
    c, _ = client("chat-stream-text")
    parts = list(c.chat_completion_stream(messages=[{"role": "user", "content": "hi"}]))
    assert "".join(p for p in parts if isinstance(p, str)) == "Hello from Viktor."
    final = parts[-1]
    assert isinstance(final, ChatStreamResult)
    assert final.finish_reason == "stop" and final.usage["total_tokens"] == 843


def test_stream_assembles_fragmented_tool_call_and_keeps_routed_id():
    c, _ = client("chat-stream-tool-call")
    final = list(c.chat_completion_stream(messages=[{"role": "user", "content": "weather?"}]))[-1]
    assert final.tool_calls[0].id == ROUTED_ID
    assert json.loads(final.tool_calls[0].arguments) == {"city": "Berlin", "units": "metric"}
    assert final.finish_reason == "tool_calls"


def test_in_stream_error_frame_is_run_failed_with_worker_message():
    c, _ = client("chat-stream-run-failed")
    with pytest.raises(ViktorRunFailedError, match="empty response twice"):
        list(c.chat_completion_stream(messages=[{"role": "user", "content": "x"}]))


def test_stream_ended_without_output_warns_or_raises_in_strict_mode(caplog):
    c, _ = client("chat-stream-ended-without-output")
    with caplog.at_level(logging.WARNING, logger="viktor"):
        list(c.chat_completion_stream(messages=[]))
    assert "ended without output" in caplog.text
    strict, _ = client("chat-stream-ended-without-output", strict_empty_reply=True)
    with pytest.raises(ViktorEmptyReplyError):
        list(strict.chat_completion_stream(messages=[]))


def test_502_run_failed():
    c, _ = client("chat-run-failed")
    with pytest.raises(ViktorRunFailedError, match="empty response twice") as exc:
        c.chat_completion(messages=[])
    assert exc.value.status == 502 and exc.value.request_id == "req_fixture_0001"


def test_empty_200_reply_warns_or_raises_in_strict_mode(caplog):
    c, _ = client("chat-empty-reply")
    with caplog.at_level(logging.WARNING, logger="viktor"):
        c.chat_completion(messages=[])
    assert "empty reply" in caplog.text
    strict, _ = client("chat-empty-reply", strict_empty_reply=True)
    with pytest.raises(ViktorEmptyReplyError) as exc:
        strict.chat_completion(messages=[])
    assert exc.value.is_retryable


def test_401_and_403_map_to_auth_error_with_hint():
    c, _ = client("chat-auth-401")
    with pytest.raises(ViktorAuthError, match="VIKTOR_API_KEY") as exc:
        c.chat_completion(messages=[])
    assert exc.value.detail_code == "invalid_api_key"
    c, _ = client("chat-scope-403")
    with pytest.raises(ViktorAuthError) as exc:
        c.chat_completion(messages=[])
    assert exc.value.detail_code == "missing_scope"


def test_429_carries_retry_after():
    c, _ = client("chat-rate-limit")
    with pytest.raises(ViktorRateLimitError) as exc:
        c.chat_completion(messages=[])
    assert exc.value.retry_after_seconds == 17 and exc.value.detail_code == "rate_limit_exceeded"


def test_thread_id_extraction():
    assert thread_id_from(ROUTED_ID) == "zwKTTPTKCc9TVsSMgJuGh"
    assert thread_id_from("toolu_vk1_zwKTTPTKCc9TVsSMgJuGh_t_01HXk3") == "zwKTTPTKCc9TVsSMgJuGh"
    assert thread_id_from("zwKTTPTKCc9TVsSMgJuGh") == "zwKTTPTKCc9TVsSMgJuGh"
    assert thread_id_from("call_abc123") is None and thread_id_from("chatcmpl-fx1") is None
    assert not is_routed_tool_id("call_abc123")


def test_tool_result_followup_keeps_routed_id_and_redeclares_tools():
    fx = load_fixture("chat-tool-result-followup")["request"]["body"]
    c, t = client("chat-tool-result-followup")
    res = c.chat_completion(messages=fx["messages"], tools=fx["tools"])
    assert "sunny" in res["choices"][0]["message"]["content"].lower()
    assert t.requests[0]["body"]["messages"][-1]["tool_call_id"] == ROUTED_ID
    assert len(t.requests[0]["body"]["tools"]) == 1


def test_images_https_and_data_urls_pass_and_bad_ones_fail_before_any_request():
    body = load_fixture("chat-image")["request"]["body"]
    c, t = client("chat-image")
    c.chat_completion(messages=body["messages"])
    assert len(t.requests) == 1

    def img(u):
        return {"type": "image_url", "image_url": {"url": u}}

    c, t = client("chat-text")
    with pytest.raises(ViktorInvalidRequestError, match="https"):
        c.chat_completion(messages=[{"role": "user", "content": [img("http://example.com/a.png")]}])
    with pytest.raises(ViktorInvalidRequestError):
        c.chat_completion(messages=[{"role": "user", "content": [img("data:image/tiff;base64,AAAA")]}])
    with pytest.raises(ViktorInvalidRequestError, match="at most 10"):
        c.chat_completion(messages=[{"role": "user", "content": [img("https://example.com/a.png")] * 11}])
    assert t.requests == []


async def test_async_client_streams_and_maps_errors():
    t = FixtureTransport("chat-stream-tool-call")
    c = AsyncViktorClient(api_key="k", base_url="https://viktor.test", http_client=httpx.AsyncClient(transport=t))
    parts = [p async for p in c.chat_completion_stream(messages=[{"role": "user", "content": "x"}])]
    assert parts[-1].tool_calls[0].id == ROUTED_ID
    t = FixtureTransport("chat-run-failed")
    c = AsyncViktorClient(api_key="k", base_url="https://viktor.test", http_client=httpx.AsyncClient(transport=t))
    with pytest.raises(ViktorRunFailedError):
        await c.chat_completion(messages=[])


class RestScript(httpx.MockTransport):
    def __init__(self, script):
        self.script, self.calls = list(script), []
        super().__init__(self._handle)

    def _handle(self, request):
        key = f"{request.method} {request.url.path}"
        self.calls.append(key)
        for i, (k, status, body) in enumerate(self.script):
            if k == key:
                del self.script[i]
                return httpx.Response(status, json=body)
        raise AssertionError(f"unexpected request {key}")


COMPLETED = [
    (
        "POST /api/public/v1/threads",
        202,
        {"thread": {"id": "thr_1"}, "message": {"id": "m"}, "run": {"id": "run_1", "status": "queued"}},
    ),
    (
        "GET /api/public/v1/runs/run_1",
        200,
        {"id": "run_1", "thread_id": "thr_1", "status": "in_progress", "error": None},
    ),
    ("GET /api/public/v1/runs/run_1", 200, {"id": "run_1", "thread_id": "thr_1", "status": "completed", "error": None}),
    (
        "GET /api/public/v1/runs/run_1/result",
        200,
        {
            "run_id": "run_1",
            "status": "completed",
            "markdown": "Done.",
            "json": None,
            "artifacts": [{"id": "ftok", "display_name": "report.pdf", "content_type": "application/pdf"}],
        },
    ),
    (
        "GET /api/public/v1/files/ftok/download-url",
        200,
        {"run_id": "run_1", "url": "/api/public/v1/files/downloads/signed", "expires_at": "2026-09-20T12:00:00Z"},
    ),
]


def test_delegate_spec_is_shared():
    spec = json.loads((fixtures_dir().parent / "spec" / "delegate-tool.json").read_text())
    assert delegate_tool_spec == spec and spec["name"] == "delegate_to_viktor"


def test_delegate_creates_thread_polls_and_returns_result_with_artifacts():
    t = RestScript(COMPLETED)
    c = ViktorClient(api_key="k", base_url="https://viktor.test", http_client=httpx.Client(transport=t))
    statuses = []
    r = delegate_to_viktor(c, "Write the report", poll_interval=0, on_status=statuses.append)
    assert (r.status, r.markdown, r.thread_id, r.run_id) == ("completed", "Done.", "thr_1", "run_1")
    assert r.artifacts[0]["download_url"] == "https://viktor.test/api/public/v1/files/downloads/signed"
    assert statuses == ["in_progress", "completed"] and "thread_id: thr_1" in r.to_text()


def test_delegate_follow_up_and_requires_action_is_a_result():
    t = RestScript(
        [
            (
                "POST /api/public/v1/threads/thr_1/messages",
                202,
                {"message": {"id": "m2"}, "run": {"id": "run_2", "status": "queued"}},
            ),
            (
                "GET /api/public/v1/runs/run_2",
                200,
                {"id": "run_2", "thread_id": "thr_1", "status": "requires_action", "error": None},
            ),
            (
                "GET /api/public/v1/runs/run_2/result",
                200,
                {
                    "run_id": "run_2",
                    "status": "requires_action",
                    "markdown": "Which quarter?",
                    "json": None,
                    "artifacts": [],
                },
            ),
        ]
    )
    c = ViktorClient(api_key="k", base_url="https://viktor.test", http_client=httpx.Client(transport=t))
    r = delegate_to_viktor(c, "Q3", thread_id="thr_1", poll_interval=0)
    assert r.status == "requires_action" and "needs input" in r.to_text()
    assert t.calls[0] == "POST /api/public/v1/threads/thr_1/messages"


def test_delegate_timeout_returns_run_id_and_does_not_cancel():
    t = RestScript(COMPLETED[:2])
    c = ViktorClient(api_key="k", base_url="https://viktor.test", http_client=httpx.Client(transport=t))
    r = delegate_to_viktor(c, "long", timeout_seconds=0, poll_interval=0)
    assert (r.status, r.run_id) == ("timed_out", "run_1") and not any("cancel" in c for c in t.calls)


async def test_async_delegate():
    t = RestScript(COMPLETED)
    c = AsyncViktorClient(api_key="k", base_url="https://viktor.test", http_client=httpx.AsyncClient(transport=t))
    r = await adelegate_to_viktor(c, "Write the report", poll_interval=0)
    assert r.status == "completed" and r.artifacts[0]["display_name"] == "report.pdf"


def test_fixtures_are_well_formed():
    names = list_fixtures()
    assert len(names) >= 14
    for n in names:
        fx = load_fixture(n)
        assert fx["provenance"] in ("contract", "live")
        assert "body" in fx["response"] or "sse" in fx["response"]


def test_openai_sdk_exceptions_map_to_viktor_errors():
    import httpx2
    import openai
    from viktor_integrations_core import viktor_error_from_exception
    from viktor_integrations_core.testing import make_fixture_transport

    def sdk(name):
        t = make_fixture_transport(httpx2, name)
        return openai.OpenAI(
            api_key="k",
            base_url="https://viktor.test/api/compat/v1",
            max_retries=0,
            http_client=httpx2.Client(transport=t),
        )

    for fixture, cls, code in [
        ("chat-run-failed", ViktorRunFailedError, "run_failed"),
        ("chat-auth-401", ViktorAuthError, "invalid_api_key"),
        ("chat-scope-403", ViktorAuthError, "missing_scope"),
        ("chat-rate-limit", ViktorRateLimitError, "rate_limit_exceeded"),
    ]:
        with pytest.raises(openai.APIStatusError) as exc:
            sdk(fixture).chat.completions.create(model="viktor", messages=[{"role": "user", "content": "x"}])
        mapped = viktor_error_from_exception(exc.value)
        assert isinstance(mapped, cls) and mapped.detail_code == code, fixture
    assert viktor_error_from_exception(ValueError("x")) is None


def test_in_stream_error_from_the_openai_sdk_maps_to_run_failed():
    import httpx2
    import openai
    from viktor_integrations_core import viktor_error_from_exception
    from viktor_integrations_core.testing import make_fixture_transport

    t = make_fixture_transport(httpx2, "chat-stream-run-failed")
    sdk = openai.OpenAI(
        api_key="k", base_url="https://viktor.test/api/compat/v1", max_retries=0, http_client=httpx2.Client(transport=t)
    )
    with pytest.raises(openai.APIError) as exc:
        list(sdk.chat.completions.create(model="viktor", messages=[{"role": "user", "content": "x"}], stream=True))
    mapped = viktor_error_from_exception(exc.value)
    assert isinstance(mapped, ViktorRunFailedError) and "empty response twice" in mapped.message


def test_shared_helpers_for_adapters():
    from viktor_integrations_core import EMPTY_REPLY_MESSAGE, validate_image_urls
    from viktor_integrations_core.testing import DELEGATE_COMPLETED_SCRIPT, make_rest_script

    assert str(ViktorEmptyReplyError()) == EMPTY_REPLY_MESSAGE
    with pytest.raises(ViktorInvalidRequestError, match="at most 10"):
        validate_image_urls(["https://example.com/a.png"] * 11)
    with pytest.raises(ViktorInvalidRequestError, match="https"):
        c, _ = client("chat-text")
        c.chat_completion(
            messages=[{"role": "user", "content": [{"type": "input_image", "image_url": "http://x/a.png"}]}]
        )
    t = make_rest_script(httpx, DELEGATE_COMPLETED_SCRIPT)
    with ViktorClient(api_key="k", base_url="https://viktor.test", http_client=httpx.Client(transport=t)) as c:
        assert delegate_to_viktor(c, "x", poll_interval=0).status == "completed"


def test_base_url_accepts_host_or_full_compat_path():
    from viktor_integrations_core import openai_base_url, resolve_base_url

    for v in [
        "https://api.viktor.com",
        "https://api.viktor.com/",
        "https://api.viktor.com/api/compat",
        "https://api.viktor.com/api/compat/v1/",
    ]:
        assert resolve_base_url(v) == "https://api.viktor.com"
    assert openai_base_url("https://api.viktor.com/api/compat/v1") == "https://api.viktor.com/api/compat/v1"
