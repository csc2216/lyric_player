from types import SimpleNamespace

import anthropic
import httpx
import pytest

from app.services import translator
from app.services.translator import (
    TranslatorError,
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
    result = translate(TEXTS, client=client, model="m")
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
    assert translate(TEXTS, client=client, model="m").missing == []


def test_missing_ids_retried_once_with_only_missing():
    client = FakeClient(
        reply([(0, "第一行"), (2, "second line")]),
        reply([(1, "副歌"), (3, "ooh")]),
    )
    result = translate(TEXTS, client=client, model="m")
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
    result = translate(TEXTS, client=client, model="m")
    assert len(client.calls) == 2
    assert result.translations[1] == "" and result.translations[3] == ""
    assert result.missing == [1, 3]  # both chorus occurrences reported


def test_unparseable_reply_retries_everything():
    client = FakeClient("sorry, I can't", reply([(0, "一"), (1, "二"), (2, "三"), (3, "四")]))
    result = translate(TEXTS, client=client, model="m")
    assert result.missing == []
    assert len(client.calls) == 2


def test_retry_does_not_overwrite_earlier_answers():
    client = FakeClient(reply([(0, "第一行")]), reply([(0, "different"), (1, "二"), (2, "三"), (3, "四")]))
    assert translate(TEXTS, client=client, model="m").translations[0] == "第一行"


def test_translate_subset_of_lines():
    client = FakeClient(reply([(0, "副歌")]))
    result = translate(TEXTS, line_indices=[1, 3], client=client, model="m")
    assert result.translations == {1: "副歌", 3: "副歌"}
    assert "line one" in user_text(client.calls[0])


def test_translate_nothing_makes_no_call():
    client = FakeClient()
    assert translate(TEXTS, line_indices=[], client=client).translations == {}
    assert client.calls == []


def test_api_error_becomes_translator_error():
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    client = FakeClient(anthropic.APIConnectionError(request=request))
    with pytest.raises(TranslatorError, match="翻譯 API"):
        translate(TEXTS, client=client, model="m")


def test_timeout_error_message():
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    client = FakeClient(anthropic.APITimeoutError(request=request))
    with pytest.raises(TranslatorError, match="逾時"):
        translate(TEXTS, client=client, model="m")


def test_missing_api_key(monkeypatch):
    monkeypatch.setattr(translator.settings, "anthropic_api_key", "")
    with pytest.raises(TranslatorError, match="ANTHROPIC_API_KEY"):
        translate(TEXTS, model="m")
