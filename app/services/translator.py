"""Line-by-line lyric translation to Taiwanese Traditional Chinese.

Two backends share the same dedupe / validation / retry logic:
- claude_cli: `claude -p` subprocess, uses the Claude subscription login
- api: Anthropic Python SDK, uses ANTHROPIC_API_KEY
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Protocol

from app.config import settings

# Bump whenever SYSTEM_PROMPT or the message format changes.
PROMPT_VERSION = 1
MAX_TOKENS = 8000
TIMEOUT = 120.0
CLI_TIMEOUT = 120.0

SYSTEM_PROMPT = """你是專業的歌詞譯者，負責把歌詞逐行翻譯成台灣慣用的繁體中文。

規則：
- 使用台灣慣用的繁體中文用語，自然口語、讀起來像歌詞，不要逐字直譯。
- 英文句子也要翻譯。純擬聲或沒有實際意義的 ad-lib（例如 ooh、la la、yeah）保留原樣或極簡處理。
- 參考完整歌詞理解上下文，但只翻譯清單中列出的行。
- 每個 id 都必須有對應的翻譯，不可合併或拆分行，不可遺漏。
- 只輸出 JSON，格式為 {"translations": [{"id": 0, "tr": "翻譯"}]}，不要 markdown code fence，不要任何其他文字。"""

_FENCE_RE = re.compile(r"^\s*```[a-zA-Z]*\s*\n?|\n?\s*```\s*$")


class TranslatorError(Exception):
    pass


@dataclass
class TranslationResult:
    # line index -> translation, for every requested line ("" if it failed)
    translations: dict[int, str]
    # line indices that still had no translation after the retry
    missing: list[int] = field(default_factory=list)


def dedupe(texts: list[str], indices: list[int]) -> tuple[list[str], dict[int, int]]:
    """Unique texts (first-seen order) and a map line index -> unique id."""
    unique: list[str] = []
    id_of_text: dict[str, int] = {}
    id_of_line: dict[int, int] = {}
    for i in indices:
        key = texts[i].strip()
        if key not in id_of_text:
            id_of_text[key] = len(unique)
            unique.append(key)
        id_of_line[i] = id_of_text[key]
    return unique, id_of_line


def build_user_message(full_lyrics: list[str], items: dict[int, str]) -> str:
    payload = json.dumps(
        [{"id": i, "text": t} for i, t in items.items()], ensure_ascii=False, indent=0
    )
    return (
        "完整歌詞（僅供理解上下文）：\n"
        + "\n".join(full_lyrics)
        + "\n\n請翻譯以下各行，每個 id 都要有翻譯：\n"
        + payload
    )


def strip_fence(text: str) -> str:
    return _FENCE_RE.sub("", text.strip()).strip()


def parse_response(text: str) -> dict[int, str]:
    """Parse model output into id -> translation. Lenient; returns {} if unusable."""
    body = strip_fence(text)
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        start, end = body.find("{"), body.rfind("}")
        if start == -1 or end <= start:
            return {}
        try:
            data = json.loads(body[start : end + 1])
        except json.JSONDecodeError:
            return {}
    items = data.get("translations") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return {}
    result: dict[int, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            item_id = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        tr = item.get("tr")
        if isinstance(tr, str) and tr.strip():
            result[item_id] = tr.strip()
    return result


class Backend(Protocol):
    """Sends one system + user message to a model and returns the reply text."""

    model: str

    def complete(self, system: str, user_message: str) -> str: ...


class ApiBackend:
    """Anthropic API via the Python SDK (needs ANTHROPIC_API_KEY)."""

    def __init__(self, client=None, model: str | None = None):
        self.model = model or settings.translate_model
        self._client = client

    def _get_client(self):
        if self._client is None:
            import anthropic

            if not settings.anthropic_api_key:
                raise TranslatorError(
                    "未設定 ANTHROPIC_API_KEY（請在 .env 設定，或改用 TRANSLATOR_BACKEND=claude_cli）"
                )
            self._client = anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=TIMEOUT)
        return self._client

    def complete(self, system: str, user_message: str) -> str:
        import anthropic

        try:
            response = self._get_client().messages.create(
                model=self.model,
                max_tokens=MAX_TOKENS,
                system=system,
                messages=[{"role": "user", "content": user_message}],
            )
        except anthropic.APITimeoutError as e:
            raise TranslatorError("翻譯 API 逾時") from e
        except anthropic.APIError as e:
            raise TranslatorError(f"翻譯 API 呼叫失敗：{e}") from e
        return "".join(block.text for block in response.content if block.type == "text")


class ClaudeCliBackend:
    """`claude -p` (Claude Code CLI), billed to the logged-in Claude subscription."""

    def __init__(self, model: str | None = None, executable: str | None = None, timeout: float = CLI_TIMEOUT):
        self.model = model or settings.translate_model
        self.executable = executable or settings.claude_cli_path
        self.timeout = timeout

    def command(self, system: str) -> list[str]:
        return [
            self.executable,
            "-p",
            "--output-format", "json",
            "--model", self.model,
            "--system-prompt", system,
            "--tools", "",  # plain completion, no agent tools
            "--no-session-persistence",
            "--strict-mcp-config",
            "--setting-sources", "",  # ignore user/project settings and hooks
        ]

    def complete(self, system: str, user_message: str) -> str:
        path = shutil.which(self.executable)
        if not path:
            raise TranslatorError(
                f"找不到 {self.executable} 指令：請在 WSL 安裝 Claude Code 並登入（執行一次 claude）；"
                "已安裝的話，在 .env 設定 CLAUDE_CLI_PATH 為完整路徑（在終端機執行 which claude 查詢），"
                "或把 TRANSLATOR_BACKEND 設為 api"
            )
        # Without ANTHROPIC_API_KEY the CLI uses the subscription login.
        env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
        cmd = self.command(system)
        cmd[0] = path
        try:
            # Empty cwd so no CLAUDE.md gets pulled into the context.
            with tempfile.TemporaryDirectory(prefix="lyric-translate-") as cwd:
                proc = subprocess.run(
                    cmd,
                    input=user_message,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=self.timeout,
                    env=env,
                    cwd=cwd,
                )
        except subprocess.TimeoutExpired as e:
            raise TranslatorError(f"claude CLI 逾時（{self.timeout:.0f} 秒）") from e
        except OSError as e:
            raise TranslatorError(f"無法執行 claude CLI：{e}") from e
        try:
            data = json.loads(proc.stdout)
        except json.JSONDecodeError as e:
            detail = (proc.stderr or proc.stdout).strip()[:300]
            raise TranslatorError(f"claude CLI 輸出無法解析（exit {proc.returncode}）：{detail}") from e
        if not isinstance(data, dict):
            raise TranslatorError("claude CLI 輸出格式不符")
        if data.get("is_error") or proc.returncode != 0:
            raise TranslatorError(f"claude CLI 錯誤：{data.get('result') or proc.stderr.strip()[:300]}")
        return data.get("result") or ""


def make_backend(name: str | None = None) -> Backend:
    name = name or settings.translator_backend
    if name == "api":
        return ApiBackend()
    if name == "claude_cli":
        return ClaudeCliBackend()
    raise TranslatorError(f"未知的 TRANSLATOR_BACKEND：{name}（可用 claude_cli 或 api）")


def translate(
    texts: list[str],
    line_indices: list[int] | None = None,
    backend: Backend | None = None,
) -> TranslationResult:
    """Translate the given lines (default: all) with the whole song as context.

    Repeated lines are translated once and the result copied to each occurrence.
    Missing ids are retried once; lines still missing get "".
    """
    if line_indices is None:
        line_indices = list(range(len(texts)))
    if not line_indices:
        return TranslationResult({})
    backend = backend or make_backend()

    unique, id_of_line = dedupe(texts, line_indices)
    pending = dict(enumerate(unique))
    done: dict[int, str] = {}
    for _attempt in range(2):
        reply = backend.complete(SYSTEM_PROMPT, build_user_message(texts, pending))
        parsed = parse_response(reply)
        done.update({i: tr for i, tr in parsed.items() if i in pending})
        pending = {i: t for i, t in pending.items() if i not in done}
        if not pending:
            break

    translations = {line: done.get(uid, "") for line, uid in id_of_line.items()}
    missing = [line for line, uid in id_of_line.items() if uid not in done]
    return TranslationResult(translations, missing)
