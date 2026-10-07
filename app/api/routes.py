"""HTTP routes.

All handlers are plain `def`: the work underneath (LRCLIB via sync httpx,
yt-dlp, `claude -p` via subprocess.run, file IO) is blocking, and FastAPI runs
sync handlers in its threadpool, so a multi-second translation never blocks
the event loop or other requests.
"""

import time

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from app import auth
from app.auth import Forbidden, Identity
from app.config import settings
from app.models import (
    BuildRequest,
    ResolveRequest,
    ResolveResponse,
    RetranslateRequest,
    SongPatch,
    SongResponse,
)
from app.services import pipeline
from app.services.library import Library

router = APIRouter(prefix="/api")


def get_library() -> Library:
    return Library(settings.library_dir)


def get_guest_store() -> auth.GuestStore:
    return auth.guest_store()


def viewer(request: Request, store: auth.GuestStore = Depends(get_guest_store)) -> Identity:
    """Anyone allowed in: owner or an identified visitor."""
    return auth.identify(request, store)


def owner(who: Identity = Depends(viewer)) -> Identity:
    if not who.is_owner:
        raise Forbidden("訪客不能修改伺服器上的歌曲（刪除、改名、重翻、換影片、改 offset 或翻譯）；你的修改只會存在這台裝置")
    return who


# ---- identity -----------------------------------------------------------------


class PinRequest(BaseModel):
    pin: str


@router.get("/me")
def me(request: Request, store: auth.GuestStore = Depends(get_guest_store)) -> dict:
    """Role and limits for the UI. Never fails: tells the client when a PIN is needed.

    `headers` lists the identity/proxy headers that reached the server, to check
    whether tailscale serve passes Tailscale-User-Login for a given device.
    """
    info: dict = {"headers": auth.identity_headers(request), "daily_limit": settings.guest_daily_builds}
    if auth.LOGIN_HEADER in request.headers and auth.tailscale_login(request) is None:
        info["note"] = (
            "收到 Tailscale-User-Login，但連線不是來自本機的 tailscale serve，身分被忽略"
            "（伺服器要用 uvicorn --no-proxy-headers 啟動）"
        )
    try:
        who = auth.identify(request, store)
    except auth.PinRequired:
        return info | {"role": None, "needs_pin": True}
    except Forbidden as e:
        return info | {"role": None, "needs_pin": False, "error": str(e)}
    info |= {"role": who.role, "via": who.via, "login": who.login, "needs_pin": False}
    if not who.is_owner:
        info["builds_left"] = max(0, settings.guest_daily_builds - store.builds_today(who.key))
    return info


@router.post("/auth/pin")
def submit_pin(
    body: PinRequest, request: Request, response: Response, store: auth.GuestStore = Depends(get_guest_store)
) -> dict:
    if not auth.check_pin(body.pin):
        time.sleep(1)  # slow down guessing
        raise auth.PinRequired("PIN 不正確")
    token = store.new_session()
    https = request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https"
    response.set_cookie(
        auth.COOKIE_NAME, token, max_age=auth.COOKIE_MAX_AGE, httponly=True, samesite="lax", secure=https
    )
    return {"ok": True}


# ---- library ------------------------------------------------------------------


@router.get("/library")
def get_library_tree(lib: Library = Depends(get_library), _: Identity = Depends(viewer)) -> list[dict]:
    return lib.list_tree()


@router.get("/songs/{artist_slug}/{title_slug}")
def get_song(
    artist_slug: str, title_slug: str, lib: Library = Depends(get_library), _: Identity = Depends(viewer)
) -> SongResponse:
    song = lib.get_song(artist_slug, title_slug)
    return pipeline.song_response(song)


@router.post("/resolve")
def resolve(body: ResolveRequest, _: Identity = Depends(viewer)) -> ResolveResponse:
    return pipeline.resolve(body.query)


@router.post("/build")
def build(
    body: BuildRequest,
    lib: Library = Depends(get_library),
    who: Identity = Depends(viewer),
    store: auth.GuestStore = Depends(get_guest_store),
) -> SongResponse:
    if who.is_owner:
        return pipeline.build(lib, body.lrclib_id, body.video_id, force=body.force)
    if body.force:
        raise Forbidden("訪客不能重新建立已存在的歌")
    # Visitors spend the owner's translation quota: count (only) songs actually created.
    store.reserve_build(who.key, settings.guest_daily_builds)
    created = False
    try:
        res = pipeline.build(lib, body.lrclib_id, body.video_id)
        created = bool(res.created)
        return res
    finally:
        if not created:
            store.release_build(who.key)


@router.patch("/songs/{artist_slug}/{title_slug}")
def patch_song(
    artist_slug: str,
    title_slug: str,
    body: SongPatch,
    lib: Library = Depends(get_library),
    _: Identity = Depends(owner),
) -> SongResponse:
    return pipeline.patch_song(lib, artist_slug, title_slug, body)


@router.post("/songs/{artist_slug}/{title_slug}/retranslate")
def retranslate(
    artist_slug: str,
    title_slug: str,
    body: RetranslateRequest | None = None,
    lib: Library = Depends(get_library),
    _: Identity = Depends(owner),
) -> SongResponse:
    indices = body.line_indices if body else None
    return pipeline.retranslate(lib, artist_slug, title_slug, indices)


@router.delete("/songs/{artist_slug}/{title_slug}", status_code=204)
def delete_song(
    artist_slug: str, title_slug: str, lib: Library = Depends(get_library), _: Identity = Depends(owner)
) -> Response:
    lib.delete_song(artist_slug, title_slug)
    return Response(status_code=204)
