import json
from pathlib import Path

import pytest

from app.services import youtube
from app.services.youtube import rank_videos, score_video

FIXTURES = Path(__file__).parent / "fixtures"
ARTIST, TITLE, DURATION = "Test Artist", "Paper Moon", 214.0


@pytest.fixture
def entries():
    return json.loads((FIXTURES / "ytsearch.json").read_text())["entries"]


def entry(**kw):
    base = {"id": "x", "title": "Paper Moon", "channel": "Someone", "duration": DURATION}
    return base | kw


def score(e, preference="sync"):
    return score_video(e, ARTIST, TITLE, DURATION, preference)


def test_sync_prefers_closest_duration_topic(entries):
    ranked = rank_videos(entries, ARTIST, TITLE, DURATION)
    assert ranked[0].video.video_id == "topicBBBBBB"
    assert ranked[0].video.channel == "Test Artist - Topic"
    assert ranked[0].video.duration == 215.0


def test_live_streams_are_skipped(entries):
    ids = [s.video.video_id for s in rank_videos(entries, ARTIST, TITLE, DURATION)]
    assert "liveGGGGGGG" not in ids
    assert len(ids) == 7


def test_mv_preference_prefers_official_mv(entries):
    ranked = rank_videos(entries, ARTIST, TITLE, DURATION, preference="mv")
    assert ranked[0].video.video_id == "mvAAAAAAAAA"


def test_duration_within_3s_is_full_bonus():
    assert score(entry(duration=DURATION + 3)) == score(entry(duration=DURATION - 2))


def test_duration_penalty_grows_with_difference():
    s = [score(entry(duration=DURATION + d)) for d in (0, 5, 10, 30)]
    assert s == sorted(s, reverse=True)
    assert s[0] > s[1] > s[2] > s[3]


def test_missing_duration_is_neutral():
    assert score(entry(duration=None)) < score(entry())
    assert score_video(entry(), ARTIST, TITLE, None) == score(entry(duration=None))


@pytest.mark.parametrize(
    "bad_title",
    [
        "Paper Moon (Cover)",
        "Paper Moon Dance Practice",
        "Paper Moon LIVE",
        "Paper Moon [Lyrics]",
        "Paper Moon lyric video",
        "Paper Moon sped up",
        "Paper Moon REACTION",
    ],
)
def test_bad_keywords_penalized(bad_title):
    assert score(entry(title=bad_title)) < score(entry())


def test_live_is_word_bounded():
    assert score(entry(title="Paper Moon Alive")) == score(entry(title="Paper Moon"))
    assert score(entry(title="Paper Moon Alive")) > score(entry(title="Paper Moon Live"))


def test_keyword_in_song_name_not_penalized():
    a = score_video(entry(title="Live Forever"), ARTIST, "Live Forever", DURATION)
    b = score_video(entry(title="Live Forever (official audio)"), ARTIST, "Live Forever", DURATION)
    assert a == b


def test_title_and_channel_bonuses():
    plain = score(entry(title="unrelated", channel="Someone"))
    assert score(entry(title="Paper Moon", channel="Someone")) > plain
    assert score(entry(title="unrelated", channel="Test Artist")) > plain
    assert score(entry(title="unrelated", channel="Whoever - Topic")) > plain
    assert score(entry(title="unrelated", channel="WhoeverVEVO")) > plain


def test_title_match_ignores_case_and_punctuation():
    assert score(entry(title="PAPER-MOON!")) == score(entry(title="paper moon"))


def test_cjk_titles():
    s1 = score_video(entry(title="아이유 - 밤편지", channel="아이유 - Topic"), "아이유", "밤편지", DURATION)
    s2 = score_video(entry(title="다른 노래", channel="누군가"), "아이유", "밤편지", DURATION)
    assert s1 > s2


def test_find_videos_uses_search_and_limits(monkeypatch, entries):
    calls = []

    def fake_search(query, count=youtube.SEARCH_COUNT):
        calls.append(query)
        return entries

    monkeypatch.setattr(youtube, "search_entries", fake_search)
    result = youtube.find_videos(ARTIST, TITLE, DURATION, fallback_query="my input")
    assert calls == [f"{ARTIST} {TITLE}"]  # best is 1s off -> no fallback search
    assert len(result) == youtube.MAX_ALTERNATIVES
    assert result[0].video.video_id == "topicBBBBBB"


def fallback_search(monkeypatch, first, second):
    calls = []

    def fake_search(query, count=youtube.SEARCH_COUNT):
        calls.append(query)
        return first if len(calls) == 1 else second

    monkeypatch.setattr(youtube, "search_entries", fake_search)
    return calls


def test_fallback_search_when_best_is_far_off(monkeypatch):
    far = [entry(id="far", duration=DURATION + 30)]
    close = [entry(id="close", duration=DURATION + 1), entry(id="far", duration=DURATION + 30)]
    calls = fallback_search(monkeypatch, far, close)
    result = youtube.find_videos(ARTIST, TITLE, DURATION, fallback_query="原始輸入")
    assert calls == [f"{ARTIST} {TITLE}", "原始輸入"]
    assert [s.video.video_id for s in result] == ["close", "far"]  # merged, deduped


def test_fallback_keeps_first_search_if_better(monkeypatch):
    first = [entry(id="ok", duration=DURATION + 6)]
    calls = fallback_search(monkeypatch, first, [entry(id="worse", title="x", duration=DURATION + 40)])
    result = youtube.find_videos(ARTIST, TITLE, DURATION, fallback_query="原始輸入")
    assert len(calls) == 2
    assert result[0].video.video_id == "ok"


def test_fallback_at_exactly_5s_not_triggered(monkeypatch):
    calls = fallback_search(monkeypatch, [entry(id="a", duration=DURATION - 5)], [])
    youtube.find_videos(ARTIST, TITLE, DURATION, fallback_query="原始輸入")
    assert len(calls) == 1


def test_fallback_when_first_search_empty(monkeypatch):
    calls = fallback_search(monkeypatch, [], [entry(id="b")])
    result = youtube.find_videos(ARTIST, TITLE, DURATION, fallback_query="原始輸入")
    assert len(calls) == 2 and result[0].video.video_id == "b"


def test_no_fallback_without_query(monkeypatch):
    calls = fallback_search(monkeypatch, [entry(id="far", duration=DURATION + 30)], [])
    youtube.find_videos(ARTIST, TITLE, DURATION)
    assert len(calls) == 1


def test_no_fallback_when_query_identical(monkeypatch):
    calls = fallback_search(monkeypatch, [entry(id="far", duration=DURATION + 30)], [])
    youtube.find_videos(ARTIST, TITLE, DURATION, fallback_query=f" {ARTIST} {TITLE} ")
    assert len(calls) == 1
