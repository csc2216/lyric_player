"""Text normalization shared by lyric alignment and search scoring."""

import re
import unicodedata
from difflib import SequenceMatcher

# Trailing alias in brackets: "IU (아이유)", "BTS [방탄소년단]", "周杰倫（Jay Chou）".
# Only at the end, so names like "(G)I-DLE" are left alone.
_TRAILING_ALIAS_RE = re.compile(r"\s*[(\[（【][^()\[\]（）【】]*[)\]）】]\s*$")


def normalize_text(text: str) -> str:
    """Lowercase and keep only letters/digits (drops whitespace and punctuation)."""
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in ("L", "N"))


def strip_alias(name: str) -> str:
    """Drop trailing bracketed aliases/notes: "IU (아이유)" -> "IU". Never returns empty."""
    base = name
    while True:
        stripped = _TRAILING_ALIAS_RE.sub("", base)
        if stripped == base or not stripped.strip():
            return base.strip()
        base = stripped


def same_name(a: str, b: str, threshold: float = 0.85) -> bool:
    """Strict name match: aliases stripped, then equal or very similar.

    Unlike similarity(), containment earns nothing, so a short name like
    "Love" doesn't match every title that happens to contain it.
    """
    na, nb = normalize_text(strip_alias(a)), normalize_text(strip_alias(b))
    if not na or not nb:
        return False
    return na == nb or SequenceMatcher(None, na, nb).ratio() >= threshold


def similarity(a: str, b: str) -> float:
    """0..1 similarity of two strings after normalization."""
    na, nb = normalize_text(a), normalize_text(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ratio = SequenceMatcher(None, na, nb).ratio()
    if na in nb or nb in na:
        # "Song" vs "Song (Remix)": close, but below an exact match.
        ratio = max(ratio, 0.85)
    return ratio
