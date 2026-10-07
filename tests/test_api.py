"""API tests with LRCLIB, YouTube and the translator replaced by fakes (no network)."""

import json
import re
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.api.routes import get_library
from app.main import app
from app.services import pipeline, translator, youtube
from app.services.library import Library
from app.services.lrclib import LrclibError, rank_candidates

SYNCED = "[00:10.00]line one\n[00:14.00]line two\n[00:20.00]\n[00:30.00]chorus\n[00:40.00]chorus\n[03:30.00]last line"
PLAIN = "line one\nline two\n\nchorus\nchorus\n\nlast line"


def lrclib_item(id_, duration, track="Paper Moon", artist="Test Artist", synced=SYNCED):
    return {
        "id": id_, "trackName": track, "artistName": artist, "albumName": "First Album",
        "duration": duration, "instrumental": False, "plainLyrics": PLAIN, "syncedLyrics": synced,
    }


def yt(id_, duration, title="Paper Moon", channel="Test Artist - Topic"):
    return {"id": id_.ljust(11, "x")[:11], "title": title, "channel": channel, "duration": duration}


class FakeLrclib:
    items: list[dict] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass

    def search(self, query):
        return rank_candidates(self.items, query)

    def get(self, lrclib_id):
        from app.models import LrclibCandidate

        for item in self.items:
            if item["id"] == lrclib_id:
                return LrclibCandidate.from_api(item)
        raise LrclibError(f"找不到 LRCLIB 歌詞（id={lrclib_id}）")


class FakeBackend:
    """Translates every requested line to '譯:<text>'; optional delay to test concurrency."""

    model = "fake"

    def __init__(self, delay=0.0, prefix="譯"):
        self.delay = delay
        self.prefix = prefix
        self.calls = []
        self._lock = threading.Lock()

    def complete(self, system, user_message):
        with self._lock:
            self.calls.append(user_message)
        time.sleep(self.delay)
        items = json.loads(user_message[user_message.index("[") :])
        return json.dumps({"translations": [{"id": i["id"], "tr": f"{self.prefix}:{i['text']}"} for i in items]})


