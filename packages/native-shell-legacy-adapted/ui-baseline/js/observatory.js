/* ============================================================================
 * 小蛇 · 屏幕观测（SPEC §12.2 observatory.js / 任务 P1-6；样式母本
 * prototypes/pb-dark.html L211-248/L405-440/L504-519，抽模态重写）
 * 模态挂 #modal-root；Esc / ◉ / 遮罩 / ✕ 关闭。
 * 四段：① 面包屑 chain 视口层级（当前高亮，点当前切缩放 setVp 移植）
 *           + 右侧统计 SoM N · UIA n · OCR n（从 marks source 算）；
 *       ② 画布 真截图（screenshot_ref → /api/images/{ref}?token=，
 *           缺 ref 退 /api/viewport/{id}/screenshot?token=）+ marks 编号框：
 *           uia 实线 / ocr 虚线 / uia+ocr 双色第三视觉（实线框+虚线描边），
 *           编号牌外凸；框按 (screen-origin)*scale 反换算图内坐标 → 百分比定位；
 *       ③ HUD 坐标链换算结果（图内→屏幕，只显示结果）+ 差分比例条
 *           （effective 玉 / suspected_noop 红+告警徽标 / unknown 灰）
 *           + 多显示器坐标系提示；
 *       ④ 编号表 no/label/source 徽章（ocr 给引擎标「OCR」），
 *           行↔框双向联动（select() 按 data-m 同步 .sel，原型逻辑移植）。
 * 空态：「当前没有活动视口——发起 look/observe 后此处显示模型所见」。
 * 快捷键：◉ 开合；数字键 1-9 直选编号；Esc 关。
 * ========================================================================== */

import { el } from "./lib/dom.js";
import { relTime } from "./lib/format.js";
import { openModal } from "./modal.js";

/* ---- 图片 URL（后端已放行图片端点 query token） ---- */
function token() { return sessionStorage.getItem("xs-token") || ""; }
function shotUrl(vp) {
  const t = encodeURIComponent(token());
  if (vp?.screenshot_ref) return `/api/images/${encodeURIComponent(vp.screenshot_ref)}?token=${t}`;
  if (vp?.viewport_id) return `/api/viewport/${encodeURIComponent(vp.viewport_id)}/screenshot?token=${t}`;
  return null;
}
function icon(name, cls = "ic") {
  if (!/^[a-z0-9-]+$/.test(name)) name = "eye";   // 终审 G1：innerHTML 插值白名单防御
  const t = document.createElement("template");
  t.innerHTML = `<svg class="${cls}" aria-hidden="true"><use href="#${name}"></use></svg>`;
  return t.content.firstElementChild;
}

/* ---- 模块状态 ---- */
let vp = null;              // viewport.update 载荷（含空态 {viewport_id:null,marks:{}}）
let pickDiff = null;        // pick_diff 载荷
let selNo = null;           // 当前选中编号（字符串键，对齐 marks 键）
let zoomed = false;
let built = false, opened = false;
let box = null;             // .obs 盒子
let modalHandle = null;
const N = {};               // 子节点引用

const DIFF_META = {
  effective: { cls: "ok", label: "点击生效" },
  suspected_noop: { cls: "bad", label: "疑似无效点击" },
  unknown: { cls: "mute", label: "差分未知" },
};

/* ---- 坐标换算：screen = origin + 图内/scale → 图内 = (screen-origin)*scale ---- */
function toImage(m) {
  const ox = vp?.origin?.[0] ?? 0, oy = vp?.origin?.[1] ?? 0;
  const sc = vp?.scale || 1;
  return {
    cx: (m.screen_cx - ox) * sc, cy: (m.screen_cy - oy) * sc,
    w: m.screen_w * sc, h: m.screen_h * sc,
  };
}

/* ============================================================================
 * 四段渲染
 * ========================================================================== */
function markEntries() {
  const marks = vp?.marks || {};
  return Object.values(marks).filter((m) => m && typeof m === "object")
    .sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
}

function renderBar() {
  const crumb = N.crumb;
  crumb.replaceChildren();
  const chain = Array.isArray(vp?.chain) && vp.chain.length ? vp.chain
    : vp?.viewport_id ? [vp.viewport_id] : [];
  chain.forEach((id, i) => {
    const cur = i === chain.length - 1;
    if (i) crumb.append(el("span.arr", { text: "→", "aria-hidden": "true" }));
    crumb.append(el("button", {
      class: "vp" + (cur ? " on" : ""),
      text: String(id) + (cur ? " 当前" : ""),
      title: cur ? "当前视口 · 点击切换缩放" : "链上的祖先视口（仅当前视口有数据）",
      disabled: cur ? null : "",
      onclick: cur ? () => { zoomed = !zoomed; renderCanvas(); } : null,
    }));
  });
  /* 右侧统计：SoM 总数 · UIA · OCR（从 marks source 算） */
  const ms = markEntries();
  const uia = ms.filter((m) => String(m.source).includes("uia")).length;
  const ocr = ms.filter((m) => String(m.source).includes("ocr")).length;
  N.meta.textContent = `SoM ${ms.length} · UIA ${uia} · OCR ${ocr}`
    + (vp?.updated_at ? ` · ${relTime(vp.updated_at)}` : "");
}

