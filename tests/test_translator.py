from types import SimpleNamespace

import anthropic
import httpx
import pytest

from app.services import translator
from app.services.translator import (
    ApiBackend,
    ClaudeCliBackend,
    TranslatorError,
    make_backend,
    dedupe,
    parse_response,
    strip_fence,
    translate,
)


class FakeClient:
    """Mimics anthropic.Anthropic().messages.create, replaying canned replies."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []
        self.messages = self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=reply)])


def user_text(call):
    return call["messages"][0]["content"]


def reply(pairs):
    import json

    return json.dumps({"translations": [{"id": i, "tr": t} for i, t in pairs]}, ensure_ascii=False)


# ---- parsing --------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        '{"translations": [{"id": 0, "tr": "一"}]}',
        '```json\n{"translations": [{"id": 0, "tr": "一"}]}\n```',
        '```\n{"translations": [{"id": 0, "tr": "一"}]}\n```',
        '  ```JSON\n{"translations": [{"id": 0, "tr": "一"}]}```  ',
        'Here you go:\n{"translations": [{"id": 0, "tr": "一"}]}\nDone.',
    ],
)
def test_parse_variants(raw):
    assert parse_response(raw) == {0: "一"}


def test_strip_fence_leaves_plain_text():
    assert strip_fence('{"a": 1}') == '{"a": 1}'


@pytest.mark.parametrize(
    "raw",
    ["", "not json", "[]", '{"translations": "nope"}', '{"other": []}', "```json\n{broken\n```"],
)
def test_parse_garbage_returns_empty(raw):
    assert parse_response(raw) == {}


def test_parse_skips_bad_items():
    raw = '{"translations": [{"id": "1", "tr": "ok"}, {"id": "x", "tr": "bad"}, {"tr": "no id"}, {"id": 2, "tr": "  "}, {"id": 3}, "junk"]}'
    assert parse_response(raw) == {1: "ok"}


# ---- dedupe ---------------------------------------------------------------


def test_dedupe():
    texts = ["line one", "chorus", "line two", "chorus ", "chorus"]
    unique, id_of_line = dedupe(texts, list(range(5)))
    assert unique == ["line one", "chorus", "line two"]
    assert id_of_line == {0: 0, 1: 1, 2: 2, 3: 1, 4: 1}


def test_dedupe_subset():
    unique, id_of_line = dedupe(["a", "b", "a", "c"], [2, 3])
    assert unique == ["a", "c"]
    assert id_of_line == {2: 0, 3: 1}


# ---- translate ------------------------------------------------------------

TEXTS = ["line one", "chorus", "第二行", "chorus", "ooh"]


def test_translate_dedupes_and_expands():
    client = FakeClient(reply([(0, "第一行"), (1, "副歌"), (2, "second line"), (3, "ooh")]))
    result = translate(TEXTS, backend=ApiBackend(client, model="m"))
    assert result.translations == {0: "第一行", 1: "副歌", 2: "second line", 3: "副歌", 4: "ooh"}
    assert result.missing == []
    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["model"] == "m"
    assert call["system"] == translator.SYSTEM_PROMPT
    msg = user_text(call)
    # full lyrics for context (with the repeat), but "chorus" listed once with an id
    assert "line one\nchorus\n第二行\nchorus\nooh" in msg
    assert msg.count('"text": "chorus"') == 1
    assert '"id": 3' in msg and '"id": 4' not in msg


def test_translate_handles_fenced_reply():
    client = FakeClient("```json\n" + reply([(0, "一"), (1, "二"), (2, "三"), (3, "四")]) + "\n```")
    assert translate(TEXTS, backend=ApiBackend(client, model="m")).missing == []


def test_missing_ids_retried_once_with_only_missing():
    client = FakeClient(
        reply([(0, "第一行"), (2, "second line")]),
        reply([(1, "副歌"), (3, "ooh")]),
    )
    result = translate(TEXTS, backend=ApiBackend(client, model="m"))
    assert result.missing == []
    assert result.translations[3] == "副歌"
    assert len(client.calls) == 2
    retry_msg = user_text(client.calls[1])
    assert '"id": 1' in retry_msg and '"id": 3' in retry_msg
    assert '"id": 0' not in retry_msg and '"id": 2' not in retry_msg
    assert "line one" in retry_msg  # full context still included


def test_still_missing_after_retry_left_empty_and_reported():
    client = FakeClient(
        reply([(0, "第一行"), (2, "second line"), (3, "ooh")]),
        reply([(99, "ignored unknown id")]),
    )
    result = translate(TEXTS, backend=ApiBackend(client, model="m"))
    assert len(client.calls) == 2
    assert result.translations[1] == "" and result.translations[3] == ""
    assert result.missing == [1, 3]  # both chorus occurrences reported


def test_unparseable_reply_retries_everything():
    client = FakeClient("sorry, I can't", reply([(0, "一"), (1, "二"), (2, "三"), (3, "四")]))
    result = translate(TEXTS, backend=ApiBackend(client, model="m"))
    assert result.missing == []
    assert len(client.calls) == 2


def test_retry_does_not_overwrite_earlier_answers():
    client = FakeClient(reply([(0, "第一行")]), reply([(0, "different"), (1, "二"), (2, "三"), (3, "四")]))
    assert translate(TEXTS, backend=ApiBackend(client, model="m")).translations[0] == "第一行"


def test_translate_subset_of_lines():
    client = FakeClient(reply([(0, "副歌")]))
    result = translate(TEXTS, line_indices=[1, 3], backend=ApiBackend(client, model="m"))
    assert result.translations == {1: "副歌", 3: "副歌"}
    assert "line one" in user_text(client.calls[0])


def test_translate_nothing_makes_no_call():
    client = FakeClient()
    assert translate(TEXTS, line_indices=[], backend=ApiBackend(client, model="m")).translations == {}
    assert client.calls == []


def test_api_error_becomes_translator_error():
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    client = FakeClient(anthropic.APIConnectionError(request=request))
    with pytest.raises(TranslatorError, match="翻譯 API"):
        translate(TEXTS, backend=ApiBackend(client, model="m"))


def test_timeout_error_message():
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    client = FakeClient(anthropic.APITimeoutError(request=request))
    with pytest.raises(TranslatorError, match="逾時"):
        translate(TEXTS, backend=ApiBackend(client, model="m"))


def test_missing_api_key(monkeypatch):
    monkeypatch.setattr(translator.settings, "anthropic_api_key", "")
    with pytest.raises(TranslatorError, match="ANTHROPIC_API_KEY"):
        translate(TEXTS, backend=ApiBackend(model="m"))


# ---- claude_cli backend ---------------------------------------------------


class FakeRun:
    """Stands in for subprocess.run; replays canned (stdout, returncode) or exceptions."""

    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        stdout, code = out if isinstance(out, tuple) else (out, 0)
        return SimpleNamespace(stdout=stdout, stderr="", returncode=code)


def cli_result(text, is_error=False):
    import json

    return json.dumps({"type": "result", "is_error": is_error, "result": text})


@pytest.fixture
def fake_cli(monkeypatch):
    def install(*outputs):
        run = FakeRun(*outputs)
        monkeypatch.setattr(translator.subprocess, "run", run)
        monkeypatch.setattr(translator.shutil, "which", lambda name: f"/usr/bin/{name}")
        return run

    return install


def test_cli_translate_end_to_end(fake_cli, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("SOME_OTHER_VAR", "kept")
    run = fake_cli(cli_result("```json\n" + reply([(0, "一"), (1, "二"), (2, "三"), (3, "四")]) + "\n```"))
    result = translate(TEXTS, backend=ClaudeCliBackend(model="m"))
    assert result.missing == [] and result.translations[3] == "二"

    cmd, kwargs = run.calls[0]
    assert cmd[0] == "/usr/bin/claude"
    assert cmd[1:5] == ["-p", "--output-format", "json", "--model"] and cmd[5] == "m"
    assert cmd[cmd.index("--system-prompt") + 1] == translator.SYSTEM_PROMPT
    assert cmd[cmd.index("--tools") + 1] == ""
    assert "ANTHROPIC_API_KEY" not in kwargs["env"]
    assert kwargs["env"]["SOME_OTHER_VAR"] == "kept"
    assert kwargs["timeout"] == 120
    assert "line one" in kwargs["input"]  # user message goes via stdin


def test_cli_shares_retry_logic(fake_cli):
    run = fake_cli(cli_result(reply([(0, "一"), (2, "三")])), cli_result(reply([(1, "二")])))
    result = translate(TEXTS, backend=ClaudeCliBackend(model="m"))
    assert len(run.calls) == 2
    assert '"id": 3' in run.calls[1][1]["input"] and '"id": 0' not in run.calls[1][1]["input"]
    assert result.missing == [4]  # "ooh" (id 3) never answered


def test_cli_not_installed(monkeypatch):
    monkeypatch.setattr(translator.shutil, "which", lambda name: None)
    with pytest.raises(TranslatorError, match="找不到 claude 指令"):
        translate(TEXTS, backend=ClaudeCliBackend(model="m"))


def test_cli_timeout(fake_cli):
    fake_cli(translator.subprocess.TimeoutExpired(cmd="claude", timeout=120))
    with pytest.raises(TranslatorError, match="逾時（120 秒）"):
        translate(TEXTS, backend=ClaudeCliBackend(model="m"))


def test_cli_reports_error_result(fake_cli):
    fake_cli((cli_result("There's an issue with the selected model", is_error=True), 1))
    with pytest.raises(TranslatorError, match="selected model"):
        translate(TEXTS, backend=ClaudeCliBackend(model="m"))


def test_cli_unparseable_output(fake_cli):
    fake_cli(("not json at all", 1))
    with pytest.raises(TranslatorError, match="無法解析"):
        translate(TEXTS, backend=ClaudeCliBackend(model="m"))


@pytest.mark.parametrize("name, cls", [("claude_cli", ClaudeCliBackend), ("api", ApiBackend)])
def test_make_backend(name, cls):
    assert isinstance(make_backend(name), cls)


def test_make_backend_default_is_cli(monkeypatch):
    monkeypatch.setattr(translator.settings, "translator_backend", "claude_cli")
    assert isinstance(make_backend(), ClaudeCliBackend)


def test_make_backend_unknown():
    with pytest.raises(TranslatorError, match="TRANSLATOR_BACKEND"):
        make_backend("nope")
