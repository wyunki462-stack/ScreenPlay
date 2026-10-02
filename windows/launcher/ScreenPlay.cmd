@echo off
rem ScreenPlay portable launcher (zero-toolchain fallback).
rem All real logic lives in launcher\launch.mjs - this file only starts it.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist "resources\node\node.exe" (
  echo [ScreenPlay] resources\node\node.exe is missing.
  echo             Please run prepare-backend.mjs and prepare-frontend.mjs first.
  pause
  exit /b 1
)

"resources\node\node.exe" "launcher\launch.mjs"
set RC=%ERRORLEVEL%

if not "%RC%"=="0" (
  echo.
  echo [ScreenPlay] launcher exited with code %RC%.
  echo             Scroll up for details, or run this file from a terminal to keep the log.
  pause
)

exit /b %RC%