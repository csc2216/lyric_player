from pathlib import Path

import pytest

from app.services.lrc_parser import (
    align,
    apply_plain_breaks,
    build_lines,
    entries_to_lines,
    parse_lrc,
    parse_plain,
)

FIXTURES = Path(__file__).parent / "fixtures"


def times_and_texts(entries):
    return [(e.t, e.text) for e in entries]


def breaks(lines):
    return [i for i, line in enumerate(lines) if line.break_before]


# ---- timestamps ---------------------------------------------------------


@pytest.mark.parametrize(
    "stamp, expected",
    [
        ("[01:02]", 62.0),
        ("[01:02.5]", 62.5),
        ("[01:02.34]", 62.34),
        ("[01:02.345]", 62.345),
        ("[01:02:34]", 62.34),  # colon before fraction
        ("[100:00.00]", 6000.0),  # minutes > 99
    ],
)
def test_timestamp_formats(stamp, expected):
    assert times_and_texts(parse_lrc(f"{stamp}text")) == [(expected, "text")]


def test_multiple_timestamps_expand_and_sort():
    text = "[00:30.00][00:05.00]repeat\n[00:10.00]middle"
    assert times_and_texts(parse_lrc(text)) == [
        (5.0, "repeat"),
        (10.0, "middle"),
        (30.0, "repeat"),
    ]


def test_out_of_order_lines_are_sorted():
    text = "[00:20.00]b\n[00:10.00]a"
    assert [e.text for e in parse_lrc(text)] == ["a", "b"]


def test_metadata_and_untimed_lines_ignored():
    text = "[ar:Someone]\n[ti:Title]\n[al:Album]\n[by:me]\n[length:03:00]\nno timestamp\n[00:01.00]real"
    assert times_and_texts(parse_lrc(text)) == [(1.0, "real")]


def test_positive_offset_shifts_earlier():
    text = "[offset:+500]\n[00:10.00]a"
    assert parse_lrc(text)[0].t == 9.5


def test_negative_offset_shifts_later():
    text = "[00:10.00]a\n[offset:-1500]"  # tag position doesn't matter
    assert parse_lrc(text)[0].t == 11.5


def test_offset_never_goes_below_zero():
    text = "[offset:2000]\n[00:01.00]a"
    assert parse_lrc(text)[0].t == 0.0


def test_enhanced_word_timing_stripped():
    text = "[00:01.00]<00:01.00>line <00:01.50>one"
    assert parse_lrc(text)[0].text == "line one"


# ---- instrumental markers -----------------------------------------------


def test_empty_timestamp_lines_become_breaks():
    text = "[00:00.00]\n[00:01.00]a\n[00:02.00]b\n[00:05.00]\n[00:09.00]c"
    lines = entries_to_lines(parse_lrc(text))
    assert [line.text for line in lines] == ["a", "b", "c"]
    assert breaks(lines) == [2]  # leading marker doesn't mark the first line


def test_consecutive_markers_give_single_break():
    text = "[00:01.00]a\n[00:02.00]\n[00:03.00]\n[00:04.00]b"
    assert breaks(entries_to_lines(parse_lrc(text))) == [1]


def test_trailing_marker_ignored():
    lines = entries_to_lines(parse_lrc("[00:01.00]a\n[00:02.00]"))
    assert len(lines) == 1 and not lines[0].break_before


def test_sample_fixture():
    lines = entries_to_lines(parse_lrc((FIXTURES / "sample.lrc").read_text()))
    assert [(line.t, line.text) for line in lines] == [
        (10.0, "line one"),
        (14.5, "line two"),
        (30.0, "chorus line"),
        (34.0, "第二行"),
        (65.0, "bridge line"),
        (90.0, "chorus line"),
    ]
    assert breaks(lines) == [2, 4]


# ---- plain ----------------------------------------------------------------


def test_parse_plain_breaks_and_whitespace():
    lines = parse_plain("\n\n  line one \nline two\n\n\n第三行\n")
    assert [line.text for line in lines] == ["line one", "line two", "第三行"]
    assert all(line.t is None for line in lines)
    assert breaks(lines) == [2]


# ---- alignment ----------------------------------------------------------


def test_align_identical():
    assert align(["a", "b", "c"], ["a", "b", "c"]) == [(0, 0), (1, 1), (2, 2)]


def test_align_rejects_large_count_difference():
    assert align(["a"] * 2, ["a"] * 20) is None


def test_align_rejects_mostly_different_text():
    assert align(["alpha", "bravo", "charlie", "delta"], ["one", "two", "three", "four"]) is None


