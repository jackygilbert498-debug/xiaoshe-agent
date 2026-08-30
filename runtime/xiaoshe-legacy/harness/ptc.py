"""基M2 骨架 · PTC（Python Tool Calling）受限解释器 [CaMeL 底座]。

模型写一段脚本、本地跑完多个工具只回 stdout——把「N 步管线 = N 次 Kimi 计费请求」压成 1 轮（按请求/token 计费下最大省钱杠杆）。

**安全是第一位的**（本项目安全最敏感的一块）：
- 绝不 exec/eval 真 Python——纯**树遍历**求值，我方掌控每一步操作。
- **节点白名单，默认拒**：任何不在白名单的 AST 节点一律拒（fail-closed）。
- **禁 import / 属性访问(.) / dunder 标识符**：属性访问是绝大多数沙箱逃逸的入口（__class__/__globals__/
  __subclasses__…），整类禁掉；dunder 名一并禁。
- **命名空间隔离**：无真 builtins、无 globals——脚本只能碰「注入的工具代理」+「一小撮受限内置」+ 自己的局部变量。
- **工具调用经注入的 dispatch 走完整权限管道**（check→approval→taint_gate→execute→污点回记）——
  桩绝不直接调 tools.execute（那会权限裸奔）。
- **步数上限**：防死循环/资源耗尽。

本文件是**骨架**：AST 安全门 + 最小树遍历求值 + dispatch 桩（由调用方注入，尚不接真工具执行/真权限管道）。
接真 _handle_tool_call 管道、无人值守 taint 默认拒、Partial 预填强制吐脚本等留后续增量。
"""
from __future__ import annotations

import ast


class PTCError(Exception):
    """脚本非法（越权语法/逃逸原语/运行期错误）时抛出，带大白话原因。"""


# 语句/表达式白名单——只列「工具胶水脚本」真正需要的安全子集。默认拒：任何不在此的节点 validate 即拒。
# 刻意不含：Import/ImportFrom（禁 import）、Attribute（禁属性访问，防 __class__ 逃逸）、Lambda/FunctionDef/
# ClassDef（禁定义）、ListComp/SetComp/DictComp/GeneratorExp（禁推导式作用域）、With/Try/Global/Nonlocal/
# Delete/Await/Yield/Starred（禁其余复杂/逃逸面）。
_ALLOWED = {
    # 结构 / 语句
    "Module", "Expr", "Assign", "AugAssign", "If", "For", "While", "Pass", "Break", "Continue", "Return",
    # 表达式
    "Constant", "Name", "Call", "keyword", "List", "Tuple", "Dict", "Set",
    "BinOp", "UnaryOp", "BoolOp", "Compare", "Subscript", "Slice", "IfExp", "JoinedStr", "FormattedValue",
    # 上下文 / 运算符（ast.walk 会遍历到这些子节点，必须一并允许）
    "Load", "Store",
    "Add", "Sub", "Mult", "Div", "FloorDiv", "Mod", "Pow", "LShift", "RShift", "BitOr", "BitAnd", "BitXor",
    "USub", "UAdd", "Not", "Invert", "And", "Or",
    "Eq", "NotEq", "Lt", "LtE", "Gt", "GtE", "In", "NotIn", "Is", "IsNot",
}

# 资源上限（红队 HIGH：单节点无界内存分配绕过 step 上限→OOM）。step 按节点计数管不到「一步吃爆内存」，
# 故对结果尺寸另设硬上限：容器/字符串元素数、整数位数。
_MAX_SEQ = 1_000_000       # 字符串/字节/列表等元素数上限
_MAX_INT_BITS = 100_000    # 整数位数上限（~3 万位十进制，够任何合理用途，挡大整数炸弹）


def _guard_size(v):
    """结果尺寸超硬上限即拒（防内存炸弹）。返回原值以便链式使用。"""
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        if v.bit_length() > _MAX_INT_BITS:
            raise PTCError("整数过大（防内存耗尽）")
    elif isinstance(v, (str, bytes)):
        if len(v) > _MAX_SEQ:
            raise PTCError("字符串/字节过长（防内存耗尽）")
    elif isinstance(v, (list, tuple, set, frozenset, dict)):
        if len(v) > _MAX_SEQ:
            raise PTCError("容器过大（防内存耗尽）")
    return v


