import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router
from app.auth import Forbidden, PinRequired, QuotaExceeded
from app.services.library import LibraryError, SongExists, SongNotFound
from app.services.lrclib import LrclibError
from app.services.pipeline import NotFound, PipelineError
from app.services.translator import TranslatorError
from app.services.youtube import YoutubeError

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="Lyric Player")
app.include_router(router)

# Most specific first: the first matching class in this list wins.
ERROR_STATUS: list[tuple[type[Exception], int]] = [
    (PinRequired, 401),
    (Forbidden, 403),
    (QuotaExceeded, 429),
    (SongNotFound, 404),
    (NotFound, 404),
    (SongExists, 409),
    (LibraryError, 400),
    (PipelineError, 400),
    # upstream services (LRCLIB, YouTube, translator) failed
    (LrclibError, 502),
    (YoutubeError, 502),
    (TranslatorError, 502),
]


# Machine-readable codes for errors the frontend reacts to (PIN dialog, guest UI).
ERROR_CODES: dict[type[Exception], str] = {
    PinRequired: "pin_required",
    Forbidden: "forbidden",
    QuotaExceeded: "quota_exceeded",
}


async def handle_known_error(request: Request, exc: Exception) -> JSONResponse:
    status = next(code for cls, code in ERROR_STATUS if isinstance(exc, cls))
    body = {"detail": str(exc)}
    if type(exc) in ERROR_CODES:
        body["code"] = ERROR_CODES[type(exc)]
    return JSONResponse(body, status_code=status)


for cls, _ in ERROR_STATUS:
    app.add_exception_handler(cls, handle_known_error)

log = logging.getLogger("lyric_player")


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    """Anything unplanned still reaches the UI as a readable message (traceback goes to the server log)."""
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        {"detail": f"伺服器內部錯誤（{type(exc).__name__}: {exc}），詳細訊息請看伺服器視窗"},
        status_code=500,
    )

# Mounted last so /api routes take precedence; html=True serves index.html at "/".
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
