#!/bin/bash
# Mac 双击启动器（对标 Windows 的 唤醒Harness.bat）。
# 双击本文件，Finder 会用「终端」打开它并唤醒小蛇。想退出就在小蛇里输入 :exit
cd "$(dirname "$0")" || exit 1
echo
echo "  正在唤醒 小蛇……（想退出就输入  :exit ）"
echo
python3 run.py
echo
echo "  小蛇 已退出。按回车键关闭这个窗口。"
read -r
