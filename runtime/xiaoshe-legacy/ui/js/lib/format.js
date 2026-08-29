/* ============================================================================
 * 小蛇 · 格式化助手（零依赖，Wave 2 全模块复用）
 * fmtChars / relTime / argFormat / escapeAttr
 * ========================================================================== */

/** 字符数缩写：≥10000 → xx.xk（SPEC §12.2 压缩标记同款） */
export function fmtChars(n) {
  n = Number(n) || 0;
  if (n >= 10000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/** 相对时间（人话）：刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function relTime(ts, now = Date.now()) {
  const t = ts instanceof Date ? ts.getTime()
    : typeof ts === "number" ? ts
    : Date.parse(ts);
  if (!Number.isFinite(t)) return "";
  const d = Math.max(0, now - t);
  if (d < 5e3) return "刚刚";
  if (d < 60e3) return Math.floor(d / 1e3) + " 秒前";
  if (d < 3600e3) return Math.floor(d / 60e3) + " 分钟前";
  if (d < 86400e3) return Math.floor(d / 3600e3) + " 小时前";
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + " 天前";
  const dt = new Date(t);
  const p = (x) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * arg_format 模板替换（ui_schema TOOL_META display.arg_format）：
 *   "{path}"      → args.path 原值
 *   "{content.len}" → String(args.content).length
 * 只查表替换，**绝不 eval**；缺参的占位原样保留。
 */
export function argFormat(tpl, args = {}) {
  return String(tpl ?? "").replace(/\{([A-Za-z_][\w]*)(\.len)?\}/g, (m, key, len) => {
    if (!(key in args)) return m;
    const v = args[key];
    if (len) return String(typeof v === "string" || Array.isArray(v) ? v.length
      : v == null ? 0 : String(v).length);
    if (v == null) return m;
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** 属性值转义（拼 HTML 属性场景；优先用 setAttribute/el()） */
export function escapeAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
