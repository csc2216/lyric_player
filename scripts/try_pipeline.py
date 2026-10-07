"""Run the full pipeline against real services without saving.

Usage: uv run python scripts/try_pipeline.py "歌手 - 歌名" [--lines 5] [--no-translate]
"""

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.services.lrc_parser import build_lines  # noqa: E402
from app.services.lrclib import LrclibClient, LrclibError  # noqa: E402
from app.services.translator import TranslatorError, translate  # noqa: E402
from app.services.youtube import (  # noqa: E402
    MAX_ALTERNATIVES,
    YoutubeError,
    merge_entries,
    needs_fallback,
    rank_videos,
    search_entries,
)

# LRCLIB candidates within this score of the top one count as the same song;
# among them, pick the one whose duration best matches a YouTube video.
# (Will move into /api/resolve in M2.)
TIE_SCORE_MARGIN = 0.02


def fmt_time(t: float | None) -> str:
    if t is None:
        return "  --:--.--"
    return f"{int(t // 60):3d}:{t % 60:05.2f}"


def fmt_duration(d: float | None) -> str:
    return "?" if d is None else f"{d:.0f}s"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("query")
    parser.add_argument("--lines", type=int, default=5, help="how many lyric lines to print")
    parser.add_argument("--no-translate", action="store_true")
    args = parser.parse_args()

    print(f"== LRCLIB: {args.query}")
    try:
        with LrclibClient() as client:
            candidates = client.search(args.query)
    except LrclibError as e:
        print(f"錯誤：{e}")
        return 1
    if not candidates:
        print("找不到歌詞")
        return 1
    top = candidates[0]
    tied = [
        c
        for c in candidates
        if (c.has_synced, c.duration_ok) == (top.has_synced, top.duration_ok)
        and c.score >= top.score - TIE_SCORE_MARGIN
    ]

    pref = settings.video_preference

    def pair(entries):
        ranked = {c.id: rank_videos(entries, c.artist_name, c.track_name, c.duration, pref) for c in tied}
        best = max(tied, key=lambda c: ranked[c.id][0].score if ranked[c.id] else float("-inf"))
        return best, ranked[best.id]

    yt_note = ""
    try:
        entries = search_entries(f"{top.artist_name} {top.track_name}")
        best, ranked = pair(entries)
        if needs_fallback(ranked, best.duration):
            entries = merge_entries(entries, search_entries(args.query))
            best, ranked = pair(entries)
            yt_note = f"（LRCLIB 名稱搜尋結果時長差 > 5 秒，已加搜「{args.query}」）"
    except YoutubeError as e:
        print(f"錯誤：{e}")
        best, ranked = tied[0], []
    videos = ranked[:MAX_ALTERNATIVES]

    for c in candidates[:8]:
        mark = "*" if c is best else " "
        kind = "synced" if c.has_synced else "plain "
        flags = "" if c.duration_ok else " 時長<歌詞"
        print(
            f" {mark} [{c.id}] {c.artist_name} - {c.track_name}"
            f" | {c.album_name or '-'} | {fmt_duration(c.duration)} | {kind} | score={c.score:.3f}{flags}"
        )
    if len(candidates) > 8:
        print(f"   …共 {len(candidates)} 筆")
    print(f"   （同分候選 {len(tied)} 筆，依 YouTube 時長配對選出 *）")

    result = build_lines(best.synced_lyrics, best.plain_lyrics)
    n_breaks = sum(line.break_before for line in result.lines)
    print(
        f"\n== 歌詞：{len(result.lines)} 行，synced={result.synced}，"
        f"段落來源={result.break_source}，段落數={n_breaks + 1 if result.lines else 0}"
    )

    print(f"\n== YouTube（preference={pref}，目標時長 {fmt_duration(best.duration)}）{yt_note}")
    for i, v in enumerate(videos):
        mark = "*" if i == 0 else " "
        diff = (
            f"{v.video.duration - best.duration:+.0f}s"
            if v.video.duration is not None and best.duration is not None
            else "?"
        )
        print(
            f" {mark} {v.video.video_id} | {v.video.title} | {v.video.channel}"
            f" | {fmt_duration(v.video.duration)} ({diff}) | score={v.score:.0f}"
        )

    lines = result.lines
    if not args.no_translate and lines:
        print(f"\n== 翻譯（{settings.translator_backend} / {settings.translate_model}，全曲 {len(lines)} 行）")
        started = time.monotonic()
        try:
            tr = translate([line.text for line in lines])
        except TranslatorError as e:
            print(f"錯誤：{e}（{time.monotonic() - started:.1f} 秒）")
        else:
            n_ok = len(tr.translations) - len(tr.missing)
            print(f"   完成：{n_ok}/{len(lines)} 行，耗時 {time.monotonic() - started:.1f} 秒")
            for i, line in enumerate(lines):
                line.tr = tr.translations.get(i, "")
            if tr.missing:
                print(f"   缺翻譯的行：{tr.missing}")

    print(f"\n== 前 {args.lines} 行")
    for line in lines[: args.lines]:
        if line.break_before:
            print()
        print(f"{fmt_time(line.t)}  {line.text}")
        if line.tr:
            print(f"{'':10}  {line.tr}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
