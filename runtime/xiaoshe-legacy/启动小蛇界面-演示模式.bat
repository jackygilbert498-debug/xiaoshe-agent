@echo off
rem Xiaoshe UI - Demo Mode (fake model, no API cost, no .env needed)
rem NOTE: keep this file pure ASCII - cmd misparses non-ASCII batch text under chcp 65001.
chcp 65001 >nul
title Xiaoshe UI - Demo Mode (No API)
echo ========================================
echo   Xiaoshe UI - Demo Mode (Fake Model, No API Cost)
echo ========================================
echo.
echo [INFO] Demo mode uses a fake model: no .env, no proxy, no API cost.
echo [INFO] Try: send a message, approval buttons, status panel, screen observatory.
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

rem --- free port 7788 if a stale instance is holding it ---
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:"127.0.0.1:7788" ^| findstr /c:"LISTENING"') do (
    echo [INFO] Port 7788 held by stale process PID %%P - stopping it...
    taskkill /F /PID %%P >nul 2>nul
)

if not exist "logs" mkdir logs
echo [1/2] Starting demo server on port 7788 ...
echo       Browser opens automatically. Close this window to stop the server.
echo       If the browser does not open, the URL is in logs\ui-demo-start.log
echo.
%PY% scripts\serve_demo.py --port 7788 1>logs\ui-demo-start.log 2>&1

if errorlevel 1 goto start_failed

echo.
echo [INFO] Demo server stopped normally.
pause
exit /b 0

:start_failed
echo.
echo [ERROR] Demo mode failed to start. Full output below:
echo ----------------------------------------
type logs\ui-demo-start.log
echo ----------------------------------------
pause
exit /b 1
