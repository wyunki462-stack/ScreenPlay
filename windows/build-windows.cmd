@echo off
chcp 65001 >nul 2>&1
title ScreenPlay Windows Desktop Build
echo ============================================================
echo   ScreenPlay Windows 桌面端 - 一键构建
echo   脚本位置: %~dp0build-windows.ps1
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" %*
set "SCREENPLAY_EXIT=%ERRORLEVEL%"
echo.
if "%SCREENPLAY_EXIT%"=="0" (
  echo [成功] 构建完成，产物目录: %~dp0dist
) else (
  echo [失败] 构建未完成，退出码 %SCREENPLAY_EXIT%
  echo        请查看上方红色错误信息，以及 %~dp0dist 目录下的 build-*.log 日志。
)
echo.
pause
exit /b %SCREENPLAY_EXIT%