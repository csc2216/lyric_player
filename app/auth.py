"""Who is making a request: the owner or a visitor.

Requests reach the server in two ways:
- directly on this machine (browser on Windows/WSL -> http://localhost:8765): owner
- through `tailscale serve` (HTTPS on the tailnet). serve proxies from 127.0.0.1
  and adds identity headers (Tailscale-User-Login, ...) for tailnet users.
  Because serve also connects from loopback, "loopback" alone must NOT mean owner:
  a direct-local request additionally needs a localhost Host header and no
  proxy / Tailscale headers.

Identity headers are trusted only when the TCP peer is loopback (i.e. they came
from serve or another local process), never from a LAN / tailnet client that
connects to the port directly.

The server must run with `uvicorn --no-proxy-headers`: by default uvicorn
replaces the loopback peer with the X-Forwarded-For address that serve adds,
and identities would be ignored (visitors would all be asked for the PIN).
Trusting Tailscale IP ranges instead is NOT safe: tailnet devices can reach
the port directly and send any header they like.

Visitors without a Tailscale identity (e.g. if a shared device's requests carry
no identity header) unlock access with GUEST_PIN; a random session token is then
kept in a cookie.
"""

import json
import secrets
import threading
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Literal

from fastapi import Request

from app.config import settings

COOKIE_NAME = "lp_guest"
COOKIE_MAX_AGE = 365 * 24 * 3600
LOGIN_HEADER = "tailscale-user-login"
TAILSCALE_HEADERS = ("tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic")
PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}


class AuthError(Exception):
    """Base for access problems (mapped to 401/403/429 in main.py)."""


class PinRequired(AuthError):
    pass


class Forbidden(AuthError):
    pass


class QuotaExceeded(AuthError):
    pass


@dataclass(frozen=True)
class Identity:
    role: Literal["owner", "guest"]
    via: Literal["local", "tailscale", "pin"]
    login: str | None = None
    # stable per visitor; used for the daily build counter
    key: str | None = None

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"


def _is_loopback(host: str | None) -> bool:
    # "testclient" is what Starlette's TestClient reports; no real socket peer has that name.
    return bool(host) and (host.startswith("127.") or host in ("::1", "testclient"))


def _host_without_port(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):
        return host[: host.find("]") + 1]
    return host.rsplit(":", 1)[0] if ":" in host else host


def is_direct_local(request: Request) -> bool:
    """A request made on this machine, not relayed by tailscale serve or another proxy."""
    peer = request.client.host if request.client else None
    if not _is_loopback(peer):
        return False
    headers = request.headers
    if any(h in headers for h in PROXY_HEADERS + TAILSCALE_HEADERS):
        return False
    return _host_without_port(headers.get("host", "")) in LOCAL_HOSTS


def tailscale_login(request: Request) -> str | None:
    """Tailscale-User-Login, only if it can have come from tailscale serve (loopback peer)."""
    peer = request.client.host if request.client else None
    if not _is_loopback(peer):
        return None
    login = request.headers.get(LOGIN_HEADER, "").strip()
    return login or None


def identity_headers(request: Request) -> dict[str, str]:
    """Which identity / proxy headers arrived (shown by /api/me for troubleshooting)."""
    return {h: request.headers[h] for h in TAILSCALE_HEADERS + PROXY_HEADERS if h in request.headers}


class GuestStore:
    """Visitor sessions (PIN) and per-day build counters, in data_dir/guests.json."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        data.setdefault("sessions", {})
        data.setdefault("builds", {})
        return data

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def new_session(self) -> str:
        token = secrets.token_urlsafe(24)
        with self._lock:
            data = self._load()
            data["sessions"][token] = {"created_at": datetime.now().isoformat(timespec="seconds")}
            self._save(data)
        return token

    def has_session(self, token: str) -> bool:
        with self._lock:
            return token in self._load()["sessions"]

    def builds_today(self, key: str) -> int:
        with self._lock:
            return self._load()["builds"].get(key, {}).get(date.today().isoformat(), 0)

    def reserve_build(self, key: str, limit: int) -> None:
        """Count one build now (so concurrent builds can't exceed the limit); release() undoes it."""
        today = date.today().isoformat()
        with self._lock:
            data = self._load()
            per_day = data["builds"].setdefault(key, {})
            if per_day.get(today, 0) >= limit:
                raise QuotaExceeded(f"今天建立新歌的次數已用完（每天 {limit} 首），明天再來，或請主人幫忙建立")
            # keep only today's counter
            data["builds"][key] = {today: per_day.get(today, 0) + 1}
            self._save(data)

    def release_build(self, key: str) -> None:
        today = date.today().isoformat()
        with self._lock:
            data = self._load()
            count = data["builds"].get(key, {}).get(today, 0)
            if count > 0:
                data["builds"][key] = {today: count - 1}
                self._save(data)


def guest_store() -> GuestStore:
    return GuestStore(settings.data_dir / "guests.json")


def identify(request: Request, store: GuestStore | None = None) -> Identity:
    """Identity for this request; raises PinRequired / Forbidden when a visitor must unlock first."""
    if is_direct_local(request):
        return Identity(role="owner", via="local")
    login = tailscale_login(request)
    if login:
        if settings.owner_login and login.lower() == settings.owner_login.strip().lower():
            return Identity(role="owner", via="tailscale", login=login)
        return Identity(role="guest", via="tailscale", login=login, key=f"ts:{login.lower()}")
    token = request.cookies.get(COOKIE_NAME)
    store = store or guest_store()
    if token and store.has_session(token):
        return Identity(role="guest", via="pin", key=f"pin:{token[:12]}")
    if settings.guest_pin:
        raise PinRequired("請輸入訪客 PIN")
    raise Forbidden("這台伺服器沒有開放訪客使用（主人尚未設定 GUEST_PIN）")


def check_pin(pin: str) -> bool:
    return bool(settings.guest_pin) and secrets.compare_digest(pin.strip(), settings.guest_pin.strip())
