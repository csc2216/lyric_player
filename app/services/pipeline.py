"""Resolve / build / edit flows behind the API routes.

Everything here is synchronous (httpx sync client, yt-dlp, `claude -p` via
subprocess.run); routes are plain `def` so FastAPI runs them in its threadpool.
"""

import re
import threading
from collections import OrderedDict
from collections.abc import Callable
from contextlib import contextmanager

from app.config import settings
from app.models import (
    LrclibCandidate,
    LrclibRef,
    ResolveCandidate,
    ResolveChecks,
    ResolveResponse,
    Song,
    SongPatch,
    SongResponse,
    TranslatorInfo,
    VideoMatch,
    YoutubeInfo,
    YoutubeVideo,
)
from app.services import translator, youtube
from app.services.library import Library, song_slugs
from app.services.lrc_parser import build_lines
from app.services.lrclib import LrclibClient, LrclibError
from app.services.text import same_name
from app.services.youtube import ScoredVideo

# LRCLIB candidates within this score of the top one are treated as tied;
# the tie is broken by which one's duration best matches a YouTube video.
TIE_SCORE_MARGIN = 0.02
# auto_ok: the pick must lead the best *different* song by at least this much...
AUTO_LEAD_MARGIN = 0.1
# ...and its video must be within this many seconds of the LRCLIB duration.
AUTO_MAX_VIDEO_DIFF = 3.0
MAX_CANDIDATES = 8
# Extra YouTube searches for candidates that are different songs.
MAX_EXTRA_SEARCHES = 2
PREVIEW_LINES = 3
# A video at least this much longer than the lyrics likely has a longer intro:
# start with offset = the difference.
AUTO_OFFSET_MIN_DIFF = 1.0
VIDEO_CACHE_SIZE = 200
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class PipelineError(Exception):
    """Bad request from the client (maps to HTTP 400)."""


class NotFound(PipelineError):
    pass


LrclibFactory = Callable[[], LrclibClient]


# ---- per-song locks ---------------------------------------------------------

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


@contextmanager
def song_lock(key: str):
    """Serialize work on one song. Yields True if we had to wait for another holder."""
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    waited = not lock.acquire(blocking=False)
    if waited:
        lock.acquire()
    try:
        yield waited
    finally:
        lock.release()


# ---- video cache (resolve -> build) ---------------------------------------

# lrclib_id -> ranked videos from the last resolve, so build can fill in
# video metadata and alternatives without searching again.
_video_cache: "OrderedDict[int, list[ScoredVideo]]" = OrderedDict()


def _cache_videos(lrclib_id: int, ranked: list[ScoredVideo]) -> None:
    _video_cache[lrclib_id] = ranked
    _video_cache.move_to_end(lrclib_id)
    while len(_video_cache) > VIDEO_CACHE_SIZE:
        _video_cache.popitem(last=False)


# ---- resolve ------------------------------------------------------------


def same_song(a: LrclibCandidate, b: LrclibCandidate) -> bool:
    """Versions/duplicate uploads of one song (aliases like "(아이유)" ignored)."""
    return same_name(a.track_name, b.track_name) and same_name(a.artist_name, b.artist_name)


def _video_match(scored: ScoredVideo, target: float | None) -> VideoMatch:
    v = scored.video
    diff = round(v.duration - target, 2) if v.duration is not None and target is not None else None
    return VideoMatch(**v.model_dump(), score=scored.score, duration_diff=diff)


def _to_resolve_candidate(c: LrclibCandidate, ranked: list[ScoredVideo]) -> ResolveCandidate:
    lines = build_lines(c.synced_lyrics, c.plain_lyrics).lines
    return ResolveCandidate(
        id=c.id,
        track_name=c.track_name,
        artist_name=c.artist_name,
        album_name=c.album_name,
        duration=c.duration,
        synced=c.has_synced,
        duration_ok=c.duration_ok,
        romanized=c.romanized,
        score=c.score,
        line_count=len(lines),
        preview=[line.text for line in lines[:PREVIEW_LINES]],
        video=_video_match(ranked[0], c.duration) if ranked else None,
    )


