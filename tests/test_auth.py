"""Who gets which permissions: local owner, Tailscale owner/visitors, PIN visitors."""

import pytest
from fastapi.testclient import TestClient

from app import auth
from app.api.routes import get_library
from app.main import app
from app.services import pipeline, translator, youtube
from app.services.library import Library
from tests.test_api import FakeBackend, FakeLrclib, lrclib_item, yt

SERVE_HOST = "https://mybox.tail1234.ts.net"  # serve is HTTPS (Secure cookie)
# what tailscale serve adds when it relays a request (it connects from 127.0.0.1)
SERVE = {"X-Forwarded-For": "100.101.102.103", "X-Forwarded-Proto": "https"}


@pytest.fixture
def env(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    app.dependency_overrides[get_library] = lambda: lib
    monkeypatch.setattr(auth.settings, "data_dir", tmp_path / "data")
    monkeypatch.setattr(auth.settings, "owner_login", "Owner@Example.com")
    monkeypatch.setattr(auth.settings, "guest_pin", "2468")
    monkeypatch.setattr(auth.settings, "guest_daily_builds", 2)
    monkeypatch.setattr(pipeline, "LrclibClient", FakeLrclib)
    monkeypatch.setattr(pipeline.settings, "video_preference", "sync")
    monkeypatch.setattr(youtube, "search_entries", lambda q, count=8: [yt("topic", 214.0)])
    backend = FakeBackend()
    monkeypatch.setattr(translator, "make_backend", lambda name=None: backend)
    pipeline._video_cache.clear()
    FakeLrclib.items = [lrclib_item(i, 214.0, track=f"Song {i}") for i in range(1, 6)]
    yield lib
    app.dependency_overrides.clear()


def local():
    return TestClient(app, base_url="http://localhost:8765")


def via_serve(login=None, **kw):
    headers = dict(SERVE)
    if login:
        headers["Tailscale-User-Login"] = login
    return TestClient(app, base_url=SERVE_HOST, headers=headers, **kw)


def build(client, n):
    return client.post("/api/build", json={"lrclib_id": n, "video_id": "topicxxxxxx"})


# ---- identity -------------------------------------------------------------------


def test_direct_local_is_owner(env):
    me = local().get("/api/me").json()
    assert (me["role"], me["via"], me["needs_pin"]) == ("owner", "local", False)
    assert me["headers"] == {}
    assert local().get("/api/library").status_code == 200


@pytest.mark.parametrize("host", ["http://localhost", "http://127.0.0.1:8765", "http://[::1]:8765"])
def test_local_host_variants(env, host):
    assert TestClient(app, base_url=host).get("/api/me").json()["role"] == "owner"


def test_owner_login_via_serve_case_insensitive(env):
    me = via_serve("owner@example.COM").get("/api/me").json()
    assert (me["role"], me["via"], me["login"]) == ("owner", "tailscale", "owner@example.COM")
    assert me["headers"]["tailscale-user-login"] == "owner@example.COM"


def test_other_login_via_serve_is_guest(env):
    me = via_serve("roommate@example.com").get("/api/me").json()
    assert (me["role"], me["via"]) == ("guest", "tailscale")
    assert me["builds_left"] == 2


def test_serve_without_identity_needs_pin(env):
    """The important case: serve connects from loopback, but this must not count as local."""
    client = via_serve()
    me = client.get("/api/me").json()
    assert (me["role"], me["needs_pin"]) == (None, True)
    res = client.get("/api/library")
    assert res.status_code == 401
    assert res.json()["code"] == "pin_required"


@pytest.mark.parametrize(
    "base, headers",
    [
        ("http://localhost:8765", {"X-Forwarded-For": "100.1.2.3"}),  # proxy header
        ("http://localhost:8765", {"Forwarded": "for=100.1.2.3"}),
        ("http://localhost:8765", {"Tailscale-User-Name": "Someone"}),  # any Tailscale header
        (SERVE_HOST, {}),  # tailnet host name, even without proxy headers
    ],
)
def test_relayed_requests_are_not_local(env, base, headers):
    assert TestClient(app, base_url=base, headers=headers).get("/api/me").json()["role"] is None


def test_identity_header_ignored_from_non_loopback_peer(env):
    """A LAN client can't claim to be the owner by sending the header itself."""
    client = TestClient(
        app,
        base_url="http://localhost:8765",
        headers={"Tailscale-User-Login": "owner@example.com"},
        client=("192.168.1.50", 50000),
    )
    me = client.get("/api/me").json()
    assert me["role"] is None and me["needs_pin"] is True


def test_no_guest_pin_means_no_anonymous_visitors(env, monkeypatch):
    monkeypatch.setattr(auth.settings, "guest_pin", "")
    me = via_serve().get("/api/me").json()
    assert me["role"] is None and me["needs_pin"] is False and "GUEST_PIN" in me["error"]
    res = via_serve().get("/api/library")
    assert res.status_code == 403 and res.json()["code"] == "forbidden"


def test_pin_flow(env):
    client = via_serve()
    bad = client.post("/api/auth/pin", json={"pin": "0000"})
    assert bad.status_code == 401 and bad.json()["detail"] == "PIN 不正確"
    ok = client.post("/api/auth/pin", json={"pin": " 2468 "})
    assert ok.status_code == 200
    cookie = ok.headers["set-cookie"]
    assert "lp_guest=" in cookie and "HttpOnly" in cookie and "Secure" in cookie  # serve is https
    me = client.get("/api/me").json()
    assert (me["role"], me["via"]) == ("guest", "pin")
    assert client.get("/api/library").status_code == 200
    # a made-up cookie doesn't work
    other = via_serve()
    other.cookies.set("lp_guest", "made-up")
    assert other.get("/api/library").status_code == 401


# ---- what visitors may do -------------------------------------------------------


@pytest.fixture
def guest(env):
    local_client = local()
    assert build(local_client, 1).json()["created"] is True  # a song on the server
    return via_serve("roommate@example.com")


def test_guest_can_browse_play_and_resolve(guest):
    assert guest.get("/api/library").json()[0]["songs"][0]["title"] == "Song 1"
    assert guest.get("/api/songs/test-artist/song-1").status_code == 200
    assert guest.post("/api/resolve", json={"query": "Song 2"}).status_code == 200


@pytest.mark.parametrize(
    "method, path, body",
    [
        ("PATCH", "/api/songs/test-artist/song-1", {"offset_ms": 300}),
        ("PATCH", "/api/songs/test-artist/song-1", {"lines": [{"index": 0, "tr": "x"}]}),
        ("PATCH", "/api/songs/test-artist/song-1", {"title": "Renamed"}),
        ("PATCH", "/api/songs/test-artist/song-1", {"video_id": "ABCDEFGHIJK"}),
        ("POST", "/api/songs/test-artist/song-1/retranslate", {}),
        ("DELETE", "/api/songs/test-artist/song-1", None),
    ],
)
def test_guest_cannot_modify_server_songs(guest, env, method, path, body):
    res = guest.request(method, path, json=body)
    assert res.status_code == 403
    assert res.json()["code"] == "forbidden"
    assert env.get_song("test-artist", "song-1").offset_ms == 0


def test_guest_cannot_force_rebuild(guest):
    res = guest.post("/api/build", json={"lrclib_id": 1, "video_id": "topicxxxxxx", "force": True})
    assert res.status_code == 403


def test_guest_daily_build_limit(guest, env):
    assert build(guest, 2).json()["created"] is True
    # opening an existing song through build doesn't count
    assert build(guest, 1).json()["created"] is False
    assert guest.get("/api/me").json()["builds_left"] == 1
    assert build(guest, 3).json()["created"] is True
    res = build(guest, 4)
    assert res.status_code == 429
    assert res.json()["code"] == "quota_exceeded"
    assert "每天 2 首" in res.json()["detail"]
    assert guest.get("/api/me").json()["builds_left"] == 0
    # limits are per visitor, and the owner has none
    assert build(via_serve("other@example.com"), 4).json()["created"] is True
    assert build(local(), 5).json()["created"] is True


def test_failed_guest_build_does_not_use_quota(guest, monkeypatch):
    class Broken:
        model = "x"

        def complete(self, system, user_message):
            raise translator.TranslatorError("claude CLI 逾時（120 秒）")

    monkeypatch.setattr(translator, "make_backend", lambda name=None: Broken())
    assert build(guest, 2).status_code == 502
    assert guest.get("/api/me").json()["builds_left"] == 2


def test_quota_counter_keeps_only_today(env, tmp_path):
    store = auth.GuestStore(tmp_path / "g.json")
    store.reserve_build("k", 5)
    data = store._load()
    data["builds"]["k"]["2020-01-01"] = 99  # stale day
    store._save(data)
    store.reserve_build("k", 5)
    assert list(store._load()["builds"]["k"].values()) == [2]


def test_launch_scripts_disable_uvicorn_proxy_headers():
    """Without it uvicorn swaps serve's 127.0.0.1 for the X-Forwarded-For address and identities are lost."""
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    for script in ("run.sh", "scripts/serve_windows.sh"):
        assert "--no-proxy-headers" in (root / script).read_text(), script


def test_me_explains_ignored_identity(env):
    client = TestClient(
        app, base_url=SERVE_HOST, headers={"Tailscale-User-Login": "x@y.z"}, client=("100.64.0.9", 1)
    )
    assert "--no-proxy-headers" in client.get("/api/me").json()["note"]


def test_server_listens_on_loopback_only():
    """Windows reaches WSL via localhost forwarding and tailscale serve relays from 127.0.0.1;
    binding 0.0.0.0 would let tailnet / LAN devices bypass serve (and the PIN/identity rules)."""
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    for script in ("run.sh", "scripts/serve_windows.sh", "start-lyric-player.bat"):
        text = (root / script).read_text(encoding="utf-8")
        assert "0.0.0.0" not in text, script
    for script in ("run.sh", "scripts/serve_windows.sh"):
        text = (root / script).read_text(encoding="utf-8")
        assert "uvicorn app.main:app --host 127.0.0.1 " in text, script