@pytest.fixture
def env(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    app.dependency_overrides[get_library] = lambda: lib
    monkeypatch.setattr(pipeline, "LrclibClient", FakeLrclib)
    monkeypatch.setattr(pipeline.settings, "video_preference", "sync")
    pipeline._video_cache.clear()

    searches = []
    results: dict[str, list[dict]] = {}

    def fake_search(query, count=youtube.SEARCH_COUNT):
        searches.append(query)
        return results.get(query, [])

    monkeypatch.setattr(youtube, "search_entries", fake_search)
    backend = FakeBackend()
    monkeypatch.setattr(translator, "make_backend", lambda name=None: backend)

    class Env:
        pass

    e = Env()
    e.lib, e.client, e.searches, e.yt, e.backend = lib, TestClient(app), searches, results, backend
    e.set_backend = lambda b: monkeypatch.setattr(translator, "make_backend", lambda name=None: b)
    yield e
    app.dependency_overrides.clear()


# ---- resolve ------------------------------------------------------------


def test_resolve_tie_broken_by_duration(env):
    # three duplicate uploads, equal score; only the 253s one matches the video
    FakeLrclib.items = [lrclib_item(1, 250.0), lrclib_item(2, 253.0), lrclib_item(3, 260.0)]
    env.yt["Test Artist Paper Moon"] = [yt("topic", 254.0), yt("other", 300.0, channel="x")]
    res = env.client.post("/api/resolve", json={"query": "Test Artist - Paper Moon"})
    assert res.status_code == 200
    data = res.json()
    assert [c["id"] for c in data["candidates"]] == [2, 1, 3]
    pick = data["candidates"][0]
    assert pick["video"]["video_id"] == "topicxxxxxx"
    assert pick["video"]["duration_diff"] == 1.0
    assert pick["preview"] == ["line one", "line two", "chorus"]
    assert pick["line_count"] == 5
    assert data["auto_ok"] is True
    assert data["reason"].startswith("auto: ")
    assert "tie broken by duration" in data["reason"]
    assert data["checks"]["tie_size"] == 3 and data["checks"]["tie_broken_by_duration"] is True
    assert data["checks"]["competitor"] is None
    assert env.searches == ["Test Artist Paper Moon"]  # no fallback, no extra searches


def test_resolve_manual_when_other_song_is_close(env):
    FakeLrclib.items = [lrclib_item(1, 214.0), lrclib_item(2, 214.0, track="Paper Moons", artist="Test Artists")]
    env.yt["Test Artist Paper Moon"] = [yt("topic", 214.0)]
    data = env.client.post("/api/resolve", json={"query": "Paper Moon"}).json()
    assert data["candidates"][0]["id"] == 1
    # "Paper Moons" by "Test Artists" counts as the same song (names ≥ 0.85 similar)
    assert data["auto_ok"] is True

    FakeLrclib.items = [lrclib_item(1, 214.0), lrclib_item(2, 214.0, track="Paper Moon Waltz", artist="Band")]
    env.yt["Band Paper Moon Waltz"] = [yt("waltz", 214.0)]
    data = env.client.post("/api/resolve", json={"query": "Paper Moon"}).json()
    assert data["auto_ok"] is False
    assert "lead" in data["reason"] and "Band - Paper Moon Waltz" in data["reason"]
    assert data["candidates"][1]["video"]["video_id"] == "waltzxxxxxx"  # separate search for other song


def test_resolve_fallback_search_and_far_video(env):
    FakeLrclib.items = [lrclib_item(1, 214.0)]
    env.yt["Test Artist Paper Moon"] = [yt("far", 250.0)]
    env.yt["我的輸入"] = [yt("stillfar", 240.0)]
    data = env.client.post("/api/resolve", json={"query": "我的輸入"}).json()
    assert env.searches == ["Test Artist Paper Moon", "我的輸入"]
    assert data["checks"]["youtube_fallback"] is True
    assert data["candidates"][0]["video"]["video_id"] == "stillfarxxx"
    assert data["auto_ok"] is False
    assert "video +26s off" in data["reason"]


def test_resolve_plain_only_not_auto(env):
    FakeLrclib.items = [lrclib_item(1, 214.0, synced=None)]
    env.yt["Test Artist Paper Moon"] = [yt("topic", 214.0)]
    data = env.client.post("/api/resolve", json={"query": "Paper Moon"}).json()
    assert data["auto_ok"] is False and "no synced lyrics" in data["reason"]


def test_resolve_no_results(env):
    FakeLrclib.items = []
    data = env.client.post("/api/resolve", json={"query": "nothing"}).json()
    assert data["candidates"] == [] and data["auto_ok"] is False


def test_resolve_youtube_failure_still_returns_lyrics(env, monkeypatch):
    FakeLrclib.items = [lrclib_item(1, 214.0)]

    def broken(query, count=8):
        raise youtube.YoutubeError("YouTube 搜尋失敗：boom")

    monkeypatch.setattr(youtube, "search_entries", broken)
    data = env.client.post("/api/resolve", json={"query": "Paper Moon"}).json()
    assert data["candidates"][0]["video"] is None
    assert "no YouTube video" in data["reason"]


def test_resolve_empty_query_rejected(env):
    assert env.client.post("/api/resolve", json={"query": ""}).status_code == 422


# ---- build --------------------------------------------------------------


def resolve_and_build(env, **kw):
    FakeLrclib.items = [lrclib_item(1, 214.0)]
    env.yt["Test Artist Paper Moon"] = [yt("topic", 214.0), yt("alt1", 220.0, channel="x"), yt("alt2", 230.0)]
    env.client.post("/api/resolve", json={"query": "Paper Moon"})
    return env.client.post("/api/build", json={"lrclib_id": 1, "video_id": "topicxxxxxx", **kw})


def test_build_saves_song(env):
    res = resolve_and_build(env)
    assert res.status_code == 200
    data = res.json()
    assert data["created"] is True
    assert (data["artist_slug"], data["title_slug"]) == ("test-artist", "paper-moon")
    song = data["song"]
    assert song["youtube"]["video_id"] == "topicxxxxxx"
    assert song["youtube"]["channel"] == "Test Artist - Topic"
    assert [a["video_id"] for a in song["youtube"]["alternatives"]] == ["alt1xxxxxxx", "alt2xxxxxxx"]
    assert song["lrclib"] == {"id": 1, "duration": 214.0}
    assert song["synced"] is True
    assert [line["tr"] for line in song["lines"]][:4] == ["譯:line one", "譯:line two", "譯:chorus", "譯:chorus"]
    assert [i for i, line in enumerate(song["lines"]) if line["break_before"]] == [2, 4]
    assert song["translator"]["prompt_version"] == translator.PROMPT_VERSION
    assert (env.lib.root / "test-artist" / "paper-moon.json").is_file()
    assert len(env.backend.calls) == 1
    assert env.client.get("/api/library").json()[0]["songs"][0]["title_slug"] == "paper-moon"


def test_build_existing_returns_without_translating(env):
    resolve_and_build(env)
    again = env.client.post("/api/build", json={"lrclib_id": 1, "video_id": "alt1xxxxxxx"}).json()
    assert again["created"] is False
    assert again["song"]["youtube"]["video_id"] == "topicxxxxxx"
    assert len(env.backend.calls) == 1


def test_build_force_rebuilds(env):
    resolve_and_build(env)
    res = env.client.post("/api/build", json={"lrclib_id": 1, "video_id": "alt1xxxxxxx", "force": True}).json()
    assert res["created"] is True
    assert res["song"]["youtube"]["video_id"] == "alt1xxxxxxx"
    assert len(env.backend.calls) == 2


def test_concurrent_builds_translate_once(env):
    slow = FakeBackend(delay=0.5)
    env.set_backend(slow)
    FakeLrclib.items = [lrclib_item(1, 214.0)]
    env.yt["Test Artist Paper Moon"] = [yt("topic", 214.0)]
    results = []

    def go():
        res = env.client.post("/api/build", json={"lrclib_id": 1, "video_id": "topicxxxxxx"})
        results.append(res.json())

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(slow.calls) == 1
    assert sorted(r["created"] for r in results) == [False, True]
    assert results[0]["song"] == results[1]["song"]


def test_concurrent_force_builds_translate_once(env):
    resolve_and_build(env)
    slow = FakeBackend(delay=0.5)
    env.set_backend(slow)
    threads = [
        threading.Thread(
            target=lambda: env.client.post(
                "/api/build", json={"lrclib_id": 1, "video_id": "topicxxxxxx", "force": True}
            )
        )
        for _ in range(2)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(slow.calls) == 1


def test_build_without_resolve_searches_again(env):
    FakeLrclib.items = [lrclib_item(1, 214.0)]
    env.yt["Test Artist Paper Moon"] = [yt("topic", 214.0)]
    res = env.client.post("/api/build", json={"lrclib_id": 1, "video_id": "topicxxxxxx"}).json()
    assert res["song"]["youtube"]["channel"] == "Test Artist - Topic"


def test_build_unknown_video_kept_with_minimal_info(env):
    FakeLrclib.items = [lrclib_item(1, 214.0)]
    res = env.client.post("/api/build", json={"lrclib_id": 1, "video_id": "ABCDEFGHIJK"}).json()
    assert res["song"]["youtube"]["video_id"] == "ABCDEFGHIJK"


def test_build_errors(env):
    FakeLrclib.items = [lrclib_item(1, 214.0)]
    assert env.client.post("/api/build", json={"lrclib_id": 1, "video_id": "bad"}).status_code == 400
    res = env.client.post("/api/build", json={"lrclib_id": 999, "video_id": "ABCDEFGHIJK"})
    assert res.status_code == 404 and "999" in res.json()["detail"]


def test_build_translator_failure_saves_nothing(env):
    class Broken:
        model = "x"

        def complete(self, system, user_message):
            raise translator.TranslatorError("claude CLI 逾時（120 秒）")

    env.set_backend(Broken())
    FakeLrclib.items = [lrclib_item(1, 214.0)]
    res = env.client.post("/api/build", json={"lrclib_id": 1, "video_id": "ABCDEFGHIJK"})
    assert res.status_code == 502
    assert res.json()["detail"] == "claude CLI 逾時（120 秒）"
    assert env.client.get("/api/library").json() == []


# ---- song endpoints -------------------------------------------------------


@pytest.fixture
def built(env):
    resolve_and_build(env)
    return env


def test_get_song(built):
    data = built.client.get("/api/songs/test-artist/paper-moon").json()
    assert data["song"]["title"] == "Paper Moon"
    assert built.client.get("/api/songs/test-artist/nope").status_code == 404
    assert built.client.get("/api/songs/..%2F..%2Fetc/passwd").status_code == 404


def test_patch_offset_and_lines(built):
    res = built.client.patch(
        "/api/songs/test-artist/paper-moon",
        json={"offset_ms": -300, "lines": [{"index": 0, "tr": "改過的翻譯"}, {"index": 1, "t": None}]},
    )
    assert res.status_code == 200
    song = built.lib.get_song("test-artist", "paper-moon")
    assert song.offset_ms == -300
    assert song.lines[0].tr == "改過的翻譯" and song.lines[0].t == 10.0
    assert song.lines[1].t is None and song.lines[1].tr == "譯:line two"
    assert song.lines[2].t == 30.0  # untouched


def test_patch_line_t_and_synced(built):
    built.client.patch(
        "/api/songs/test-artist/paper-moon", json={"synced": False, "lines": [{"index": 2, "t": 31.5}]}
    )
    song = built.lib.get_song("test-artist", "paper-moon")
    assert song.synced is False and song.lines[2].t == 31.5


def test_patch_bad_line_index(built):
    res = built.client.patch("/api/songs/test-artist/paper-moon", json={"lines": [{"index": 99, "tr": "x"}]})
    assert res.status_code == 400


def test_patch_video_switch(built):
    built.client.patch("/api/songs/test-artist/paper-moon", json={"video_id": "alt2xxxxxxx"})
    yt_info = built.lib.get_song("test-artist", "paper-moon").youtube
    assert yt_info.video_id == "alt2xxxxxxx" and yt_info.duration == 230.0
    assert [a.video_id for a in yt_info.alternatives] == ["topicxxxxxx", "alt1xxxxxxx"]


def test_patch_rename_moves_file(built):
    res = built.client.patch(
        "/api/songs/test-artist/paper-moon", json={"artist": "New Name", "offset_ms": 100}
    ).json()
    assert (res["artist_slug"], res["title_slug"]) == ("new-name", "paper-moon")
    assert built.lib.get_song("new-name", "paper-moon").offset_ms == 100
    assert not (built.lib.root / "test-artist").exists()


def test_patch_rename_conflict(built):
    FakeLrclib.items.append(lrclib_item(2, 200.0, track="Other"))
    built.client.post("/api/build", json={"lrclib_id": 2, "video_id": "ABCDEFGHIJK"})
    res = built.client.patch("/api/songs/test-artist/other", json={"title": "Paper Moon"})
    assert res.status_code == 409


def test_retranslate_single_line(built):
    new = FakeBackend(prefix="新")
    built.set_backend(new)
    res = built.client.post("/api/songs/test-artist/paper-moon/retranslate", json={"line_indices": [1]})
    assert res.status_code == 200
    lines = res.json()["song"]["lines"]
    assert lines[1]["tr"] == "新:line two"
    assert lines[0]["tr"] == "譯:line one"
    payload = new.calls[0][new.calls[0].index("[") :]
    assert [i["text"] for i in json.loads(payload)] == ["line two"]


def test_retranslate_all(built):
    built.set_backend(FakeBackend(prefix="新"))
    res = built.client.post("/api/songs/test-artist/paper-moon/retranslate")
    assert all(line["tr"].startswith("新:") for line in res.json()["song"]["lines"])


def test_retranslate_bad_index(built):
    res = built.client.post("/api/songs/test-artist/paper-moon/retranslate", json={"line_indices": [-1]})
    assert res.status_code == 400


def test_delete(built):
    assert built.client.delete("/api/songs/test-artist/paper-moon").status_code == 204
    assert built.client.get("/api/library").json() == []
    assert built.client.delete("/api/songs/test-artist/paper-moon").status_code == 404


def test_api_never_exposes_api_key(built, monkeypatch):
    monkeypatch.setattr(pipeline.settings, "anthropic_api_key", "sk-secret-value")
    body = built.client.get("/api/songs/test-artist/paper-moon").text
    assert "sk-secret" not in body
    assert not re.search(r"api_key", body)


def test_build_alias_artist_goes_into_existing_folder(built):
    FakeLrclib.items.append(lrclib_item(2, 200.0, track="Other", artist="Test Artist (테스트)"))
    res = built.client.post("/api/build", json={"lrclib_id": 2, "video_id": "ABCDEFGHIJK"}).json()
    assert (res["artist_slug"], res["title_slug"]) == ("test-artist", "other")
    assert res["song"]["artist"] == "Test Artist"
    tree = built.client.get("/api/library").json()
    assert [s["title"] for s in tree[0]["songs"]] == ["Other", "Paper Moon"]


def test_patch_rename_into_existing_folder_adopts_name(built):
    FakeLrclib.items.append(lrclib_item(2, 200.0, track="Other", artist="Someone"))
    built.client.post("/api/build", json={"lrclib_id": 2, "video_id": "ABCDEFGHIJK"})
    res = built.client.patch("/api/songs/someone/other", json={"artist": "Test Artist (테스트)", "offset_ms": 50})
    data = res.json()
    assert (data["artist_slug"], data["song"]["artist"]) == ("test-artist", "Test Artist")
    assert built.lib.get_song("test-artist", "other").offset_ms == 50