def _safe_range(*a):
    """range 预检尺寸——别让 list(range(10**9)) 在物化时 OOM（红队 HIGH）。"""
    try:
        r = range(*a)
    except (TypeError, ValueError) as e:
        raise PTCError(f"range 参数非法：{e}")
    if len(r) > _MAX_SEQ:
        raise PTCError("range 过大（防内存耗尽）")
    return r


# 受限内置：只放绝对安全（无文件/网络/eval/反射）的一小撮。刻意不放 open/eval/exec/__import__/getattr/type/…
# range 用预检版；物化类（list/set/dict/sorted/tuple/str/bytes）结果在 _call 里过 _guard_size。
# 字符串/序列助手：PTC 禁属性访问(.split/.splitlines 等方法调不到)，脚本没法处理工具的文本输出（统计/切分/聚合）。
# 以**函数形式**暴露这些纯操作——只对传入的值做计算、拿不到类型对象/反射，无逃逸风险，让 run_script 真能加工工具输出。
def _b_lines(s):
    return str(s).splitlines()


def _b_split(s, sep=None):
    return str(s).split() if sep is None else str(s).split(str(sep))


def _b_strip(s, chars=None):
    return str(s).strip() if chars is None else str(s).strip(str(chars))


def _b_join(sep, seq):
    return str(sep).join(str(x) for x in seq)


_SAFE_BUILTINS = {
    "len": len, "range": _safe_range, "str": str, "int": int, "float": float, "bool": bool,
    "list": list, "dict": dict, "tuple": tuple, "set": set, "min": min, "max": max,
    "sum": sum, "sorted": sorted, "abs": abs, "round": round, "enumerate": enumerate, "zip": zip,
    # 字符串/序列助手（函数形式，替代被禁的属性方法）：
    "lines": _b_lines,                                        # 按行拆（替代 .splitlines）
    "split": _b_split,                                        # 按分隔符拆（替代 .split）
    "strip": _b_strip,                                        # 去首尾空白（替代 .strip）
    "join": _b_join,                                          # 拼接（替代 sep.join）
    "count": lambda s, sub: str(s).count(str(sub)),          # 数子串出现次数（替代 .count）
    "replace": lambda s, a, b: str(s).replace(str(a), str(b)),
    "lower": lambda s: str(s).lower(),
    "upper": lambda s: str(s).upper(),
    "contains": lambda s, sub: str(sub) in str(s),
    "startswith": lambda s, p: str(s).startswith(str(p)),
    "endswith": lambda s, p: str(s).endswith(str(p)),
}


def validate(source: str) -> ast.Module:
    """解析并对全树做白名单安全校验；任何越权语法/逃逸原语 → 抛 PTCError。返回 AST（供求值复用，不重复解析）。"""
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as e:
        raise PTCError(f"脚本语法错误：{e.msg}")
    for node in ast.walk(tree):
        name = type(node).__name__
        if name == "Attribute":
            raise PTCError("禁止属性访问（.）——防 __class__/__globals__/__subclasses__ 类沙箱逃逸")
        if name in ("Import", "ImportFrom"):
            raise PTCError("禁止 import——受限解释器无法引入任何模块")
        if name == "Name" and "__" in node.id:
            raise PTCError(f"禁止 dunder 标识符：{node.id}")
        if name == "Call" and not isinstance(node.func, ast.Name):
            raise PTCError("只能直接调用具名函数/工具，不支持 f()() / x[0]() 这类间接调用（红队修复：防 func.id 裸崩）")
        if name == "keyword" and node.arg is None:
            raise PTCError("禁止 ** 字典解包（红队修复：防 keyword.arg=None 裸 TypeError）")
        if name == "keyword" and node.arg and "__" in node.arg:
            raise PTCError(f"禁止 dunder 关键字参数：{node.arg}")
        if name == "arg" and "__" in node.arg:
            raise PTCError(f"禁止 dunder 参数名：{node.arg}")
        if name not in _ALLOWED:
            raise PTCError(f"不允许的语法：{name}（受限解释器只支持工具调用与简单胶水逻辑）")
    return tree


class _Break(Exception):
    pass


class _Continue(Exception):
    pass


class _Return(Exception):
    def __init__(self, value):
        self.value = value


