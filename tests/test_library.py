import json

import pytest

from app.models import Line, Song
from app.services.library import Library, LibraryError, SongExists, SongNotFound, slugify


@pytest.fixture
def lib(tmp_path):
    return Library(tmp_path / "library")


def song(artist="Test Artist", title="Paper Moon", **kw):
    return Song(artist=artist, title=title, lines=[Line(t=1.0, text="line one", tr="第一行")], **kw)


@pytest.mark.parametrize(
    "name, expected",
    [
        ("Test Artist", "test-artist"),
        ("  Paper   Moon  ", "paper-moon"),
        ('A/B\\C:D*E?F"G<H>I|J', "abcdefghij"),
        ("아이유", "아이유"),
        ("周杰倫 Jay Chou", "周杰倫-jay-chou"),
        ("夜に駆ける", "夜に駆ける"),
        ("AC/DC", "acdc"),
        ("a - b", "a-b"),
        ("...", "untitled"),
        ("???", "untitled"),
        (".hidden", "hidden"),
    ],
)
def test_slugify(name, expected):
    assert slugify(name) == expected


def test_save_and_get(lib):
    saved, created = lib.save_song(song())
    assert created
    path = lib.root / "test-artist" / "paper-moon.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["artist"] == "Test Artist"
    assert data["schema_version"] == 1
    assert data["lines"] == [{"t": 1.0, "text": "line one", "tr": "第一行", "break_before": False}]
    assert "第一行" in path.read_text(encoding="utf-8")  # not \u-escaped
    assert lib.get_song("test-artist", "paper-moon") == saved


def test_saved_file_uses_umask_permissions(lib):
    import os

    lib.save_song(song())
    umask = os.umask(0)
    os.umask(umask)
    mode = (lib.root / "test-artist" / "paper-moon.json").stat().st_mode & 0o777
    assert mode == 0o666 & ~umask


def test_no_temp_files_left(lib):
    lib.save_song(song())
    assert [p.name for p in (lib.root / "test-artist").iterdir()] == ["paper-moon.json"]


def test_save_existing_returns_existing_without_force(lib):
    first, _ = lib.save_song(song())
    again, created = lib.save_song(song(offset_ms=500))
    assert not created
    assert again == first
    assert again.offset_ms == 0


def test_save_force_overwrites_but_keeps_created_at(lib):
    first, _ = lib.save_song(song())
    second, created = lib.save_song(song(offset_ms=500), force=True)
    assert created
    assert second.offset_ms == 500
    assert second.created_at == first.created_at
    assert lib.get_song("test-artist", "paper-moon").offset_ms == 500


def test_same_slug_different_case_is_same_song(lib):
    lib.save_song(song(title="Paper Moon"))
    _, created = lib.save_song(song(title="PAPER MOON"))
    assert not created


def test_list_tree_sorted(lib):
    assert lib.list_tree() == []
    lib.save_song(song("beta band", "Zeta"))
    lib.save_song(song("Alpha", "song b"))
    lib.save_song(song("Alpha", "Song A", synced=True))
    tree = lib.list_tree()
    assert tree == [
        {
            "artist": "Alpha",
            "artist_slug": "alpha",
            "songs": [
                {"title": "Song A", "title_slug": "song-a", "synced": True},
                {"title": "song b", "title_slug": "song-b", "synced": False},
            ],
        },
        {"artist": "beta band", "artist_slug": "beta-band", "songs": [{"title": "Zeta", "title_slug": "zeta", "synced": False}]},
    ]


def test_list_tree_skips_broken_files(lib):
    lib.save_song(song())
    (lib.root / "test-artist" / "broken.json").write_text("{not json")
    (lib.root / "empty-artist").mkdir()
    tree = lib.list_tree()
    assert len(tree) == 1 and len(tree[0]["songs"]) == 1


def test_get_missing(lib):
    with pytest.raises(SongNotFound):
        lib.get_song("nobody", "nothing")


@pytest.mark.parametrize("artist_slug, title_slug", [("..", "x"), ("a", "../x"), ("a/b", "c"), ("", "x"), (".git", "x")])
def test_path_traversal_rejected(lib, artist_slug, title_slug):
    with pytest.raises(SongNotFound):
        lib.get_song(artist_slug, title_slug)


def test_update_song(lib):
    saved, _ = lib.save_song(song())
    updated = lib.update_song("test-artist", "paper-moon", saved.model_copy(update={"offset_ms": -200}))
    assert lib.get_song("test-artist", "paper-moon").offset_ms == -200
    assert updated.updated_at >= saved.updated_at


def test_update_song_rejects_rename(lib):
    saved, _ = lib.save_song(song())
    with pytest.raises(LibraryError):
        lib.update_song("test-artist", "paper-moon", saved.model_copy(update={"title": "Other"}))


def test_delete_removes_empty_folder(lib):
    lib.save_song(song())
    lib.delete_song("test-artist", "paper-moon")
    assert not (lib.root / "test-artist").exists()
    assert lib.root.exists()
    with pytest.raises(SongNotFound):
        lib.delete_song("test-artist", "paper-moon")


def test_delete_keeps_nonempty_folder(lib):
    lib.save_song(song(title="One"))
    lib.save_song(song(title="Two"))
    lib.delete_song("test-artist", "one")
    assert [s["title"] for s in lib.list_tree()[0]["songs"]] == ["Two"]


def test_move_artist(lib):
    lib.save_song(song())
    moved = lib.move_song("test-artist", "paper-moon", artist="New Name")
    assert moved.artist == "New Name"
    assert lib.get_song("new-name", "paper-moon").lines[0].tr == "第一行"
    assert not (lib.root / "test-artist").exists()


def test_move_title_only(lib):
    lib.save_song(song())
    lib.move_song("test-artist", "paper-moon", title="Paper Sun")
    assert [s["title_slug"] for s in lib.list_tree()[0]["songs"]] == ["paper-sun"]


def test_move_display_name_only_same_slug(lib):
    lib.save_song(song())
    moved = lib.move_song("test-artist", "paper-moon", artist="TEST ARTIST")
    assert moved.artist == "TEST ARTIST"
    assert lib.get_song("test-artist", "paper-moon").artist == "TEST ARTIST"


def test_move_conflict(lib):
    lib.save_song(song(title="One"))
    lib.save_song(song(title="Two"))
    with pytest.raises(SongExists):
        lib.move_song("test-artist", "one", title="Two")
    assert lib.get_song("test-artist", "one").title == "One"
