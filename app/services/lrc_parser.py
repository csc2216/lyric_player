"""LRC parsing and paragraph (break_before) detection."""

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Literal

from app.models import Line
from app.services.hangul import romanize
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
# Pasted native lyrics vs a romanized upload: compared as loose_key()s, which
# still differ in liaison / spelling details, so the bar is lower.
RETIME_LINE_SIMILARITY = 0.6
# Unmatched lines after the last matched one: this many seconds apart.
RETIME_TAIL_STEP = 2.0

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


@dataclass
class RetimeResult:
    lines: list[Line]
    matched: int
    total: int


def _match_weight(a: str, b: str, threshold: float = LINE_SIMILARITY) -> float:
    """0 if the lines don't match, else 1 + similarity (so the most matches
    win first, and among equal counts the closer pairing)."""
    if not a or not b:
        return 0.0
    if a == b:
        return 2.0
    ratio = SequenceMatcher(None, a, b).ratio()
    return 1.0 + ratio if ratio >= threshold else 0.0


def align(
    plain: list[str], synced: list[str], threshold: float = LINE_SIMILARITY
) -> list[tuple[int, int]] | None:
    """In-order fuzzy alignment (weighted LCS) of normalized lines.

    Returns (plain_index, synced_index) pairs, or None when the two texts
    differ too much to trust the result.
    """
    n, m = len(plain), len(synced)
    if not n or not m:
        return None
    allowed_diff = max(MIN_LINE_COUNT_DIFF, MAX_LINE_COUNT_DIFF_RATIO * max(n, m))
    if abs(n - m) > allowed_diff:
        return None
    # dp[i][j] = best total weight aligning plain[i:] with synced[j:]
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    weight = [[0.0] * m for _ in range(n)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            w = weight[i][j] = _match_weight(plain[i], synced[j], threshold)
            dp[i][j] = max(dp[i + 1][j], dp[i][j + 1], dp[i + 1][j + 1] + w if w else 0.0)
    pairs: list[tuple[int, int]] = []
    i = j = 0
    while i < n and j < m:
        w = weight[i][j]
        if w and dp[i][j] == dp[i + 1][j + 1] + w:
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


# Spelling variants that romanizations of the same Korean line disagree on.
_LOOSE_DIGRAPHS = [("eo", "o"), ("eu", "u"), ("ae", "e"), ("oe", "e"), ("wo", "o"), ("ch", "j"), ("sh", "s")]
_LOOSE_LETTERS = str.maketrans({"k": "g", "t": "d", "p": "b", "r": "l"})


def loose_key(text: str) -> str:
    """Comparison key for romanized (or romanizable) text.

    Hangul is romanized, then spelling variants are folded together
    (eo/o, k/g, r/l, ...) and doubled letters collapsed ("isseo" ~ "itseo").
    """
    key = normalize_text(romanize(text))
    for old, new in _LOOSE_DIGRAPHS:
        key = key.replace(old, new)
    key = key.translate(_LOOSE_LETTERS)
    return "".join(ch for i, ch in enumerate(key) if i == 0 or ch != key[i - 1])


def _fill_gap(times: list[float | None], start: int, end: int, timed: list[float], j0: int, j1: int) -> None:
    """Give times[start:end] (unmatched native lines) values between matched neighbours.

    j0 / j1: the timed indices of the matched lines around the gap (-1 /
    len(timed) at the edges). When the gap holds as many timed lines as
    native ones, they pair up one to one; otherwise times are spread evenly.
    """
    count = end - start
    if count <= 0:
        return
    between = timed[j0 + 1 : j1]
    if len(between) == count:
        times[start:end] = between
        return
    before = times[start - 1] if start > 0 else None
    after = times[end] if end < len(times) else None
    for k in range(count):
        if before is not None and after is not None:
            times[start + k] = before + (after - before) * (k + 1) / (count + 1)
        elif after is not None:  # leading lines
            times[start + k] = max(0.0, after - RETIME_TAIL_STEP * (count - k))
        else:  # trailing lines
            times[start + k] = before + RETIME_TAIL_STEP * (k + 1)


def transfer_timestamps(native_text: str, timed: list[Line]) -> RetimeResult | None:
    """Put the timing of `timed` (e.g. a romanized upload) onto pasted native lyrics.

    Lines are matched in order by loose_key(); matched lines take the timed
    line's t, the rest are filled from their neighbours. Paragraph breaks
    come from the pasted text's blank lines. None if the texts don't line up
    (or `timed` has no timing).
    """
    native = parse_plain(native_text)
    if not native or not timed or any(line.t is None for line in timed):
        return None
    pairs = align(
        [loose_key(line.text) for line in native],
        [loose_key(line.text) for line in timed],
        threshold=RETIME_LINE_SIMILARITY,
    )
    if pairs is None:
        return None
    timed_t = [line.t for line in timed]
    times: list[float | None] = [None] * len(native)
    for i, j in pairs:
        times[i] = timed_t[j]
    prev_i, prev_j = -1, -1
    for i, j in [*pairs, (len(native), len(timed))]:
        _fill_gap(times, prev_i + 1, i, timed_t, prev_j, j)
        prev_i, prev_j = i, j
    # never let a line start before the one above it
    last = 0.0
    for i, t in enumerate(times):
        last = max(last, t)
        native[i].t = round(last, 3)
    return RetimeResult(native, matched=len(pairs), total=len(native))


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
