@echo off
rem Xiaoshe UI - One-click Start (real model, uses active provider API key from .env)
rem NOTE: keep this file pure ASCII - cmd misparses non-ASCII batch text under chcp 65001.
chcp 65001 >nul
title Xiaoshe UI - Starting...
echo ========================================
echo   Xiaoshe UI - One-click Start
echo ========================================
echo.

cd /d "%~dp0"

rem --- locate Python ---
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo [ERROR] Python not found. Install Python 3.10+ and retry.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [ERROR] .env not found. Copy .env.example to .env and fill in the active provider API key.
    pause
    exit /b 1
)

rem --- free port 7788 if a stale instance is holding it ---
rem (Windows allows double-bind with SO_REUSEADDR: an old instance would
rem  hijack half the requests and the page shows "not connected" - kill it.)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:"127.0.0.1:7788" ^| findstr /c:"LISTENING"') do (
    echo [INFO] Port 7788 held by stale process PID %%P - stopping it...
    taskkill /F /PID %%P >nul 2>nul
)

if not exist "logs" mkdir logs
echo [1/2] Starting Xiaoshe UI server on port 7788 ...
echo       Browser opens automatically. Close this window to stop the server.
echo       If the browser does not open, the URL is in logs\ui-start.log
echo.
%PY% run.py serve --port 7788 1>logs\ui-start.log 2>&1

if errorlevel 1 goto start_failed

echo.
echo [INFO] Server stopped normally.
pause
exit /b 0

:start_failed
echo.
echo [ERROR] Server failed to start. Full output below:
echo ----------------------------------------
type logs\ui-start.log
echo ----------------------------------------
echo Common causes: bad active provider API key in .env, broken Python env.
pause
exit /b 1
