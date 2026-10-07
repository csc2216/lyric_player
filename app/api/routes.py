"""HTTP routes.

All handlers are plain `def`: the work underneath (LRCLIB via sync httpx,
yt-dlp, `claude -p` via subprocess.run, file IO) is blocking, and FastAPI runs
sync handlers in its threadpool, so a multi-second translation never blocks
the event loop or other requests.
"""

from fastapi import APIRouter, Depends, Response

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


@router.get("/library")
def get_library_tree(lib: Library = Depends(get_library)) -> list[dict]:
    return lib.list_tree()


@router.get("/songs/{artist_slug}/{title_slug}")
def get_song(artist_slug: str, title_slug: str, lib: Library = Depends(get_library)) -> SongResponse:
    song = lib.get_song(artist_slug, title_slug)
    return pipeline.song_response(song)


@router.post("/resolve")
def resolve(body: ResolveRequest) -> ResolveResponse:
    return pipeline.resolve(body.query)


@router.post("/build")
def build(body: BuildRequest, lib: Library = Depends(get_library)) -> SongResponse:
    return pipeline.build(lib, body.lrclib_id, body.video_id, force=body.force)


@router.patch("/songs/{artist_slug}/{title_slug}")
def patch_song(
    artist_slug: str, title_slug: str, body: SongPatch, lib: Library = Depends(get_library)
) -> SongResponse:
    return pipeline.patch_song(lib, artist_slug, title_slug, body)


@router.post("/songs/{artist_slug}/{title_slug}/retranslate")
def retranslate(
    artist_slug: str,
    title_slug: str,
    body: RetranslateRequest | None = None,
    lib: Library = Depends(get_library),
) -> SongResponse:
    indices = body.line_indices if body else None
    return pipeline.retranslate(lib, artist_slug, title_slug, indices)


@router.delete("/songs/{artist_slug}/{title_slug}", status_code=204)
def delete_song(artist_slug: str, title_slug: str, lib: Library = Depends(get_library)) -> Response:
    lib.delete_song(artist_slug, title_slug)
    return Response(status_code=204)
