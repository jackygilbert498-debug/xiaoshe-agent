"""测试夹具：锁住指定文件一段时间（供跨进程文件锁测试用）。
用法：python _lock_holder.py <目标文件路径> <持锁秒数>
拿到锁后向 stdout 打一行 LOCKED（供主测试进程同步时机）。"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from harness import _io

if __name__ == "__main__":
    target, hold = sys.argv[1], float(sys.argv[2])
    with _io.file_lock(target, timeout=5.0):
        print("LOCKED", flush=True)
        time.sleep(hold)