def run(source: str, dispatch, *, tool_names=(), max_steps: int = 10000) -> str:
    """校验并树遍历执行脚本，返回累计 stdout（print 的内容）。

    dispatch(tool_name, kwargs) 由调用方注入——真实接线时走 _handle_tool_call 完整权限管道；本骨架接桩。
    tool_names：本次允许调用的工具名集合。max_steps：步数上限（防死循环）。
    """
    tree = validate(source)
    tool_names = set(tool_names)
    out: list[str] = []
    env: dict = {}
    steps = [0]

    def tick():
        steps[0] += 1
        if steps[0] > max_steps:
            raise PTCError(f"脚本步数超上限 {max_steps}（防死循环/资源耗尽）")

    def _print(*a):
        out.append(" ".join(str(x) for x in a))

    def ev(node):
        tick()
        t = type(node).__name__
        if t == "Constant":
            return node.value
        if t == "Name":
            if node.id in env:
                return env[node.id]
            raise PTCError(f"未定义变量：{node.id}")
        if t == "List":
            return [ev(e) for e in node.elts]
        if t == "Tuple":
            return tuple(ev(e) for e in node.elts)
        if t == "Set":
            return {ev(e) for e in node.elts}
        if t == "Dict":
            return {ev(k): ev(v) for k, v in zip(node.keys, node.values)}
        if t == "JoinedStr":
            return "".join(str(ev(v)) for v in node.values)
        if t == "FormattedValue":
            return str(ev(node.value))
        if t == "IfExp":
            return ev(node.body) if ev(node.test) else ev(node.orelse)
        if t == "BoolOp":
            vals = node.values
            if isinstance(node.op, ast.And):
                r = True
                for v in vals:
                    r = ev(v)
                    if not r:
                        return r
                return r
            r = False
            for v in vals:
                r = ev(v)
                if r:
                    return r
            return r
        if t == "UnaryOp":
            return _unaryop(node.op, ev(node.operand))
        if t == "BinOp":
            return _binop(node.op, ev(node.left), ev(node.right))
        if t == "Compare":
            left = ev(node.left)
            for op, comp in zip(node.ops, node.comparators):
                right = ev(comp)
                if not _cmp(op, left, right):
                    return False
                left = right
            return True
        if t == "Subscript":
            return ev(node.value)[_subscript_index(node.slice)]
        if t == "Call":
            return _call(node)
        raise PTCError(f"求值不支持的表达式：{t}")

    def _subscript_index(sl):
        if type(sl).__name__ == "Slice":
            lo = ev(sl.lower) if sl.lower else None
            hi = ev(sl.upper) if sl.upper else None
            st = ev(sl.step) if sl.step else None
            return slice(lo, hi, st)
        return ev(sl)   # py3.9+ 直接是表达式

    def _call(node):
        # validate 已保证 node.func 是 Name（禁 Attribute），故 func.id 安全
        fname = node.func.id
        kwargs = {kw.arg: ev(kw.value) for kw in node.keywords}
        if fname in tool_names:
            if node.args:   # 工具只收命名参数（对齐工具 schema），杜绝位置歧义
                raise PTCError(f"工具 {fname} 只接受命名参数，如 {fname}(path=...)")
            return dispatch(fname, kwargs)   # → 注入的权限管道（真实接线走 _handle_tool_call）
        if fname == "print":
            _print(*[ev(a) for a in node.args])
            return None
        if fname in _SAFE_BUILTINS:
            try:
                return _guard_size(_SAFE_BUILTINS[fname](*[ev(a) for a in node.args], **kwargs))
            except MemoryError:
                raise PTCError(f"{fname}(...) 触发内存耗尽，已阻止")
        raise PTCError(f"未知函数：{fname}（只能调本次允许的工具、print 或受限内置）")

    def assign(target, value):
        tt = type(target).__name__
        if tt == "Name":
            if "__" in target.id:
                raise PTCError(f"禁止 dunder 标识符：{target.id}")
            env[target.id] = value
        elif tt in ("Tuple", "List"):
            vals = list(value)
            if len(vals) != len(target.elts):
                raise PTCError("解包数量不匹配")
            for tgt, v in zip(target.elts, vals):
                assign(tgt, v)
        else:
            raise PTCError(f"不支持的赋值目标：{tt}")

    def exe(stmts):
        for node in stmts:
            tick()
            t = type(node).__name__
            if t == "Expr":
                ev(node.value)
            elif t == "Assign":
                v = ev(node.value)
                for tgt in node.targets:
                    assign(tgt, v)
            elif t == "AugAssign":
                cur = env.get(node.target.id) if type(node.target).__name__ == "Name" else None
                if type(node.target).__name__ != "Name" or node.target.id not in env:
                    raise PTCError("增强赋值目标须是已定义的简单变量")
                env[node.target.id] = _binop(node.op, cur, ev(node.value))
            elif t == "If":
                exe(node.body if ev(node.test) else node.orelse)
            elif t == "For":
                for item in ev(node.iter):
                    assign(node.target, item)
                    try:
                        exe(node.body)
                    except _Break:
                        break
                    except _Continue:
                        continue
                else:
                    exe(node.orelse)
            elif t == "While":
                while ev(node.test):
                    try:
                        exe(node.body)
                    except _Break:
                        break
                    except _Continue:
                        continue
                else:
                    exe(node.orelse)
            elif t == "Pass":
                pass
            elif t == "Break":
                raise _Break()
            elif t == "Continue":
                raise _Continue()
            elif t == "Return":
                raise _Return(ev(node.value) if node.value else None)
            else:
                raise PTCError(f"执行不支持的语句：{t}")

    try:
        exe(tree.body)
    except _Return:
        pass
    except (_Break, _Continue):   # 红队修复：循环外 break/continue 别作为内部哨兵异常逃出 run()
        raise PTCError("break/continue 不在循环内")
    return "\n".join(out)


