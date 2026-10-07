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
