"""测试夹具：向指定记忆文件 remember 一条事实（供并发写测试用）。
用法：python _mem_writer.py <memory.json 路径> <事实文本>"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from harness import memory

if __name__ == "__main__":
    memory.remember(sys.argv[2], path=sys.argv[1])
