"""LRCLIB client (https://lrclib.net/docs)."""

import httpx

from app.models import LrclibCandidate
from app.services.lrc_parser import parse_lrc
from app.services.text import similarity

BASE_URL = "https://lrclib.net/api"
USER_AGENT = "lyric-player/0.1 (local personal use)"
TIMEOUT = 10.0
# Allowed slack between the last lyric timestamp and the reported duration.
DURATION_SLACK = 1.0


class LrclibError(Exception):
    pass


def split_query(query: str) -> tuple[str, str] | None:
    """'歌手 - 歌名' -> (artist, track); free text -> None."""
    if " - " not in query:
        return None
    artist, track = (part.strip() for part in query.split(" - ", 1))
    if not artist or not track:
        return None
    return artist, track


def score_candidate(c: LrclibCandidate, query: str) -> float:
    """0..1 match of a candidate against the user's query."""
    parts = split_query(query)
    if parts:
        artist, track = parts
        return 0.6 * similarity(track, c.track_name) + 0.4 * similarity(artist, c.artist_name)
    return max(
        similarity(query, f"{c.artist_name} {c.track_name}"),
        similarity(query, f"{c.track_name} {c.artist_name}"),
        0.8 * similarity(query, c.track_name),
    )


def duration_consistent(c: LrclibCandidate) -> bool:
    """LRCLIB has duplicate uploads with wrong durations; catch the obvious ones."""
    if not c.has_synced or c.duration is None:
        return True
    entries = parse_lrc(c.synced_lyrics)
    return not entries or entries[-1].t <= c.duration + DURATION_SLACK


def rank_candidates(raw: list[dict], query: str) -> list[LrclibCandidate]:
    """Drop instrumentals; order by synced, plausible duration, match score. Pure function."""
    candidates = []
    for item in raw:
        c = LrclibCandidate.from_api(item)
        if c.instrumental or not (c.has_synced or c.plain_lyrics):
            continue
        c.score = round(score_candidate(c, query), 4)
        c.duration_ok = duration_consistent(c)
        candidates.append(c)
    candidates.sort(key=lambda c: (c.has_synced, c.duration_ok, c.score), reverse=True)
    return candidates


class LrclibClient:
    def __init__(self, base_url: str = BASE_URL, timeout: float = TIMEOUT, transport=None):
        self._client = httpx.Client(
            base_url=base_url,
            headers={"User-Agent": USER_AGENT},
            timeout=timeout,
            transport=transport,
        )

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self) -> None:
        self._client.close()

    def _get(self, path: str, params: dict | None = None):
        try:
            res = self._client.get(path, params=params)
        except httpx.TimeoutException as e:
            raise LrclibError("LRCLIB 連線逾時") from e
        except httpx.RequestError as e:
            raise LrclibError(f"無法連線 LRCLIB：{e}") from e
        if res.status_code == 404:
            return None
        if res.status_code >= 400:
            raise LrclibError(f"LRCLIB 回應錯誤（HTTP {res.status_code}）")
        try:
            return res.json()
        except ValueError as e:
            raise LrclibError("LRCLIB 回應不是有效的 JSON") from e

    def search(self, query: str) -> list[LrclibCandidate]:
        """Search and rank. Uses track_name/artist_name for '歌手 - 歌名', else q."""
        query = query.strip()
        if not query:
            return []
        parts = split_query(query)
        raw = None
        if parts:
            artist, track = parts
            raw = self._get("/search", {"track_name": track, "artist_name": artist})
            if not raw:
                raw = self._get("/search", {"q": f"{artist} {track}"})
        else:
            raw = self._get("/search", {"q": query})
        return rank_candidates(raw or [], query)

    def get(self, lrclib_id: int) -> LrclibCandidate:
        data = self._get(f"/get/{lrclib_id}")
        if not data:
            raise LrclibError(f"找不到 LRCLIB 歌詞（id={lrclib_id}）")
        return LrclibCandidate.from_api(data)
