"""UI 契约层（M0 地基）：枚举清单 + 38 工具元数据表 + 入参校验器。

纪律（SPEC v2 §5）：
- 零依赖（不 import 任何 harness 模块），前后端共用同一份枚举——前端镜像在 ui/js/lib/enums.js，
  tests/ui_contract/validate_contract.py 比对两份逐字相同（枚举封闭校验）。
- TOOL_META 覆盖注册表 38 个工具；注册表出现表外工具时 category=misc / rule=bare 且校验脚本报警（R9 防漂移）。
"""
from __future__ import annotations

from copy import deepcopy

# ---------------------------------------------------------------- 契约枚举（与 ui/js/lib/enums.js 逐字一致）

ENUMS = {
    "ROLE": ["user", "assistant", "tool", "system"],
    "EVENT_TYPE": [
        "session.snapshot", "message.append", "tool_call.start", "tool_call.end",
        "approval.request", "approval.resolved", "state.patch", "compaction.event",
        "viewport.update", "job.update", "subagent.update", "system.alert",
        "send", "approve", "cancel", "command", "vision_pending.remove",
    ],
    "TASK_EVENT_TYPE": [
        "task.created", "task.definition_updated", "task.transitioned",
        "run.started", "run.finished", "action.started", "action.finished",
        "plan.proposed", "plan.reviewed", "plan.superseded",
        "run.preflight_stopped", "run.deviation_blocked", "run.stop_requested",
        "run.steered", "run.stopped", "question.asked", "question.answered",
        "changeset.captured", "changeset.stale", "review.recorded",
        "verification.started", "verification.check_finished", "verification.finished", "task.completed",
        "workspace.reserved", "workspace.ready", "workspace.marked", "checkpoint.created",
        "recovery.previewed", "recovery.started", "recovery.finished", "task.related", "task.forked",
    ],
    "TASK_STATUS": [
        "Draft", "Planning", "AwaitingPlanApproval", "Ready", "Running", "WaitingUser",
        "Review", "Verifying", "Succeeded", "Failed", "Cancelled", "Archived",
    ],
    "DECISION": ["y", "n", "a", "p"],
    "PERMISSION": ["allow", "ask", "deny"],
    "TOOL_STATUS": ["ok", "error", "denied"],
    "CATEGORY": ["file", "process", "memory", "vision", "web", "subagent", "sandbox", "misc"],
    "KEY_RULE": ["path", "command", "coords", "bare"],
    "MARK_SOURCE": ["uia", "ocr", "uia+ocr"],
    "JOB_STATUS": ["running", "done", "interrupted", "failed"],
    "SUBAGENT_STATUS": ["running", "done", "failed"],
    "DIFF_STATUS": ["effective", "suspected_noop", "unknown"],
    "COMPACTION_KIND": ["auto_compact", "force_compact", "emergency_truncate", "tool_result_clearing"],
    "ZONE": ["目标", "决策", "现状", "待解", "已完成", "其它"],
    "ALERT_LEVEL": ["info", "warn", "error"],
    "APPROVAL_SCOPE": ["session", "persist"],
    "COMMAND_NAME": [
        "todos", "memory", "skills", "notes", "effects", "undo", "clear", "help",
        "recall", "recall_subagent", "sessions", "resume",
    ],
}

# ---------------------------------------------------------------- 工具元数据（38）

_KEY_RULE_PATH = {"write_file", "edit"}
_KEY_RULE_COMMAND = {"run_command", "run_in_background", "run_script"}
_KEY_RULE_COORDS = {"click_at", "pick"}
PERSISTABLE = {"write_file", "edit", "run_command", "run_in_background", "run_script"}
# permission._TAINT_HIGH_RISK（12）的静态镜像；mcp__ 前缀高危由服务端运行时并集
TAINT_HIGH_RISK = [
    "click", "click_at", "edit", "focus_window", "pick", "press_keys",
    "propose_tool", "run_command", "run_in_background", "screenshot", "type_text", "write_file",
]

