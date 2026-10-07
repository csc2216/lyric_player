// Wrapper around the YouTube IFrame Player API.

let apiPromise = null;

function loadIframeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      apiPromise = null;
      reject(new Error("無法載入 YouTube 播放器（網路問題？）"));
    };
    document.head.append(script);
  });
  return apiPromise;
}

export const PLAYER_ERRORS = {
  2: "影片參數錯誤",
  5: "瀏覽器無法播放這部影片",
  100: "影片不存在或已被移除",
  101: "這部影片不允許嵌入播放",
  150: "這部影片不允許嵌入播放",
};

export class Player {
  /**
   * @param {string} elementId placeholder element replaced by the iframe
   * @param {{onPlayingChange?: (playing: boolean) => void, onError?: (code: number) => void}} handlers
   */
  constructor(elementId, handlers = {}) {
    this.elementId = elementId;
    this.handlers = handlers;
    this.yt = null;
    this.ready = null; // Promise resolved when the player can take commands
    this.videoId = null;
  }

  /** Show a video without autoplaying it. */
  async load(videoId) {
    this.videoId = videoId;
    if (!this.ready) {
      this.ready = loadIframeApi().then(
        (YT) =>
          new Promise((resolve) => {
            this.yt = new YT.Player(this.elementId, {
              videoId,
              width: "100%",
              height: "100%",
              playerVars: { disablekb: 0, rel: 0, modestbranding: 1, playsinline: 1 },
              events: {
                onReady: () => {
                  this.handlers.onReady?.();
                  resolve();
                },
                onStateChange: (e) => this.handlers.onPlayingChange?.(e.data === YT.PlayerState.PLAYING),
                onError: (e) => this.handlers.onError?.(e.data),
              },
            });
          }),
      );
      this.ready.catch(() => {
        this.ready = null;
      });
      return this.ready;
    }
    await this.ready;
    this.handlers.onPlayingChange?.(false);
    this.yt.cueVideoById(videoId);
  }

  get isReady() {
    return Boolean(this.yt?.getPlayerState);
  }

  isPlaying() {
    return this.isReady && this.yt.getPlayerState() === window.YT.PlayerState.PLAYING;
  }

  currentTime() {
    return this.isReady ? this.yt.getCurrentTime() : 0;
  }

  async seekAndPlay(seconds) {
    if (!this.ready) return;
    await this.ready;
    this.yt.seekTo(seconds, true);
    this.yt.playVideo();
  }

  /** Seek without changing play/pause. */
  async seek(seconds) {
    if (!this.ready) return;
    await this.ready;
    this.yt.seekTo(seconds, true);
  }

  /** 0–100, or null before the player exists. */
  getVolume() {
    return this.isReady ? this.yt.getVolume() : null;
  }

  isMuted() {
    return this.isReady ? this.yt.isMuted() : false;
  }

  setVolume(volume, muted) {
    if (!this.isReady) return;
    this.yt.setVolume(volume);
    if (muted) this.yt.mute();
    else this.yt.unMute();
  }

  pause() {
    if (this.isReady) this.yt.pauseVideo();
  }

  stop() {
    if (this.isReady) this.yt.stopVideo();
  }

  togglePlay() {
    if (!this.isReady) return;
    if (this.isPlaying()) this.yt.pauseVideo();
    else this.yt.playVideo();
  }
}
