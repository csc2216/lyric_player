// "建立" flow: resolve -> (auto build | candidate picker) -> build.

import * as api from "./api.js";
import { formatTime } from "./sync.js";
import { button, el, status } from "./ui.js";

/**
 * @param {object} opts
 * @param {(res: object) => Promise<void>} opts.onBuilt called with the build response
 * @param {() => string|null} opts.blockedReason why creating is unavailable right now (offline), or null
 * @param {() => void} opts.afterAttempt e.g. refresh the visitor's remaining builds
 */
export function setupCreate({ onBuilt, blockedReason = () => null, afterAttempt = () => {} }) {
  const form = document.getElementById("create-form");
  const input = document.getElementById("create-input");
  const submit = document.getElementById("create-button");
  const box = document.getElementById("candidates");
  let busy = false;

  const setBusy = (value) => {
    busy = value;
    submit.disabled = value;
    input.disabled = value;
    for (const b of box.querySelectorAll("button.choose")) b.disabled = value || b.dataset.novideo === "1";
  };

  const hideCandidates = () => {
    box.hidden = true;
    box.replaceChildren();
  };

  async function buildSong(candidate) {
    setBusy(true);
    status.set(
      "busy",
      `翻譯中：${candidate.artist_name} – ${candidate.track_name}（${candidate.line_count} 行，約需 5–10 秒）`,
    );
    try {
      const res = await api.build(candidate.id, candidate.video.video_id);
      hideCandidates();
      input.value = "";
      if (res.created === false) status.set("info", "這首歌已經在歌曲庫裡，直接載入。");
      else if (res.missing_translations.length) {
        status.set("error", `完成，但有 ${res.missing_translations.length} 行翻譯失敗（留空，可雙擊補上或按 ↻ 重翻）。`);
      } else status.set("ok", "完成！點任一行歌詞開始播放。");
      await onBuilt(res);
    } catch (err) {
      status.set("error", `建立失敗：${err.message}`);
    } finally {
      setBusy(false);
      afterAttempt();
    }
  }

  function showCandidates(res) {
    const head = el("div", "candidates-head");
    head.append(
      el("h2", "", "選擇要建立的歌曲"),
      button("取消", "small", () => {
        hideCandidates();
        status.hide();
      }),
    );
    const why = el("details", "reason");
    why.append(el("summary", "", "為什麼沒有自動建立？"), el("code", "", res.reason));
    box.replaceChildren(head, why);

    res.candidates.forEach((c, i) => {
      const card = el("article", "candidate");
      const title = el("div", "cand-title");
      title.append(el("strong", "", `${c.artist_name} – ${c.track_name}`));
      if (i === 0) title.append(el("span", "tag accent", "推薦"));
      card.append(title);

      const meta = [formatTime(c.duration), c.synced ? "同步歌詞" : "無同步（只有純文字）", `${c.line_count} 行`];
      if (c.album_name) meta.push(c.album_name);
      const metaEl = el("div", "cand-meta", meta.join(" · "));
      if (!c.duration_ok) metaEl.append(el("span", "tag warn", "時長資料可疑"));
      if (!c.synced) metaEl.classList.add("warn-text");
      card.append(metaEl);

      const preview = el("div", "cand-preview");
      for (const line of c.preview) preview.append(el("div", "", line));
      card.append(preview);

      const videoRow = el("div", "cand-video");
      if (c.video) {
        videoRow.append(videoThumb(c.video.video_id));
        const info = el("div", "video-info");
        info.append(el("div", "video-title", c.video.title || c.video.video_id));
        const diff = c.video.duration_diff;
        const diffText = diff === null ? "" : `（${diff >= 0 ? "+" : ""}${Math.round(diff)} 秒）`;
        const vmeta = el("div", "video-meta", `${c.video.channel} · ${formatTime(c.video.duration)}${diffText}`);
        if (diff !== null && Math.abs(diff) > 3) vmeta.classList.add("warn-text");
        info.append(vmeta);
        videoRow.append(info);
      } else {
        videoRow.append(el("div", "warn-text", "找不到配對的 YouTube 影片"));
      }
      card.append(videoRow);

      const choose = button("用這個建立", "choose", () => {
        if (!busy) buildSong(c);
      });
      if (!c.video) {
        choose.disabled = true;
        choose.dataset.novideo = "1";
      }
      card.append(choose);
      box.append(card);
    });
    box.hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query || busy) return;
    const blocked = blockedReason();
    if (blocked) {
      status.set("error", blocked);
      return;
    }
    hideCandidates();
    setBusy(true);
    status.set("busy", "搜尋中：在 LRCLIB 找歌詞、在 YouTube 找影片…");
    try {
      const res = await api.resolve(query);
      console.debug("resolve", res.reason, res);
      if (!res.candidates.length) {
        status.set("error", `找不到「${query}」的歌詞，試試「歌手 - 歌名」的格式。`);
        return;
      }
      const pick = res.candidates[0];
      if (res.auto_ok && pick.video) {
        setBusy(false);
        await buildSong(pick);
      } else {
        status.set("info", `找到 ${res.candidates.length} 個候選，請選一個。`);
        showCandidates(res);
      }
    } catch (err) {
      status.set("error", `搜尋失敗：${err.message}`);
    } finally {
      setBusy(false);
    }
  });
}

export function videoThumb(videoId) {
  const img = el("img", "thumb");
  img.src = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
  img.alt = "";
  img.loading = "lazy";
  return img;
}