# name -> (category, icon, arg_format)
# arg_format 模板：{arg} 原值、{arg.len} 长度；前端只做替换不 eval。
TOOL_META = {
    "write_file":        ("file", "file-pen", "path: {path}，内容长度: {content.len}"),
    "edit":              ("file", "file-edit", "path: {path}，替换 {old_string.len} → {new_string.len} 字符"),
    "read_file":         ("file", "file-read", "path: {path}"),
    "glob":              ("file", "search-files", "pattern: {pattern}"),
    "grep":              ("file", "search-text", "pattern: {pattern}，path: {path}"),
    "run_command":       ("process", "terminal", "command: {command}"),
    "run_in_background": ("process", "clock-bg", "command: {command}"),
    "check_background":  ("process", "eye", "job_id: {job_id}"),
    "list_background":   ("process", "list", "（无参数）"),
    "run_script":        ("process", "scroll-code", "script 长度: {script.len}"),
    "run_sandboxed":     ("sandbox", "shield-play", "code 长度: {code.len}，timeout: {timeout}"),
    "propose_tool":      ("sandbox", "tool-plus", "name: {name}"),
    "update_todos":      ("memory", "list-check", "{todos.len} 条待办"),
    "note":              ("memory", "notebook", "{content.len} 字符笔记"),
    "remember":          ("memory", "brain", "zone: {zone}，{fact.len} 字符"),
    "note_tip":          ("memory", "zap", "{tip.len} 字符小招"),
    "recall":            ("memory", "hook", "ref: {ref}"),
    "observe":           ("vision", "window", "include_screenshot: {include_screenshot}"),
    "look":              ("vision", "eye-screen", "（无参数）"),
    "zoom":              ("vision", "zoom-in", "viewport: {viewport_id}，mark_no: {mark_no}"),
    "list_windows":      ("vision", "windows", "（无参数）"),
    "focus_window":      ("vision", "focus", "title: {title}"),
    "click":             ("vision", "cursor", "uid: {uid}"),
    "click_at":          ("vision", "cursor-xy", "({x}, {y})"),
    "pick":              ("vision", "target", "viewport: {viewport_id}，mark_no: {mark_no}"),
    "screenshot":        ("vision", "camera", "path: {path}"),
    "press_keys":        ("vision", "keyboard", "keys: {keys}"),
    "type_text":         ("vision", "type", "text: {text.len} 字符"),
    "ocr":               ("vision", "ocr", "path: {path}"),
    "read_image":        ("vision", "image", "path: {path}"),
    "render_check":      ("vision", "render", "path: {path}，keywords: {keywords}"),
    "web_fetch":         ("web", "globe", "url: {url}"),
    "web_search":        ("web", "search-web", "query: {query}"),
    "spawn_subagent":    ("subagent", "user-plus", "task: {task.len} 字符"),
    "spawn_parallel":    ("subagent", "users", "{subtasks.len} 个子任务并行"),
    "recall_subagent":   ("subagent", "user-search", "ref_id: {ref_id}"),
    "save_skill":        ("misc", "bookmark-plus", "name: {name}"),
    "read_skill":        ("misc", "bookmark", "name: {name}"),
}

CATEGORY_LABEL = {
    "file": "文件", "process": "进程", "memory": "记忆", "vision": "视觉",
    "web": "网络", "subagent": "分身", "sandbox": "沙箱", "misc": "杂项",
}


def key_rule(name: str) -> str:
    if name in _KEY_RULE_PATH:
        return "path"
    if name in _KEY_RULE_COMMAND:
        return "command"
    if name in _KEY_RULE_COORDS:
        return "coords"
    return "bare"


def tool_meta(name: str) -> dict:
    """查单个工具的展示元数据；表外工具（mcp__/自定义）回落 misc/bare（R9：端点运行时枚举不写死）。"""
    cat, icon, fmt = TOOL_META.get(name, ("misc", "tool", "{args}"))
    return {"category": cat, "icon": icon, "arg_format": fmt,
            "approval_key_rule": key_rule(name),
            "persistable": name in PERSISTABLE,
            "taint_high_risk": name in TAINT_HIGH_RISK or name.startswith("mcp__")}


# ---------------------------------------------------------------- 入参校验器（SPEC §5-3）

class SchemaError(ValueError):
    """入参不合契约；message 给人看，hint 给修复指引。"""

    def __init__(self, message: str, hint: str = ""):
        super().__init__(message)
        self.message = message
        self.hint = hint


def check(payload, schema: dict, where: str = "payload") -> None:
    """迷你 schema 校验：{"field": {"type": str|int|bool|dict|list, "required": True,
    "enum": [...], "max_len": N, "one_of": [...]}}。全部 WS/REST 入参先过它再进 harness API（SPEC §7-S5）。
    """
    if not isinstance(payload, dict):
        raise SchemaError(f"{where} 必须是 JSON 对象", "检查请求体是否为合法 JSON object")
    for field, rule in schema.items():
        present = field in payload and payload[field] is not None
        if not present:
            if rule.get("required"):
                raise SchemaError(f"缺少必填字段 {field}", f"{where}.{field} 是必填项")
            continue
        val = payload[field]
        t = rule.get("type")
        if t is not None:
            tmap = {"str": str, "int": int, "num": (int, float), "bool": bool, "dict": dict, "list": list}
            py_t = tmap.get(t)
            if py_t is not None and not isinstance(val, py_t) or (t == "int" and isinstance(val, bool)):
                raise SchemaError(f"字段 {field} 类型应为 {t}", f"收到 {type(val).__name__}")
        if "enum" in rule and val not in rule["enum"]:
            raise SchemaError(f"字段 {field} 取值非法: {val!r}", f"合法值: {rule['enum']}")
        if "one_of" in rule and val not in rule["one_of"]:
            raise SchemaError(f"字段 {field} 取值非法: {val!r}", f"合法值: {rule['one_of']}")
        if "max_len" in rule and isinstance(val, (str, list, dict)) and len(val) > rule["max_len"]:
            raise SchemaError(f"字段 {field} 超长（上限 {rule['max_len']}）", "缩短后重试")
    unknown = set(payload) - set(schema)
    if unknown:
        raise SchemaError(f"存在未知字段: {sorted(unknown)}", f"允许的字段: {sorted(schema)}")


