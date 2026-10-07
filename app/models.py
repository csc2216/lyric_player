from datetime import datetime, timezone

from pydantic import BaseModel, Field

SCHEMA_VERSION = 1


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


class Line(BaseModel):
    t: float | None = None
    text: str
    tr: str = ""
    break_before: bool = False


class YoutubeVideo(BaseModel):
    video_id: str
    title: str = ""
    channel: str = ""
    duration: float | None = None


class YoutubeInfo(YoutubeVideo):
    alternatives: list[YoutubeVideo] = Field(default_factory=list)


class LrclibRef(BaseModel):
    id: int
    duration: float | None = None


class TranslatorInfo(BaseModel):
    model: str
    prompt_version: int


class Song(BaseModel):
    schema_version: int = SCHEMA_VERSION
    artist: str
    title: str
    album: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    youtube: YoutubeInfo | None = None
    lrclib: LrclibRef | None = None
    synced: bool = False
    offset_ms: int = 0
    # offset_ms set automatically at build from the video/LRCLIB duration
    # difference (None if not auto-set); the UI shows a hint while they match
    auto_offset_ms: int | None = None
    lines: list[Line] = Field(default_factory=list)
    translator: TranslatorInfo | None = None


class LrclibCandidate(BaseModel):
    id: int
    track_name: str
    artist_name: str
    album_name: str | None = None
    duration: float | None = None
    instrumental: bool = False
    plain_lyrics: str | None = None
    synced_lyrics: str | None = None
    # Match score against the user's query (0..1); filled in by ranking.
    score: float = 0.0
    # False when the last synced timestamp is past `duration` (bad metadata).
    duration_ok: bool = True
    # Latin-only lyrics while a native-script upload of the same song exists.
    romanized: bool = False

    @classmethod
    def from_api(cls, data: dict) -> "LrclibCandidate":
        return cls(
            id=data["id"],
            track_name=data.get("trackName") or "",
            artist_name=data.get("artistName") or "",
            album_name=data.get("albumName") or None,
            duration=data.get("duration"),
            instrumental=bool(data.get("instrumental")),
            plain_lyrics=data.get("plainLyrics") or None,
            synced_lyrics=data.get("syncedLyrics") or None,
        )

    @property
    def has_synced(self) -> bool:
        return bool(self.synced_lyrics and self.synced_lyrics.strip())


# ---- API schemas ----------------------------------------------------------


class ResolveRequest(BaseModel):
    query: str = Field(min_length=1)


class VideoMatch(YoutubeVideo):
    score: float
    # video duration - LRCLIB duration (seconds), None if either is unknown
    duration_diff: float | None = None


class ResolveCandidate(BaseModel):
    id: int
    track_name: str
    artist_name: str
    album_name: str | None = None
    duration: float | None = None
    synced: bool
    duration_ok: bool
    romanized: bool = False
    score: float
    line_count: int
    preview: list[str]
    video: VideoMatch | None = None


class ResolveChecks(BaseModel):
    synced: bool
    # score lead of the pick over the best *different* song (None = no other song)
    lead: float | None
    competitor: str | None
    video_diff: float | None
    tie_size: int
    tie_broken_by_duration: bool
    youtube_fallback: bool


class ResolveResponse(BaseModel):
    query: str
    auto_ok: bool
    reason: str
    checks: ResolveChecks | None = None
    # candidates[0] is the pick
    candidates: list[ResolveCandidate]


class BuildRequest(BaseModel):
    lrclib_id: int
    video_id: str
    force: bool = False


class SongResponse(BaseModel):
    artist_slug: str
    title_slug: str
    song: Song
    # build: False when an existing song was returned instead of building
    created: bool | None = None
    # line indices left without translation after the retry
    missing_translations: list[int] = Field(default_factory=list)


class LinePatch(BaseModel):
    index: int
    tr: str | None = None
    t: float | None = None  # send null explicitly to clear


class SongPatch(BaseModel):
    offset_ms: int | None = None
    video_id: str | None = None
    artist: str | None = Field(default=None, min_length=1)
    title: str | None = Field(default=None, min_length=1)
    synced: bool | None = None
    lines: list[LinePatch] | None = None


class RetranslateRequest(BaseModel):
    line_indices: list[int] | None = None
