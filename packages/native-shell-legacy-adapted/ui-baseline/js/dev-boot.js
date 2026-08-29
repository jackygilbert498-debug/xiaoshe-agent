/* ============================================================================
 * 小蛇 · 开发测试台启动脚本（仅 dev.html 用，不进导航、不进生产链路）
 * 职责：① 搭 window.XS 最小面（theme/enums/dom/format/toast + net stub）
 *       ② 容错动态导入 Wave2-B 四模块（与 W2-A main.js 同款姿势）
 *       ③ mount 三 tab + 渲染五组样态（state/memory/jobs/viewport/pick_diff）
 * 数据来自 dev.html 内嵌 <script type="application/json"> fixtures 片段
 * （与 tests/ui_contract/fixtures/ 同形；CSP script-src 'self' 下为惰性数据块）。
 * ========================================================================== */

import * as theme from "./theme.js";
import * as enums from "./lib/enums.js";
import * as dom from "./lib/dom.js";
import * as format from "./lib/format.js";

window.XS = { theme, enums, dom, format };
theme.initTheme();

const { el, on } = dom;
const read = (id) => JSON.parse(document.getElementById(id).textContent);
const FX = {
  state: read("fx-state"), jobs: read("fx-jobs"), memory: read("fx-memory"),
  skills: read("fx-skills"), vp: read("fx-viewport"), vpEmpty: read("fx-viewport-empty"),
  diff: read("fx-diff"), diffNoop: read("fx-diff-noop"), diffUnknown: read("fx-diff-unknown"),
};

/* toast 单实例（同 main.js 占位实现） */
const toastRoot = document.getElementById("toast-root");
function toast(text) {
  if (!toastRoot) return;
  const t = el("div.toast", { text });
  toastRoot.replaceChildren(t);
  setTimeout(() => t.remove(), 2400);
}
window.XS.toast = toast;

/* net stub：演示命令通道与按需补拉（生产由 W2-A net.js 提供真通道） */
window.XS.net = {
  get(path) {
    const m = String(path).match(/^\/api\/jobs\/([^/]+)\/log/);
    if (m) {
      const j = FX.jobs.jobs.find((x) => x.id === decodeURIComponent(m[1]));
      const tail = (j?.tail || []).join("\n");
      return Promise.resolve({ v: 1, server_time: FX.jobs.server_time, job: j || null, log: tail });
    }
    return Promise.reject(new Error("dev stub 未覆盖: " + path));
  },
  command(name, args) { toast(`command → ${name} ${JSON.stringify(args)}`); },
  visionRemove(ref) { toast(`vision_pending.remove → ${ref}`); },
};

/* 页签切换（与 main.js 同款 .itab/.panel.on 约定） */
const inspHead = document.querySelector(".insp-head");
if (inspHead) {
  on(inspHead, "click", ".itab", (_ev, tab) => {
    for (const t of inspHead.querySelectorAll(".itab")) {
      const hit = t === tab;
      t.classList.toggle("on", hit);
      t.setAttribute("aria-selected", hit ? "true" : "false");
    }
    for (const p of document.querySelectorAll(".insp-body .panel")) {
      p.classList.toggle("on", p.id === tab.dataset.panel);
    }
  });
}

function mountAll() {
  window.XS.panels?.state?.mount(document.getElementById("p-state"));
  window.XS.panels?.memory?.mount(document.getElementById("p-mem"));
  window.XS.panels?.system?.mount(document.getElementById("p-sys"));
}

function applyFull() {
  window.XS.panels.state.update(FX.state);
  window.XS.panels.state.updateJobs(FX.jobs.jobs);
  window.XS.panels.memory.update({ memory: FX.memory, skills: FX.skills });
  window.XS.panels.system.update({
    connected: true, endpoint: "http://127.0.0.1:7788", sid: "sess-0726-42",
    usage: FX.state.usage, version: "小蛇 UI · 契约 v1 · dev",
  });
  window.XS.observatory.update(FX.vp);
  window.XS.observatory.setPickDiff(FX.diff);
}

/* 容错动态导入（任一模块失败只 toast，不拖垮其余） */
Promise.all([
  import("./panels/state.js"),
  import("./panels/memory.js"),
  import("./panels/system.js"),
  import("./observatory.js"),
]).then(() => {
  mountAll();
  applyFull();
  on(document.getElementById("dev-bar"), "click", "[data-sc]", (_ev, btn) => {
    const sc = btn.dataset.sc;
    const obs = window.XS.observatory;
    if (sc === "theme") { theme.toggleTheme(); return; }
    if (sc === "full") { mountAll(); applyFull(); toast("已重放全量样态"); return; }
    if (sc === "skel") { mountAll(); toast("已重置为骨架态（未推送数据）"); return; }
    if (sc === "obs-data") { obs.update(FX.vp); obs.setPickDiff(FX.diff); obs.open(); return; }
    if (sc === "obs-empty") { obs.update(FX.vpEmpty); obs.open(); return; }
    if (sc === "diff-ok") { obs.update(FX.vp); obs.setPickDiff(FX.diff); obs.open(); return; }
    if (sc === "diff-noop") { obs.update(FX.vp); obs.setPickDiff(FX.diffNoop); obs.open(); return; }
    if (sc === "diff-unknown") { obs.update(FX.vp); obs.setPickDiff(FX.diffUnknown); obs.open(); }
  });
}).catch((e) => toast("模块加载失败：" + (e?.message || e)));
