"""LRC parsing and paragraph (break_before) detection."""

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Literal

from app.models import Line
from app.services.text import normalize_text

# [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx]; some files use ':' before the fraction.
_TIMESTAMP = r"\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]"
_TIMESTAMP_RE = re.compile(_TIMESTAMP)
_TIMED_LINE_RE = re.compile(rf"^(?P<stamps>(?:{_TIMESTAMP}\s*)+)(?P<body>.*)$")
_TAG_RE = re.compile(r"^\[([A-Za-z#]+):(.*)\]$")
# Enhanced-LRC word timings like <00:12.34>.
_WORD_TIME_RE = re.compile(r"<\d+:\d{1,2}(?:[.:]\d{1,3})?>")

GAP_BREAK_SECONDS = 4.0
# Alignment is considered failed past these thresholds.
MAX_LINE_COUNT_DIFF_RATIO = 0.2
MIN_LINE_COUNT_DIFF = 4
MIN_MATCHED_RATIO = 0.7
LINE_SIMILARITY = 0.85

BreakSource = Literal["plain", "gap", "plain_only", "none"]


@dataclass
class TimedEntry:
    t: float
    text: str  # empty = instrumental marker


@dataclass
class LyricsResult:
    lines: list[Line]
    synced: bool
    break_source: BreakSource


def _parse_time(minutes: str, seconds: str, fraction: str | None) -> float:
    value = int(minutes) * 60 + int(seconds)
    if fraction:
        value += int(fraction) / (10 ** len(fraction))
    return value


def parse_lrc(text: str) -> list[TimedEntry]:
    """Parse LRC text into time-sorted entries, with [offset:] applied.

    Lines with several timestamps are expanded. Entries with empty text are
    instrumental markers. Metadata tags and untimed lines are ignored.
    """
    entries: list[TimedEntry] = []
    offset_ms = 0
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        m = _TIMED_LINE_RE.match(raw)
        if m:
            body = _WORD_TIME_RE.sub("", m.group("body")).strip()
            for ts in _TIMESTAMP_RE.finditer(m.group("stamps")):
                entries.append(TimedEntry(_parse_time(*ts.groups()), body))
            continue
        tag = _TAG_RE.match(raw)
        if tag and tag.group(1).lower() == "offset":
            try:
                offset_ms = int(tag.group(2).strip())
            except ValueError:
                pass
    # LRC convention: a positive offset makes lyrics appear sooner.
    shift = offset_ms / 1000
    for e in entries:
        e.t = round(max(0.0, e.t - shift), 3)
    entries.sort(key=lambda e: e.t)  # stable: keeps file order for equal times
    return entries


def entries_to_lines(entries: list[TimedEntry]) -> list[Line]:
    """Drop instrumental markers, turning them into break_before on the next line."""
    lines: list[Line] = []
    pending_break = False
    for e in entries:
        if not e.text:
            pending_break = True
            continue
        lines.append(Line(t=e.t, text=e.text, break_before=pending_break and bool(lines)))
        pending_break = False
    return lines


def parse_plain(text: str) -> list[Line]:
    """Plain lyrics: one Line per non-empty line, blank lines become break_before."""
    lines: list[Line] = []
    pending_break = False
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw:
            pending_break = True
            continue
        lines.append(Line(t=None, text=raw, break_before=pending_break and bool(lines)))
        pending_break = False
    return lines


def _lines_match(a: str, b: str) -> bool:
    if a == b:
        return bool(a)
    if not a or not b:
        return False
    return SequenceMatcher(None, a, b).ratio() >= LINE_SIMILARITY


def align(plain: list[str], synced: list[str]) -> list[tuple[int, int]] | None:
    """In-order fuzzy alignment (LCS) of normalized lines.

    Returns (plain_index, synced_index) pairs, or None when the two texts
    differ too much to trust the result.
    """
    n, m = len(plain), len(synced)
    if not n or not m:
        return None
    allowed_diff = max(MIN_LINE_COUNT_DIFF, MAX_LINE_COUNT_DIFF_RATIO * max(n, m))
    if abs(n - m) > allowed_diff:
        return None
    # dp[i][j] = LCS length of plain[i:] and synced[j:]
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    match = [[False] * m for _ in range(n)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            match[i][j] = _lines_match(plain[i], synced[j])
            if match[i][j]:
                dp[i][j] = dp[i + 1][j + 1] + 1
            else:
                dp[i][j] = max(dp[i + 1][j], dp[i][j + 1])
    pairs: list[tuple[int, int]] = []
    i = j = 0
    while i < n and j < m:
        if match[i][j] and dp[i][j] == dp[i + 1][j + 1] + 1:
            pairs.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    if len(pairs) < MIN_MATCHED_RATIO * min(n, m):
        return None
    return pairs


def apply_plain_breaks(lines: list[Line], plain_text: str) -> bool:
    """Copy paragraph breaks from plain lyrics onto synced lines.

    On success the plain text's paragraphs replace any breaks that came from
    instrumental markers (plain lyrics are human-formatted, markers often fall
    mid-paragraph). Returns False without touching `lines` if alignment fails.
    """
    plain = parse_plain(plain_text)
    pairs = align([normalize_text(p.text) for p in plain], [normalize_text(s.text) for s in lines])
    if pairs is None:
        return False
    synced_for_plain = dict(pairs)
    for line in lines:
        line.break_before = False
    pending = False
    for i, p in enumerate(plain):
        pending = pending or p.break_before
        j = synced_for_plain.get(i)
        if j is None:
            # Unmatched plain line: carry its break to the next matched line.
            continue
        if pending and j > 0:
            lines[j].break_before = True
        pending = False
    return True


def apply_gap_breaks(lines: list[Line], gap: float = GAP_BREAK_SECONDS) -> None:
    for prev, cur in zip(lines, lines[1:]):
        if prev.t is not None and cur.t is not None and cur.t - prev.t > gap:
            cur.break_before = True


def build_lines(synced_lyrics: str | None, plain_lyrics: str | None) -> LyricsResult:
    """Turn LRCLIB lyrics into display lines (tr left empty)."""
    lines = entries_to_lines(parse_lrc(synced_lyrics)) if synced_lyrics else []
    if lines:
        if plain_lyrics and apply_plain_breaks(lines, plain_lyrics):
            return LyricsResult(lines, synced=True, break_source="plain")
        apply_gap_breaks(lines)
        return LyricsResult(lines, synced=True, break_source="gap")
    if plain_lyrics:
        return LyricsResult(parse_plain(plain_lyrics), synced=False, break_source="plain_only")
    return LyricsResult([], synced=False, break_source="none")
