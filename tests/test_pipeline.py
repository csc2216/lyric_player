import pytest

from app.models import LrclibCandidate
from app.services.pipeline import judge_auto, pick_candidate, same_song
from app.services.text import same_name, strip_alias


def cand(id_, artist, track, score=0.9, duration=214.0, synced=True):
    return LrclibCandidate(
        id=id_, artist_name=artist, track_name=track, duration=duration, score=score,
        synced_lyrics="[00:01.00]x" if synced else None, plain_lyrics="x",
    )


@pytest.mark.parametrize(
    "name, expected",
    [("IU (아이유)", "IU"), ("Song [Live]", "Song"), ("(G)I-DLE", "(G)I-DLE"), ("(only)", "(only)"), (" A ", "A")],
)
def test_strip_alias(name, expected):
    assert strip_alias(name) == expected


@pytest.mark.parametrize(
    "a, b, expected",
    [
        ("IU", "IU (아이유)", True),
        ("Through the Night (밤편지)", "Through the Night", True),
        ("Test Artist", "Test Artists", True),
        ("PAPER-MOON", "paper moon", True),
        ("Love", "Love Love Love", False),  # containment alone is not a match
        ("=LOVE", "いらない ツインテール - =LOVE デビュー2周年記念コンサート", False),
        ("Love", "Place Of Love", False),
        ("Paper Moon", "Paper Moon Waltz", False),
        ("", "x", False),
    ],
)
def test_same_name(a, b, expected):
    assert same_name(a, b) is expected


def test_same_song_needs_artist_and_title():
    assert same_song(cand(1, "IU", "밤편지"), cand(2, "IU (아이유)", "밤편지 (Through the Night)"))
    assert not same_song(cand(1, "=LOVE", "=LOVE"), cand(2, "T.Love", "Love Love Love"))
    assert not same_song(cand(1, "IU", "밤편지"), cand(2, "Someone Else", "밤편지"))


def test_ambiguous_query_is_not_one_big_tie():
    # real "love" search: equal scores, all different songs
    cs = [
        cand(1, "=LOVE", "=LOVE", duration=250),
        cand(2, "T.Love", "Love Love Love", duration=202),
        cand(3, "=LOVE", "=LOVE", duration=251),
        cand(4, "LOVE PSYCHEDELICO", "Place Of Love", duration=300),
    ]
    entries = [{"id": "v1", "title": "Love Love Love", "channel": "VIVIZ", "duration": 204.0}]
    pick, tied, _ = pick_candidate(cs, entries, "sync")
    assert [c.id for c in tied] == [1, 3]  # only the duplicate uploads of the top song
    assert pick.id in (1, 3)


def test_reason_lists_lead_once():
    a, b = cand(1, "A", "Song", score=0.9), cand(2, "B", "Other", score=0.88)
    auto_ok, reason, checks = judge_auto(a, [a, b], None, [a], False)
    assert not auto_ok
    assert reason.count("lead") == 1
    assert checks.competitor == "B - Other"


@pytest.mark.parametrize(
    "video, lyrics, expected",
    [
        (217.5, 214.0, 3500),  # video longer -> lyrics start later
        (215.0, 214.0, 1000),  # exactly 1s: applies
        (214.9, 214.0, 0),  # under 1s: ignore
        (210.0, 214.0, 0),  # video shorter: keep 0
        (None, 214.0, 0),
        (214.0, None, 0),
        (253.32 + 0.68, 253.32, 0),  # real 밤편지 case: +0.68s stays 0
    ],
)
def test_default_offset_ms(video, lyrics, expected):
    from app.services.pipeline import default_offset_ms

    assert default_offset_ms(video, lyrics) == expected


def test_non_latin_ratio():
    from app.services.text import non_latin_ratio

    assert non_latin_ratio("첫째 줄") == 1.0
    assert non_latin_ratio("line one") == 0.0
    assert non_latin_ratio("") == 0.0
    assert non_latin_ratio("12 :)") == 0.0
    assert 0.3 < non_latin_ratio("골칫거리 outsider") < 0.5


def test_romanized_upload_never_wins_duration_tie():
    native = cand(1, "Test Artist", "Paper Moon", duration=230.0)
    roman = cand(2, "Test Artist", "Paper Moon", duration=214.0)
    roman.romanized = True
    entries = [{"id": "v1", "title": "Paper Moon", "channel": "Test Artist - Topic", "duration": 214.0}]
    pick, tied, _ = pick_candidate([native, roman], entries, "sync")
    assert pick is native
    assert tied == [native]


def test_romanized_pick_is_manual():
    roman = cand(1, "Test Artist", "Paper Moon")
    roman.romanized = True
    auto_ok, reason, _ = judge_auto(roman, [roman], None, [roman], False)
    assert not auto_ok
    assert "romanized" in reason
