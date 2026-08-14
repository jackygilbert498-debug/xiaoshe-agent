@echo off
chcp 65001 >nul
title 小蛇 · 你的 agent
set PYTHONUTF8=1
cd /d "%~dp0"
echo.
echo   正在唤醒 小蛇……（想退出就输入  :exit ）
echo.
python run.py
echo.
echo   小蛇 已退出。按任意键关闭这个窗口。
pause >nul