def test_plain_breaks_copied_to_synced():
    synced = "[00:01.00]line one\n[00:02.00]line two\n[00:03.00]第三行\n[00:04.00]line four"
    plain = "Line one!\nline  two\n\n第三行。\nline four"
    result = build_lines(synced, plain)
    assert result.break_source == "plain"
    assert result.synced
    assert breaks(result.lines) == [2]


def test_plain_has_extra_lines():
    # plain has a line synced lacks; its paragraph break carries to the next match
    synced = "\n".join(f"[00:{i:02d}.00]line {n}" for i, n in enumerate(["a", "b", "c", "d", "e"]))
    plain = "line a\nline b\n\nextra plain only\nline c\nline d\n\nline e"
    lines = build_lines(synced, plain).lines
    assert breaks(lines) == [2, 4]


def test_synced_has_extra_lines():
    synced = "[00:01.00]line a\n[00:02.00]line b\n[00:03.00]synced only\n[00:04.00]line c\n[00:05.00]line d"
    plain = "line a\nline b\n\nline c\nline d"
    lines = build_lines(synced, plain).lines
    assert [line.text for line in lines] == ["line a", "line b", "synced only", "line c", "line d"]
    assert breaks(lines) == [3]


def test_repeated_chorus_aligns_in_order():
    synced = "\n".join(
        f"[00:{i:02d}.00]{t}" for i, t in enumerate(["verse a", "chorus", "chorus", "verse b", "chorus", "chorus"])
    )
    plain = "verse a\n\nchorus\nchorus\n\nverse b\n\nchorus\nchorus"
    assert breaks(build_lines(synced, plain).lines) == [1, 3, 4]


def test_plain_paragraphs_override_synced_markers():
    # marker mid-paragraph (a1|a2) is dropped; plain's own break (b2|b3) is used
    synced = "[00:01.00]a1\n[00:02.00]\n[00:05.00]a2\n[00:10.00]b1\n[00:11.00]b2\n[00:12.00]b3"
    plain = "a1\na2\nb1\nb2\n\nb3"
    lines = build_lines(synced, plain).lines
    assert breaks(lines) == [4]


def test_synced_markers_kept_when_alignment_fails():
    synced = "[00:01.00]one\n[00:02.00]\n[00:03.00]two\n[00:04.00]three\n[00:05.00]four"
    result = build_lines(synced, "完全\n不同\n的\n內容")
    assert result.break_source == "gap"
    assert breaks(result.lines) == [1]


def test_alignment_failure_falls_back_to_gap_rule():
    synced = "[00:01.00]one\n[00:03.00]two\n[00:10.00]three\n[00:12.00]four"
    plain = "完全\n不同\n的\n歌詞\n內容\n\n在這裡"
    result = build_lines(synced, plain)
    assert result.break_source == "gap"
    assert breaks(result.lines) == [2]  # 3 -> 10 is > 4s


def test_gap_rule_boundary_is_strict():
    synced = "[00:00.00]a\n[00:04.00]b\n[00:08.01]c"
    assert breaks(build_lines(synced, None).lines) == [2]


def test_apply_plain_breaks_leaves_lines_untouched_on_failure():
    lines = entries_to_lines(parse_lrc("[00:01.00]a\n[00:02.00]b"))
    assert apply_plain_breaks(lines, "x\n" * 30) is False
    assert breaks(lines) == []


def test_synced_only_without_plain_uses_markers_and_gap():
    synced = "[00:01.00]a\n[00:02.00]\n[00:03.00]b\n[00:04.00]c\n[00:20.00]d"
    result = build_lines(synced, None)
    assert result.break_source == "gap"
    assert breaks(result.lines) == [1, 3]


def test_plain_only():
    result = build_lines(None, "line one\nline two\n\n第三行")
    assert result.synced is False
    assert result.break_source == "plain_only"
    assert [line.t for line in result.lines] == [None, None, None]
    assert breaks(result.lines) == [2]


def test_synced_with_no_text_falls_back_to_plain():
    result = build_lines("[00:01.00]\n[ar:x]", "line one")
    assert result.synced is False
    assert [line.text for line in result.lines] == ["line one"]


def test_nothing():
    result = build_lines(None, None)
    assert result.lines == [] and result.break_source == "none"


def test_negative_offset_with_alignment():
    synced = "[offset:-1000]\n[00:01.00]a1\n[00:02.00]a2\n[00:03.00]b1"
    lines = build_lines(synced, "a1\na2\n\nb1").lines
    assert [line.t for line in lines] == [2.0, 3.0, 4.0]
    assert breaks(lines) == [2]


def test_translation_field_empty():
    lines = build_lines("[00:01.00]a", None).lines
    assert lines[0].tr == ""
