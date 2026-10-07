"""Song storage: library/<artist_slug>/<title_slug>.json."""

import json
import logging
import os
import re
import tempfile
from pathlib import Path

from app.models import Song, utcnow

log = logging.getLogger(__name__)

_ILLEGAL_RE = re.compile(r'[/\\:*?"<>|\x00-\x1f]')
_SPACE_RE = re.compile(r"\s+")


class LibraryError(Exception):
    pass


class SongNotFound(LibraryError):
    pass


class SongExists(LibraryError):
    pass


def slugify(name: str) -> str:
    """Filename-safe slug; keeps CJK/Hangul/kana, lowercases Latin letters."""
    slug = _ILLEGAL_RE.sub("", name)
    slug = _SPACE_RE.sub("-", slug.strip()).lower()
    slug = re.sub(r"-{2,}", "-", slug).strip("-.")
    return slug or "untitled"


def _sort_key(name: str) -> str:
    return name.casefold()


class Library:
    def __init__(self, root: Path):
        self.root = Path(root)

    def _path(self, artist_slug: str, title_slug: str) -> Path:
        for part in (artist_slug, title_slug):
            if not part or part.startswith(".") or _ILLEGAL_RE.search(part):
                raise SongNotFound(f"無效的路徑：{artist_slug}/{title_slug}")
        path = (self.root / artist_slug / f"{title_slug}.json").resolve()
        if self.root.resolve() not in path.parents:
            raise SongNotFound(f"無效的路徑：{artist_slug}/{title_slug}")
        return path

    def path_for(self, song: Song) -> Path:
        return self._path(slugify(song.artist), slugify(song.title))

    def _read(self, path: Path) -> Song:
        return Song.model_validate_json(path.read_text(encoding="utf-8"))

    def _write(self, path: Path, song: Song) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = json.dumps(song.model_dump(mode="json"), ensure_ascii=False, indent=2)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(data + "\n")
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def list_tree(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        tree = []
        for artist_dir in self.root.iterdir():
            if not artist_dir.is_dir() or artist_dir.name.startswith("."):
                continue
            songs, artist_name = [], None
            for f in artist_dir.glob("*.json"):
                if f.name.startswith("."):
                    continue
                try:
                    song = self._read(f)
                except (OSError, ValueError) as e:
                    log.warning("skipping unreadable song %s: %s", f, e)
                    continue
                artist_name = artist_name or song.artist
                songs.append({"title": song.title, "title_slug": f.stem, "synced": song.synced})
            if not songs:
                continue
            songs.sort(key=lambda s: _sort_key(s["title"]))
            tree.append({"artist": artist_name, "artist_slug": artist_dir.name, "songs": songs})
        tree.sort(key=lambda a: _sort_key(a["artist"]))
        return tree

    def get_song(self, artist_slug: str, title_slug: str) -> Song:
        path = self._path(artist_slug, title_slug)
        if not path.is_file():
            raise SongNotFound(f"找不到歌曲：{artist_slug}/{title_slug}")
        return self._read(path)

    def find_existing(self, artist: str, title: str) -> Song | None:
        path = self.path_for(Song(artist=artist, title=title))
        return self._read(path) if path.is_file() else None

    def save_song(self, song: Song, force: bool = False) -> tuple[Song, bool]:
        """Save a new song. Returns (song, created).

        If the same artist/title already exists and not `force`, the existing
        song is returned unchanged (created=False).
        """
        path = self.path_for(song)
        if path.is_file():
            existing = self._read(path)
            if not force:
                return existing, False
            song = song.model_copy(update={"created_at": existing.created_at})
        song = song.model_copy(update={"updated_at": utcnow()})
        self._write(path, song)
        return song, True

    def update_song(self, artist_slug: str, title_slug: str, song: Song) -> Song:
        """Overwrite an existing song in place (artist/title must keep the same slugs)."""
        path = self._path(artist_slug, title_slug)
        if path != self.path_for(song):
            raise LibraryError("改歌手或歌名請用 move_song")
        if not path.is_file():
            raise SongNotFound(f"找不到歌曲：{artist_slug}/{title_slug}")
        song = song.model_copy(update={"updated_at": utcnow()})
        self._write(path, song)
        return song

    def delete_song(self, artist_slug: str, title_slug: str) -> None:
        path = self._path(artist_slug, title_slug)
        if not path.is_file():
            raise SongNotFound(f"找不到歌曲：{artist_slug}/{title_slug}")
        path.unlink()
        self._remove_if_empty(path.parent)

    def move_song(
        self,
        artist_slug: str,
        title_slug: str,
        artist: str | None = None,
        title: str | None = None,
    ) -> Song:
        """Rename artist and/or title, moving the file; empty folders are removed."""
        old_path = self._path(artist_slug, title_slug)
        song = self.get_song(artist_slug, title_slug)
        song = song.model_copy(
            update={"artist": artist or song.artist, "title": title or song.title, "updated_at": utcnow()}
        )
        new_path = self.path_for(song)
        if new_path != old_path and new_path.exists():
            raise SongExists(f"已有同名歌曲：{song.artist} - {song.title}")
        self._write(new_path, song)
        if new_path != old_path:
            old_path.unlink()
            self._remove_if_empty(old_path.parent)
        return song

    def _remove_if_empty(self, directory: Path) -> None:
        if directory != self.root and directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()
