"""Hangul -> Latin romanization, used to line up pasted Korean lyrics with
romanized LRCLIB uploads.

Revised Romanization syllable by syllable, plus liaison (a final consonant
moves onto a following ㅇ syllable: 있어 -> isseo), which fan romanizations
nearly always write. Other assimilation rules are skipped; matching is fuzzy
anyway (see lrc_parser.loose_key).
"""

_SYLLABLE_FIRST = 0xAC00
_SYLLABLE_LAST = 0xD7A3

_INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
_MEDIALS = [
    "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae",
    "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i",
]  # fmt: skip
_FINALS = [
    "", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l",
    "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t",
]  # fmt: skip


# Final consonant before a ㅇ-initial syllable: (stays, moves to the next syllable).
_LIAISON = {
    1: ("", "g"), 2: ("", "kk"), 3: ("k", "s"), 4: ("", "n"), 5: ("n", "j"), 6: ("n", ""),
    7: ("", "d"), 8: ("", "r"), 9: ("l", "g"), 10: ("l", "m"), 11: ("l", "b"), 12: ("l", "s"),
    13: ("l", "t"), 14: ("l", "p"), 15: ("l", ""), 16: ("", "m"), 17: ("", "b"), 18: ("p", "s"),
    19: ("", "s"), 20: ("", "ss"), 22: ("", "j"), 23: ("", "ch"), 24: ("", "k"), 25: ("", "t"),
    26: ("", "p"), 27: ("", ""),
}  # fmt: skip
_SILENT_INITIAL = 11


def _decompose(ch: str) -> tuple[int, int, int] | None:
    code = ord(ch)
    if not _SYLLABLE_FIRST <= code <= _SYLLABLE_LAST:
        return None
    initial, rest = divmod(code - _SYLLABLE_FIRST, 21 * 28)
    medial, final = divmod(rest, 28)
    return initial, medial, final


def romanize(text: str) -> str:
    """Romanize Hangul syllables; every other character is kept as is."""
    out: list[str] = []
    carried = ""  # consonant moved here from the previous syllable's final
    for k, ch in enumerate(text):
        parts = _decompose(ch)
        if parts is None:
            out.append(ch)
            carried = ""
            continue
        initial, medial, final = parts
        onset = carried if initial == _SILENT_INITIAL and carried else _INITIALS[initial]
        coda, carried = _FINALS[final], ""
        nxt = _decompose(text[k + 1]) if k + 1 < len(text) else None
        if final in _LIAISON and nxt is not None and nxt[0] == _SILENT_INITIAL:
            coda, carried = _LIAISON[final]
        out.append(onset + _MEDIALS[medial] + coda)
    return "".join(out)
