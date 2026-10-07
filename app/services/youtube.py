"""YouTube search via yt-dlp and candidate scoring."""

import re
from dataclasses import dataclass
from typing import Literal

from app.models import YoutubeVideo
from app.services.text import normalize_text

VideoPreference = Literal["sync", "mv"]

SEARCH_COUNT = 8
SOCKET_TIMEOUT = 15
MAX_ALTERNATIVES = 5

# Penalized title keywords (word-boundary match so "live" doesn't hit "alive").
BAD_KEYWORDS = {
    "cover": r"\bcover\b",
    "dance practice": r"\bdance\s+practice\b",
    "live": r"\blive\b",
    "lyrics": r"\blyrics?\b",
    "sped up": r"\bsped\s*up\b",
    "reaction": r"\breaction\b",
}
MV_KEYWORDS = r"\b(official\s+(music\s+)?video|m/?v)\b"


class YoutubeError(Exception):
    pass


@dataclass
class ScoredVideo:
    video: YoutubeVideo
    score: float


def _duration_score(diff: float, preference: VideoPreference) -> float:
    if preference == "sync":
        # Timing alignment depends mostly on this.
        return 50.0 if diff <= 3 else max(-60.0, 50.0 - (diff - 3) * 4)
    return 20.0 if diff <= 3 else max(-30.0, 20.0 - (diff - 3) * 1)


def score_video(
    entry: dict,
    artist: str,
    title: str,
    target_duration: float | None,
    preference: VideoPreference = "sync",
) -> float:
    """Score one yt-dlp flat search entry. Pure function."""
    video_title = entry.get("title") or ""
    channel = entry.get("channel") or entry.get("uploader") or ""
    duration = entry.get("duration")
    score = 0.0

    if target_duration is not None and duration is not None:
        score += _duration_score(abs(float(duration) - target_duration), preference)

    n_video_title, n_channel = normalize_text(video_title), normalize_text(channel)
    n_title, n_artist = normalize_text(title), normalize_text(artist)
    if n_title and n_title in n_video_title:
        score += 20
    if n_artist and n_artist in n_channel:
        score += 15
    if channel.endswith(" - Topic"):
        score += 15
    if "official" in channel.lower() or "vevo" in channel.lower():
        score += 10

    lower_title, lower_song = video_title.lower(), title.lower()
    for pattern in BAD_KEYWORDS.values():
        # Don't penalize when the keyword is part of the song name itself.
        if re.search(pattern, lower_title) and not re.search(pattern, lower_song):
            score -= 30

    if preference == "mv" and re.search(MV_KEYWORDS, lower_title):
        score += 25
    return score


def entry_to_video(entry: dict) -> YoutubeVideo:
    duration = entry.get("duration")
    return YoutubeVideo(
        video_id=entry["id"],
        title=entry.get("title") or "",
        channel=entry.get("channel") or entry.get("uploader") or "",
        duration=float(duration) if duration is not None else None,
    )


def rank_videos(
    entries: list[dict],
    artist: str,
    title: str,
    target_duration: float | None,
    preference: VideoPreference = "sync",
) -> list[ScoredVideo]:
    """Score and sort search entries, best first. Pure function."""
    scored = [
        ScoredVideo(entry_to_video(e), score_video(e, artist, title, target_duration, preference))
        for e in entries
        if e.get("id") and e.get("live_status") != "is_live"
    ]
    scored.sort(key=lambda s: s.score, reverse=True)
    return scored


def search_entries(artist: str, title: str, count: int = SEARCH_COUNT) -> list[dict]:
    """Raw yt-dlp flat search results (network)."""
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "socket_timeout": SOCKET_TIMEOUT,
    }
    query = f"ytsearch{count}:{artist} {title}".strip()
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(query, download=False)
    except Exception as e:  # yt-dlp raises many types; surface one clear error
        raise YoutubeError(f"YouTube 搜尋失敗：{e}") from e
    return list((info or {}).get("entries") or [])


def find_videos(
    artist: str,
    title: str,
    target_duration: float | None,
    preference: VideoPreference = "sync",
) -> list[ScoredVideo]:
    """Search YouTube and return ranked candidates (top MAX_ALTERNATIVES)."""
    entries = search_entries(artist, title)
    return rank_videos(entries, artist, title, target_duration, preference)[:MAX_ALTERNATIVES]
