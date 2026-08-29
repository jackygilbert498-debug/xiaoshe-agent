/* ============================================================================
 * 小蛇 · 主题模块（SPEC §12.2：data-theme 切换 + localStorage('xs-theme')）
 * 主题集合：""(默认云白薄荷流光) / "ink-jade"(暗夜影院)。theme.js 自身无副作用导入安全；
 * main.js 启动时调 initTheme() 应用持久值。
 * ========================================================================== */

const STORAGE_KEY = "xs-theme";
export const THEMES = ["warm", "ink-jade"];   // warm = 默认云白薄荷（不挂 data-theme）；ink-jade = 暗夜影院

/** 读取持久主题；非法值回落默认云白薄荷 */
export function currentTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(v) ? v : "warm";
  } catch { return "warm"; }   // file:// 隐私模式等 localStorage 不可用时静默回落
}

/** 应用主题到 <html data-theme>（云白薄荷移除属性，暗夜影院挂 ink-jade） */
export function applyTheme(name) {
  const t = THEMES.includes(name) ? name : "warm";
  if (t === "warm") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  return t;
}

/** 切换 + 持久化 + 应用。返回生效后的主题名 */
export function setTheme(name) {
  const t = applyTheme(name);
  try { localStorage.setItem(STORAGE_KEY, t); } catch { /* 同上静默 */ }
  return t;
}

/** 双主题往返切换（⌘K「切换主题」入口用） */
export function toggleTheme() {
  return setTheme(currentTheme() === "warm" ? "ink-jade" : "warm");
}

/** 启动：读取 localStorage('xs-theme') 应用（默认云白薄荷）。尽早调用防闪烁 */
export function initTheme() {
  return applyTheme(currentTheme());
}
