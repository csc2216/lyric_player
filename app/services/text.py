"""Text normalization shared by lyric alignment and search scoring."""

import unicodedata
from difflib import SequenceMatcher


def normalize_text(text: str) -> str:
    """Lowercase and keep only letters/digits (drops whitespace and punctuation)."""
    text = unicodedata.normalize("NFKC", text).casefold()
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in ("L", "N"))


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