function renderCanvas() {
  const shot = N.shot;
  shot.replaceChildren();
  shot.classList.remove("shot-missing");
  const size = Array.isArray(vp?.size) ? vp.size : null;
  const w = Number(size?.[0]) || 16, h = Number(size?.[1]) || 10;
  shot.style.aspectRatio = `${w} / ${h}`;
  shot.style.setProperty("--z", zoomed ? "1.22" : "1");

  const url = shotUrl(vp);
  if (url) {
    const img = el("img.shot-img", { src: url, alt: "视口截图（模型所见）" });
    img.addEventListener("error", () => {
      img.remove();
      shot.classList.add("shot-missing");
      shot.prepend(el("div.shot-fallback", {},
        icon("camera", "ic"),
        el("span", { text: "截图加载失败" }),
        el("button.mini-btn", { text: "重试", onclick: renderCanvas })));
    }, { once: true });
    shot.append(img);
  } else {
    shot.classList.add("shot-missing");
    shot.append(el("div.shot-fallback", {},
      icon("camera", "ic"), el("span", { text: "该视口无截图引用" })));
  }

  /* marks 编号框叠加（百分比定位） */
  for (const m of markEntries()) {
    const im = toImage(m);
    const pct = (v, total) => Math.max(0, Math.min(100, (v / total) * 100));
    const left = pct(im.cx - im.w / 2, w), top = pct(im.cy - im.h / 2, h);
    const bw = Math.max(0.8, pct(im.w, w)), bh = Math.max(0.8, pct(im.h, h));
    const src = String(m.source || "uia");
    const cls = "mark"
      + (src === "ocr" ? " ocr" : src === "uia+ocr" ? " both" : "")
      + (String(m.no) === selNo ? " sel" : "");
    const mk = el("div", {
      class: cls,
      dataset: { m: String(m.no) },
      style: `top:${top}%;left:${left}%;width:${bw}%;height:${bh}%`,
      title: `#${m.no} ${m.label || ""} · ${src}`,
      onclick: () => select(String(m.no)),
    }, el("span.no", { text: String(m.no) }));
    shot.append(mk);
  }
}

function renderHud() {
  const hud = N.hud;
  hud.replaceChildren();
  /* 坐标链换算结果（图内→屏幕，只显示结果） */
  const ms = markEntries();
  const sel = ms.find((m) => String(m.no) === selNo);
  const coord = el("div.hud-line", {});
  if (sel) {
    const im = toImage(sel);
    coord.append(
      el("span.hud-k", { text: "坐标链" }),
      el("b.j", { text: `图内(${Math.round(im.cx)},${Math.round(im.cy)}) → 屏幕(${sel.screen_cx},${sel.screen_cy})` }),
      el("span.hud-dim", { text: `#${sel.no} ${sel.label || ""}` }));
  } else {
    coord.append(el("span.hud-k", { text: "坐标链" }),
      el("span.hud-dim", { text: ms.length ? "点击画布框或编号行查看换算结果" : "无视口时无坐标链" }));
  }
  /* 差分比例条 */
  const d = pickDiff;
  const meta = DIFF_META[d?.status] || DIFF_META.unknown;
  const ratio = typeof d?.ratio === "number" ? d.ratio : null;
  const pctTxt = ratio != null ? `${(ratio * 100).toFixed(1)}%` : "—";
  const diffLine = el("div.hud-line", {},
    el("span.hud-k", { text: "像素差分" }),
    el("span", { class: "diffbar " + meta.cls },
      el("i", { style: `width:${ratio != null ? Math.min(100, Math.max(2, ratio * 100)) : 0}%` })),
    el("b", { class: meta.cls === "mute" ? "" : meta.cls === "ok" ? "j" : "bad",
      text: `${pctTxt} · ${meta.label}` }),
    d?.status === "suspected_noop"
      ? el("span.noop-badge", { title: "AX 与像素两层都无变化——点击可能未命中" }, icon("warn", "ic"), "告警")
      : null,
    d?.target?.no != null ? el("span.hud-dim", { text: `目标 #${d.target.no}` }) : null,
    d?.at ? el("span.hud-dim", { text: relTime(d.at) }) : null);
  hud.append(coord, diffLine,
    el("div.hud-line.hud-tip", { text: "多显示器：屏幕坐标为全局桌面坐标系，跨屏时可能为负值或超出主屏范围。" }));
}

