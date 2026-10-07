import json

import pytest

from app.models import Line, Song
from app.services.library import Library, LibraryError, SongExists, SongNotFound, artist_slug, slugify


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
    for artist in tree:
        for s in artist["songs"]:
            assert s.pop("updated_at").endswith("Z")
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


# ---- artist slug aliases ----------------------------------------------------


@pytest.mark.parametrize(
    "name, expected",
    [
        ("IU (아이유)", "iu"),
        ("IU(아이유)", "iu"),
        ("IU", "iu"),
        ("BTS [방탄소년단]", "bts"),
        ("周杰倫（Jay Chou）", "周杰倫"),
        ("YOASOBI 【ヨアソビ】", "yoasobi"),
        ("IU (아이유) (KR)", "iu"),  # several trailing aliases
        ("(G)I-DLE", "(g)i-dle"),  # leading parenthesis is part of the name
        ("(G)I-DLE ((여자)아이들)", "(g)i-dle-((여자)아이들)"),  # nested: left alone
        ("(아이유)", "(아이유)"),  # nothing would remain: keep it
        ("Artist (feat. X) Band", "artist-(feat.-x)-band"),  # only trailing
    ],
)
def test_artist_slug_drops_trailing_alias(name, expected):
    assert artist_slug(name) == expected


def test_title_slug_keeps_parentheses(lib):
    lib.save_song(song("IU (아이유)", "Through the Night (밤편지)"))
    assert (lib.root / "iu" / "through-the-night-(밤편지).json").is_file()


def test_alias_artist_joins_existing_folder_with_its_name(lib):
    lib.save_song(song("IU", "One"))
    saved, created = lib.save_song(song("IU (아이유)", "Two"))
    assert created
    assert saved.artist == "IU"  # adopts the folder's existing display name
    assert lib.get_song("iu", "two").artist == "IU"
    tree = lib.list_tree()
    assert len(tree) == 1 and tree[0]["artist"] == "IU"
    assert [s["title"] for s in tree[0]["songs"]] == ["One", "Two"]


def test_first_song_in_folder_keeps_its_own_name(lib):
    saved, _ = lib.save_song(song("IU (아이유)", "One"))
    assert saved.artist == "IU (아이유)"
    other, _ = lib.save_song(song("IU", "Two"))
    assert other.artist == "IU (아이유)"


def test_alias_artist_finds_existing_song(lib):
    lib.save_song(song("IU", "One"))
    _, created = lib.save_song(song("IU (아이유)", "One"))
    assert not created
    assert lib.find_existing("IU (아이유)", "One").artist == "IU"


def test_move_into_existing_folder_adopts_name(lib):
    lib.save_song(song("IU", "One"))
    lib.save_song(song("Someone", "Two"))
    moved = lib.move_song("someone", "two", artist="IU (아이유)")
    assert moved.artist == "IU"
    assert lib.get_song("iu", "two").artist == "IU"
    assert not (lib.root / "someone").exists()


def test_move_sole_song_can_change_display_name(lib):
    lib.save_song(song("IU", "One"))
    moved = lib.move_song("iu", "one", artist="IU (아이유)")
    assert moved.artist == "IU (아이유)"  # no other song in the folder to adopt from
    assert lib.get_song("iu", "one").artist == "IU (아이유)"