def pick_candidate(
    candidates: list[LrclibCandidate], entries: list[dict], preference: youtube.VideoPreference
) -> tuple[LrclibCandidate, list[LrclibCandidate], dict[int, list[ScoredVideo]]]:
    """Among duplicate uploads tied with the top one, pick the one whose best video scores highest.

    Returns (pick, tied, ranked videos per tied candidate id). Pure function.
    """
    top = candidates[0]
    tied = [
        c
        for c in candidates
        if (c.has_synced, c.romanized, c.duration_ok) == (top.has_synced, top.romanized, top.duration_ok)
        and c.score >= top.score - TIE_SCORE_MARGIN
        and same_song(c, top)  # different songs can tie on score; never swap to one
    ]
    ranked = {
        c.id: youtube.rank_videos(entries, c.artist_name, c.track_name, c.duration, preference) for c in tied
    }
    # max() keeps the first (LRCLIB-ranked) candidate on equal video scores
    pick = max(tied, key=lambda c: ranked[c.id][0].score if ranked[c.id] else float("-inf"))
    return pick, tied, ranked


def judge_auto(
    pick: LrclibCandidate,
    candidates: list[LrclibCandidate],
    video: VideoMatch | None,
    tied: list[LrclibCandidate],
    youtube_fallback: bool,
) -> tuple[bool, str, ResolveChecks]:
    """auto_ok + a human-readable reason. Pure function."""
    competitor = next((c for c in candidates if not same_song(c, pick)), None)
    lead = round(pick.score - competitor.score, 4) if competitor else None
    video_diff = video.duration_diff if video else None
    tie_broken = len(tied) > 1 and pick is not tied[0]
    checks = ResolveChecks(
        synced=pick.has_synced,
        lead=lead,
        competitor=f"{competitor.artist_name} - {competitor.track_name}" if competitor else None,
        video_diff=video_diff,
        tie_size=len(tied),
        tie_broken_by_duration=tie_broken,
        youtube_fallback=youtube_fallback,
    )

    problems = []
    if not pick.has_synced:
        problems.append("no synced lyrics")
    if pick.romanized:
        problems.append("lyrics are romanized")
    if lead is not None and lead < AUTO_LEAD_MARGIN:
        problems.append(f"lead {lead:.2f} over '{checks.competitor}' < {AUTO_LEAD_MARGIN}")
    if video is None:
        problems.append("no YouTube video found")
    elif video_diff is None:
        problems.append("video duration unknown")
    elif abs(video_diff) > AUTO_MAX_VIDEO_DIFF:
        problems.append(f"video {video_diff:+.0f}s off (> {AUTO_MAX_VIDEO_DIFF:.0f}s)")

    notes = []
    if competitor is None:
        notes.append(f"all {len(candidates)} results are the same song")
    elif lead >= AUTO_LEAD_MARGIN:
        notes.append(f"lead {lead:.2f} over '{checks.competitor}'")
    if tie_broken:
        picked = f"{pick.duration:.0f}s" if pick.duration is not None else "?"
        notes.append(f"tie broken by duration ({len(tied)} tied, picked {picked})")
    elif len(tied) > 1:
        notes.append(f"{len(tied)} tied, first already best by duration")
    if video_diff is not None:
        notes.append(f"video {video_diff:+.1f}s")
    if youtube_fallback:
        notes.append("YouTube fallback search used")

    auto_ok = not problems
    reason = ("auto: " if auto_ok else "manual: " + "; ".join(problems) + " | ") + "; ".join(notes)
    return auto_ok, reason, checks