# 常用入参 schema（冻结）
SCHEMA_SEND = {"text": {"type": "str", "required": True, "max_len": 100_000},
               "client_msg_id": {"type": "str", "max_len": 64}}
SCHEMA_APPROVE = {"request_id": {"type": "str", "required": True, "max_len": 64},
                  "decision": {"type": "str", "required": True, "enum": ENUMS["DECISION"]}}
SCHEMA_COMMAND = {"name": {"type": "str", "required": True, "enum": ENUMS["COMMAND_NAME"]},
                  "args": {"type": "dict"}}
SCHEMA_VISION_REMOVE = {"ref": {"type": "str", "required": True, "max_len": 64}}
SCHEMA_RESUME = {"sid": {"type": "str", "required": True, "max_len": 128}}
SCHEMA_SESSION_RENAME = {"sid": {"type": "str", "required": True, "max_len": 64},
                         "title": {"type": "str", "required": True, "max_len": 80}}
SCHEMA_SESSION_DELETE = {"sid": {"type": "str", "required": True, "max_len": 64}}
# 项目分组（UI 批次 B）：projects CRUD + assign/unassign
SCHEMA_PROJECT_CREATE = {"name": {"type": "str", "required": True, "max_len": 120}}
SCHEMA_PROJECT_ID = {"id": {"type": "str", "required": True, "max_len": 32}}
SCHEMA_PROJECT_RENAME = {"id": {"type": "str", "required": True, "max_len": 32},
                         "name": {"type": "str", "required": True, "max_len": 120}}
SCHEMA_PROJECT_ASSIGN = {"id": {"type": "str", "required": True, "max_len": 32},
                         "sid": {"type": "str", "required": True, "max_len": 64}}
# 三层记忆实时编辑（UI 批次 C）：长期/项目条目操作 + 短期便签
SCHEMA_MEMORY_ITEM = {"action": {"type": "str", "required": True, "enum": ["add", "edit", "forget", "revive"]},
                      "layer": {"type": "str", "required": True, "enum": ["long", "project"]},
                      "id": {"type": "str", "max_len": 32},
                      "text": {"type": "str", "max_len": 1000},
                      "zone": {"type": "str", "max_len": 8},
                      "project_id": {"type": "str", "max_len": 32}}
SCHEMA_MEMORY_NOTE = {"action": {"type": "str", "required": True, "enum": ["add", "remove"]},
                      "text": {"type": "str", "max_len": 4000},
                      "index": {"type": "int"}}
# 模型切换：路由层再执行 model/model_id 的严格 one-of 校验，保留旧页面兼容。
SCHEMA_MODEL = {"model": {"type": "str", "max_len": 128},
                "model_id": {"type": "str", "max_len": 128}}
SCHEMA_AUTONOMY = {"on": {"type": "bool", "required": True}}
SCHEMA_RUNTIME_CONTROLS = {
    "sandbox_enabled": {"type": "bool"},
    "network_mode": {"type": "str", "enum": ["off", "proxy", "open"]},
    "heartbeat_enabled": {"type": "bool"},
}

# 本地模型资料：api_key 仅允许写入，GET/响应契约中永不出现该字段。
_MODEL_PROFILE_FIELDS = {
    "provider_name": {"type": "str", "max_len": 120},
    "protocol": {"type": "str", "enum": ["openai_compatible", "anthropic", "gemini", "ollama"]},
    "base_url": {"type": "str", "max_len": 500},
    "auth_mode": {"type": "str", "enum": ["bearer", "x_api_key", "query_key", "none"]},
    "display_name": {"type": "str", "max_len": 160},
    "upstream_model": {"type": "str", "max_len": 240},
    "capabilities": {"type": "list", "max_len": 16},
    "enabled": {"type": "bool"},
}
SCHEMA_MODEL_PROFILE_CREATE = {
    name: {**rule, "required": name != "enabled"} for name, rule in _MODEL_PROFILE_FIELDS.items()
} | {"api_key": {"type": "str", "max_len": 4096}}
SCHEMA_MODEL_PROFILE_PATCH = {
    name: dict(rule) for name, rule in _MODEL_PROFILE_FIELDS.items()
} | {"api_key": {"type": "str", "max_len": 4096}}


def export_contract() -> dict:
    """返回可 JSON 序列化的 v1 契约快照，供基线与测试消费。"""
    schemas = {
        name: value for name, value in globals().items()
        if name.startswith("SCHEMA_") and isinstance(value, dict)
    }
    return {
        "enums": deepcopy(ENUMS),
        "tool_meta": {name: list(value) for name, value in sorted(TOOL_META.items())},
        "schemas": deepcopy(dict(sorted(schemas.items()))),
    }