_BINOPS = {
    "Add": lambda a, b: a + b, "Sub": lambda a, b: a - b, "Mult": lambda a, b: a * b,
    "Div": lambda a, b: a / b, "FloorDiv": lambda a, b: a // b, "Mod": lambda a, b: a % b,
    "Pow": lambda a, b: a ** b, "LShift": lambda a, b: a << b, "RShift": lambda a, b: a >> b,
    "BitOr": lambda a, b: a | b, "BitAnd": lambda a, b: a & b, "BitXor": lambda a, b: a ^ b,
}
_CMPS = {
    "Eq": lambda a, b: a == b, "NotEq": lambda a, b: a != b, "Lt": lambda a, b: a < b,
    "LtE": lambda a, b: a <= b, "Gt": lambda a, b: a > b, "GtE": lambda a, b: a >= b,
    "In": lambda a, b: a in b, "NotIn": lambda a, b: a not in b,
    "Is": lambda a, b: a is b, "IsNot": lambda a, b: a is not b,
}


def _is_int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def _binop(op, a, b):
    opn = type(op).__name__
    fn = _BINOPS.get(opn)
    if not fn:
        raise PTCError(f"不支持的运算符：{opn}")
    # 预检：别真算出内存炸弹再检查（红队 HIGH——单步无界分配绕过 step 上限）。
    if opn == "Mult":
        if isinstance(a, (str, bytes, list, tuple)) and _is_int(b) and len(a) * max(b, 0) > _MAX_SEQ:
            raise PTCError("乘法结果过大（防内存耗尽）")
        if isinstance(b, (str, bytes, list, tuple)) and _is_int(a) and len(b) * max(a, 0) > _MAX_SEQ:
            raise PTCError("乘法结果过大（防内存耗尽）")
        if _is_int(a) and _is_int(b) and a.bit_length() + b.bit_length() > _MAX_INT_BITS:
            raise PTCError("整数乘法结果过大（防内存耗尽）")
    elif opn == "Pow":
        if _is_int(b) and b > 1000:
            raise PTCError("幂运算指数过大（防内存耗尽）")
        if _is_int(a) and _is_int(b) and a and a.bit_length() * max(b, 0) > _MAX_INT_BITS:
            raise PTCError("幂运算结果过大（防内存耗尽）")
    elif opn == "LShift":
        if _is_int(a) and _is_int(b) and a and a.bit_length() + max(b, 0) > _MAX_INT_BITS:
            raise PTCError("移位结果过大（防内存耗尽）")
    elif opn == "Add":
        if isinstance(a, (str, bytes, list, tuple)) and isinstance(b, (str, bytes, list, tuple)) \
                and len(a) + len(b) > _MAX_SEQ:
            raise PTCError("拼接结果过大（防内存耗尽）")
    try:
        return _guard_size(fn(a, b))   # 兜底：% 格式化等难预判的也事后查 + MemoryError 转 PTCError
    except MemoryError:
        raise PTCError("运算触发内存耗尽，已阻止")


def _cmp(op, a, b):
    fn = _CMPS.get(type(op).__name__)
    if not fn:
        raise PTCError(f"不支持的比较：{type(op).__name__}")
    return fn(a, b)


def _unaryop(op, v):
    n = type(op).__name__
    if n == "USub":
        return -v
    if n == "UAdd":
        return +v
    if n == "Not":
        return not v
    if n == "Invert":
        return ~v
    raise PTCError(f"不支持的一元运算：{n}")
