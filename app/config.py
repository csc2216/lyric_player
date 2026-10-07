from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    anthropic_api_key: str = ""
    translate_model: str = "claude-sonnet-5-5"
    library_dir: Path = Path("./library")
    port: int = 8765


settings = Settings()
