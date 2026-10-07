import json
from pathlib import Path

import httpx
import pytest

from app.services.lrclib import (
    USER_AGENT,
    LrclibClient,
    LrclibError,
    rank_candidates,
    split_query,
)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def raw():
    return json.loads((FIXTURES / "lrclib_search.json").read_text())


def make_client(handler):
    return LrclibClient(base_url="https://lrclib.test/api", transport=httpx.MockTransport(handler))


@pytest.mark.parametrize(
    "query, expected",
    [
        ("Test Artist - Paper Moon", ("Test Artist", "Paper Moon")),
        ("  A  -  B - C ", ("A", "B - C")),
        ("Paper Moon", None),
        ("a-ha take on me", None),
        (" - Paper Moon", None),
    ],
)
def test_split_query(query, expected):
    assert split_query(query) == expected


def test_rank_synced_first_then_similarity(raw):
    ranked = rank_candidates(raw, "Test Artist - Paper Moon")
    ids = [c.id for c in ranked]
    assert 104 not in ids  # instrumental excluded
    assert ids[0] == 102  # exact title, synced
    assert ids.index(101) < ids.index(103)  # synced remix beats plain-only exact
    assert ids[-1] == 103
    assert ranked[0].score > ranked[1].score


def test_rank_free_text(raw):
    ranked = rank_candidates(raw, "paper moon test artist")
    assert ranked[0].id == 102


def test_candidate_fields(raw):
    c = rank_candidates(raw, "Test Artist - Paper Moon")[0]
    assert c.track_name == "Paper Moon"
    assert c.artist_name == "Test Artist"
    assert c.album_name == "First Album"
    assert c.duration == 214.0
    assert c.has_synced


def test_search_structured_query(raw):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=raw)

    with make_client(handler) as client:
        result = client.search("Test Artist - Paper Moon")
    assert result[0].id == 102
    assert seen[0].url.path == "/api/search"
    assert dict(seen[0].url.params) == {"track_name": "Paper Moon", "artist_name": "Test Artist"}
    assert seen[0].headers["user-agent"] == USER_AGENT


def test_search_structured_falls_back_to_q(raw):
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, json=[] if len(seen) == 1 else raw)

    with make_client(handler) as client:
        result = client.search("Test Artist - Paper Moon")
    assert seen[1] == {"q": "Test Artist Paper Moon"}
    assert result[0].id == 102


def test_search_free_text(raw):
    seen = []

    def handler(request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, json=raw)

    with make_client(handler) as client:
        client.search("paper moon")
    assert seen == [{"q": "paper moon"}]


def test_get_by_id(raw):
    def handler(request):
        assert request.url.path == "/api/get/102"
        return httpx.Response(200, json=raw[1])

    with make_client(handler) as client:
        assert client.get(102).track_name == "Paper Moon"


def test_get_404():
    with make_client(lambda r: httpx.Response(404, json={"message": "nope"})) as client:
        with pytest.raises(LrclibError, match="找不到"):
            client.get(1)


def test_server_error():
    with make_client(lambda r: httpx.Response(500)) as client:
        with pytest.raises(LrclibError, match="500"):
            client.search("x")


def test_timeout():
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    with make_client(handler) as client:
        with pytest.raises(LrclibError, match="逾時"):
            client.search("x")


def test_empty_query_skips_network():
    def handler(request):
        raise AssertionError("should not be called")

    with make_client(handler) as client:
        assert client.search("   ") == []


def test_duration_shorter_than_lyrics_is_demoted():
    def item(id_, duration):
        return {
            "id": id_, "trackName": "Paper Moon", "artistName": "Test Artist", "duration": duration,
            "instrumental": False, "plainLyrics": "line one",
            "syncedLyrics": "[00:10.00]line one\n[03:20.00]last line",
        }

    ranked = rank_candidates([item(1, 170.0), item(2, 214.0), item(3, 200.5)], "Test Artist - Paper Moon")
    assert [c.id for c in ranked] == [2, 3, 1]
    assert [c.duration_ok for c in ranked] == [True, True, False]
