from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    translator_backend: Literal["claude_cli", "api"] = "claude_cli"
    # Command or full path for the claude_cli backend. Set a full path when the
    # server's (non-login) shell can't find `claude`, e.g. npm/nvm installs.
    claude_cli_path: str = "claude"
    anthropic_api_key: str = ""
    translate_model: str = "claude-sonnet-5-5"
    library_dir: Path = Path("./library")
    port: int = 8765
    video_preference: Literal["sync", "mv"] = "sync"

    # ---- access for other devices (via `tailscale serve`) ----
    # Tailscale login of the owner (full access from any of their devices).
    owner_login: str = ""
    # PIN for visitors whose requests carry no Tailscale identity. Empty = no visitors without identity.
    guest_pin: str = ""
    # New songs each visitor may build per day (uses the owner's translation quota).
    guest_daily_builds: int = 10
    # Server-side state that isn't the song library (visitor sessions, build counters).
    data_dir: Path = Path("./data")


settings = Settings()