def resolve(query: str, lrclib_factory: LrclibFactory | None = None) -> ResolveResponse:
    query = query.strip()
    if not query:
        raise PipelineError("請輸入歌名")
    with (lrclib_factory or LrclibClient)() as client:
        candidates = client.search(query)
    if not candidates:
        return ResolveResponse(query=query, auto_ok=False, reason="manual: no lyrics found on LRCLIB", candidates=[])
    candidates = candidates[:MAX_CANDIDATES]
    pref = settings.video_preference
    top = candidates[0]

    # One search covers the top song (and its duplicate uploads).
    try:
        entries = youtube.search_entries(f"{top.artist_name} {top.track_name}")
    except youtube.YoutubeError:
        entries = []  # still return lyrics candidates; auto_ok will be false
    pick, tied, ranked = pick_candidate(candidates, entries, pref)
    youtube_fallback = False
    if youtube.needs_fallback(ranked[pick.id], pick.duration) and query != f"{top.artist_name} {top.track_name}":
        try:
            entries = youtube.merge_entries(entries, youtube.search_entries(query))
            pick, tied, ranked = pick_candidate(candidates, entries, pref)
            youtube_fallback = True
        except youtube.YoutubeError:
            pass

    # Best video for every other candidate: reuse the search for versions of
    # the same song, search separately (capped) for different songs.
    searches: dict[str, list[dict]] = {}
    extra = 0
    for c in candidates:
        if c.id in ranked:
            continue
        if same_song(c, pick):
            c_entries = entries
        else:
            key = f"{c.artist_name} {c.track_name}"
            if key not in searches and extra < MAX_EXTRA_SEARCHES:
                extra += 1
                try:
                    searches[key] = youtube.search_entries(key)
                except youtube.YoutubeError:
                    searches[key] = []
            c_entries = searches.get(key, [])
        ranked[c.id] = youtube.rank_videos(c_entries, c.artist_name, c.track_name, c.duration, pref)

    for c in candidates:
        _cache_videos(c.id, ranked[c.id][: youtube.MAX_ALTERNATIVES])

    ordered = [pick] + [c for c in candidates if c is not pick]
    results = [_to_resolve_candidate(c, ranked[c.id]) for c in ordered]
    auto_ok, reason, checks = judge_auto(pick, candidates, results[0].video, tied, youtube_fallback)
    return ResolveResponse(query=query, auto_ok=auto_ok, reason=reason, checks=checks, candidates=results)


# ---- build --------------------------------------------------------------


def song_response(song: Song, **extra) -> SongResponse:
    artist_slug, title_slug = song_slugs(song)
    return SongResponse(artist_slug=artist_slug, title_slug=title_slug, song=song, **extra)


def _youtube_info(video_id: str, ranked: list[ScoredVideo]) -> YoutubeInfo:
    videos = [s.video for s in ranked]
    chosen = next((v for v in videos if v.video_id == video_id), YoutubeVideo(video_id=video_id))
    alternatives = [v for v in videos if v.video_id != video_id][: youtube.MAX_ALTERNATIVES]
    return YoutubeInfo(**chosen.model_dump(), alternatives=alternatives)


def default_offset_ms(video_duration: float | None, lyrics_duration: float | None) -> int:
    """Initial offset for a new song: the duration difference when the video is
    longer by >= AUTO_OFFSET_MIN_DIFF seconds, else 0. Pure function.

    (Mirrored by estimateOffsetMs in static/js/util.js.)
    """
    if video_duration is None or lyrics_duration is None:
        return 0
    diff = video_duration - lyrics_duration
    return round(diff * 1000) if diff >= AUTO_OFFSET_MIN_DIFF else 0


def _validate_video_id(video_id: str) -> None:
    if not _VIDEO_ID_RE.match(video_id):
        raise PipelineError(f"無效的 YouTube video id：{video_id}")


def build(
    lib: Library,
    lrclib_id: int,
    video_id: str,
    force: bool = False,
    lrclib_factory: LrclibFactory | None = None,
    backend: translator.Backend | None = None,
) -> SongResponse:
    _validate_video_id(video_id)
    with (lrclib_factory or LrclibClient)() as client:
        try:
            c = client.get(lrclib_id)
        except LrclibError as e:
            if "找不到" in str(e):
                raise NotFound(str(e)) from e
            raise
    if c.instrumental:
        raise PipelineError("這是純音樂，沒有歌詞")

    key = str(lib.path_for(Song(artist=c.artist_name, title=c.track_name)))
    with song_lock(key) as waited:
        existing = lib.find_existing(c.artist_name, c.track_name)
        # A concurrent build of the same song just finished: reuse it even if
        # force=true, so a double click never translates twice.
        if existing and (waited or not force):
            return song_response(existing, created=False)

        lyrics = build_lines(c.synced_lyrics, c.plain_lyrics)
        if not lyrics.lines:
            raise PipelineError("這首歌在 LRCLIB 上沒有歌詞內容")
        result = translator.translate([line.text for line in lyrics.lines], backend=backend)
        for i, line in enumerate(lyrics.lines):
            line.tr = result.translations.get(i, "")

        ranked = _video_cache.get(lrclib_id)
        if ranked is None or not any(s.video.video_id == video_id for s in ranked):
            # Cache miss (e.g. server restarted since resolve): search again.
            try:
                ranked = youtube.find_videos(c.artist_name, c.track_name, c.duration, settings.video_preference)
            except youtube.YoutubeError:
                ranked = []

        youtube_info = _youtube_info(video_id, ranked)
        offset = default_offset_ms(youtube_info.duration, c.duration)
        song = Song(
            artist=c.artist_name,
            title=c.track_name,
            album=c.album_name,
            youtube=youtube_info,
            offset_ms=offset,
            auto_offset_ms=offset or None,
            lrclib=LrclibRef(id=c.id, duration=c.duration),
            synced=lyrics.synced,
            lines=lyrics.lines,
            translator=TranslatorInfo(model=settings.translate_model, prompt_version=translator.PROMPT_VERSION),
        )
        song, created = lib.save_song(song, force=force)
        return song_response(song, created=created, missing_translations=result.missing)


