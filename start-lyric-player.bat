@echo off
chcp 65001 >nul
rem Double-click (or a desktop shortcut) to start Lyric Player from Windows.
rem Starts the server in WSL, opens the browser, and stops the server when
rem this window is closed. See README / CLAUDE.md for creating the shortcut.
rem Optional argument: --no-browser
cls
title 歌詞播放器
setlocal
if not defined LYRIC_PLAYER_PORT set "LYRIC_PLAYER_PORT=8765"
set "PORT=%LYRIC_PLAYER_PORT%"
set "URL=http://localhost:%PORT%"

rem Already running (e.g. another window or ./run.sh)? Just open the browser.
curl.exe -sf -o nul -m 2 "%URL%/api/library"
if not errorlevel 1 (
  echo 伺服器已在執行：%URL%
  if /i not "%~1"=="--no-browser" start "" "%URL%"
  timeout /t 3 >nul 2>nul
  exit /b 0
)

echo 啟動伺服器中，請稍候…
wsl.exe --cd "%~dp0." -- bash scripts/serve_windows.sh %PORT% %*
echo.
echo 伺服器已停止。
pause