function renderMarks() {
  const list = N.marks;
  list.replaceChildren();
  for (const m of markEntries()) {
    const src = String(m.source || "uia");
    const row = el("div", {
      class: "mrow" + (String(m.no) === selNo ? " sel" : ""),
      dataset: { m: String(m.no) },
      onclick: () => select(String(m.no)),
    },
      el("span.no", { text: String(m.no) }),
      el("span.lb", { text: m.label || "（未命名）", title: m.label || "" }),
      el("span", { class: "srcg" + (src === "ocr" ? " g-ocr" : src === "uia+ocr" ? " g-both" : ""),
        text: src === "ocr" ? "OCR" : src === "uia+ocr" ? "UIA+OCR" : "UIA" }));
    list.append(row);
  }
}

function renderAll() {
  const hasVp = !!vp?.viewport_id;
  N.empty.classList.toggle("is-hidden", hasVp);
  N.body.classList.toggle("is-hidden", !hasVp);
  if (!hasVp) { N.meta.textContent = "SoM 0 · UIA 0 · OCR 0"; N.crumb.replaceChildren(); return; }
  if (selNo && !markEntries().some((m) => String(m.no) === selNo)) selNo = null;
  renderBar();
  renderCanvas();
  renderHud();
  renderMarks();
}

/** 双向联动核心（原型 select() 移植）：按 data-m 同步 .mark/.mrow 的 .sel */
function select(no) {
  selNo = no;
  for (const mk of N.shot.querySelectorAll(".mark")) mk.classList.toggle("sel", mk.dataset.m === no);
  for (const r of N.marks.querySelectorAll(".mrow")) r.classList.toggle("sel", r.dataset.m === no);
  renderHud();
  N.marks.querySelector(`.mrow[data-m="${CSS.escape(no)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

/* ============================================================================
 * 模态骨架（首次 open 时构建）
 * ========================================================================== */
function build() {
  box = el("div.obs", { role: "dialog", "aria-modal": "true", "aria-label": "屏幕观测" },
    el("div.obs-bar", {},
      icon("eye", "ic"),
      el("span.obs-title", { text: "屏幕观测" }),
      N.crumb = el("div.crumb", {}),
      N.meta = el("span.obs-meta", { text: "" }),
      el("button.obs-close", {
        title: "关闭（Esc / ◉）", "aria-label": "关闭屏幕观测",
        onclick: () => close(),
      }, icon("close", "ic"))),
    N.body = el("div.obs-body", {},
      el("div.eye-canvas", {}, N.shot = el("div.shot", {})),
      N.hud = el("div.eye-hud", {}),
      N.marks = el("div.eye-marks", {})),
    N.empty = el("div.obs-empty.is-hidden", {},
      icon("eye-screen", "e-mark"),
      el("div.e-title", { text: "当前没有活动视口" }),
      el("div.e-desc", { text: "发起 look/observe 后此处显示模型所见——截图编号、坐标链与点击差分都会出现在这里。" }),
      el("div.e-act", { text: "◉ 开合 · 数字键 1-9 直选编号 · Esc 关闭" })));
  built = true;
  return true;
}

export function open() {
  if (opened) return;
  if (!built) build();
  box.classList.remove("closing");
  opened = true;
  document.getElementById("eye-btn")?.classList.add("on");
  renderAll();
  modalHandle = openModal({
    content: box,
    trigger: document.getElementById("eye-btn"),
    initialFocus: ".obs-close",
    label: "屏幕观测",
    onClose: () => {
      opened = false;
      modalHandle = null;
      document.getElementById("eye-btn")?.classList.remove("on");
    },
  });
}

export function close(reason = "programmatic") {
  if (!opened) return;
  modalHandle?.close(reason);
}

export function toggle() { opened ? close() : open(); }
export function isOpen() { return opened; }

/** viewport.update 载荷（含空态 {viewport_id:null,marks:{}}） */
export function update(viewportPayload) {
  vp = viewportPayload && typeof viewportPayload === "object" ? viewportPayload : null;
  zoomed = false;
  if (opened) renderAll();
}

/** pick/diff 载荷：{status, ratio, pair, target, at} */
export function setPickDiff(pd) {
  pickDiff = pd && typeof pd === "object" ? pd : null;
  if (opened) renderHud();
}

/* ---- 全局接线：#eye-btn 入口（index.html 挂载点表归 observatory.js）+ 快捷键 ---- */
document.getElementById("eye-btn")?.addEventListener("click", () => toggle());
document.addEventListener("keydown", (ev) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === "TEXTAREA" || tag === "INPUT";
  if (ev.key === "◉" && !typing) { ev.preventDefault(); toggle(); return; }
  if (opened && !typing && /^[1-9]$/.test(ev.key)) {
    const hit = markEntries().find((m) => String(m.no) === ev.key);
    if (hit) { ev.preventDefault(); select(ev.key); }
  }
});

window.XS = window.XS || {};
window.XS.observatory = { open, close, toggle, isOpen, update, setPickDiff };