# ---- edit -----------------------------------------------------------------


def _switch_video(info: YoutubeInfo | None, video_id: str) -> YoutubeInfo:
    """Make video_id current; the old current video moves into alternatives."""
    _validate_video_id(video_id)
    if info is None:
        return YoutubeInfo(video_id=video_id)
    if info.video_id == video_id:
        return info
    current = YoutubeVideo(**info.model_dump(exclude={"alternatives"}))
    chosen = next((v for v in info.alternatives if v.video_id == video_id), YoutubeVideo(video_id=video_id))
    others = [v for v in info.alternatives if v.video_id != video_id]
    return YoutubeInfo(**chosen.model_dump(), alternatives=[current, *others])


def patch_song(lib: Library, artist_slug: str, title_slug: str, patch: SongPatch) -> SongResponse:
    key = str(lib.song_path(artist_slug, title_slug))
    with song_lock(key):
        song = lib.get_song(artist_slug, title_slug)
        update: dict = {}
        if patch.offset_ms is not None:
            update["offset_ms"] = patch.offset_ms
        if patch.video_id is not None:
            update["youtube"] = _switch_video(song.youtube, patch.video_id)
        if patch.synced is not None:
            update["synced"] = patch.synced
        if patch.lines:
            lines = [line.model_copy() for line in song.lines]
            for lp in patch.lines:
                if not 0 <= lp.index < len(lines):
                    raise PipelineError(f"行號超出範圍：{lp.index}")
                if lp.tr is not None:
                    lines[lp.index].tr = lp.tr
                if "t" in lp.model_fields_set:
                    lines[lp.index].t = lp.t
            update["lines"] = lines
        song = song.model_copy(update=update)

        renamed = (patch.artist and patch.artist != song.artist) or (patch.title and patch.title != song.title)
        if renamed:
            # move first (it rejects conflicts and may adopt the target folder's
            # artist name), then write the other edits at the new place
            moved = lib.move_song(artist_slug, title_slug, artist=patch.artist, title=patch.title)
            song = song.model_copy(update={"artist": moved.artist, "title": moved.title})
        song = lib.update_song(*song_slugs(song), song)
        return song_response(song)


def retranslate(
    lib: Library,
    artist_slug: str,
    title_slug: str,
    line_indices: list[int] | None = None,
    backend: translator.Backend | None = None,
) -> SongResponse:
    key = str(lib.song_path(artist_slug, title_slug))
    with song_lock(key):
        song = lib.get_song(artist_slug, title_slug)
        texts = [line.text for line in song.lines]
        if line_indices is not None:
            bad = [i for i in line_indices if not 0 <= i < len(texts)]
            if bad:
                raise PipelineError(f"行號超出範圍：{bad}")
            line_indices = sorted(set(line_indices))
        result = translator.translate(texts, line_indices=line_indices, backend=backend)
        lines = [line.model_copy() for line in song.lines]
        for i, tr in result.translations.items():
            # keep the old translation if the new one failed
            if tr:
                lines[i].tr = tr
        song = song.model_copy(
            update={
                "lines": lines,
                "translator": TranslatorInfo(
                    model=settings.translate_model, prompt_version=translator.PROMPT_VERSION
                ),
            }
        )
        song = lib.update_song(artist_slug, title_slug, song)
        return song_response(song, missing_translations=result.missing)

