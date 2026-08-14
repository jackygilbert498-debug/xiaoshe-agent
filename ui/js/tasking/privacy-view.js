import { el } from "../lib/dom.js";
import { openModal } from "../modal.js";
import * as api from "./api.js";

export async function openPrivacy(trigger, { notify = () => {} } = {}) {
  let data; try { data = await api.privacy(); } catch (error) { notify(error?.message || "隐私设置加载失败"); return; }
  let handle;
  const render = () => {
    const on = data.consent === "on";
    const panel = el("div.confirm-box", {}, el("div.confirm-title", { text: "隐私遥测与诊断" }),
      el("p.sys-note", { text: on ? "遥测已开启；下方是下一批将发送的聚合字段。" : "遥测默认关闭；关闭时不发送、不排队。" }),
      el("pre", { text: JSON.stringify(data.payloads || [], null, 2) }),
      el("div.confirm-acts", {},
        el("button.confirm-go", { type: "button", text: on ? "关闭并清空" : "开启遥测", onclick: async () => { try { data = await api.setPrivacy({ consent: on ? "off" : "on", consent_version: data.consent_version, clear: on }); handle.element.replaceWith(render()); notify(on ? "遥测已关闭并清空" : "遥测已开启"); } catch (e) { notify(e?.message || "设置失败"); } } }),
        el("button.confirm-go", { type: "button", text: "预览诊断包", onclick: async () => { try { const preview = await api.previewDiagnostics({}); notify(`诊断预览：${preview.files.join("、")}`); const ok = window.confirm("已预览诊断文件清单，是否导出？"); if (ok) { const result = await api.exportDiagnostics(preview.preview_id); notify(`已导出诊断包：${result.archive}`); } } catch (e) { notify(e?.message || "诊断导出失败"); } } }),
        el("button.confirm-cancel", { type: "button", text: "关闭", onclick: () => handle.close("close") })));
    return panel;
  };
  const content = render(); handle = openModal({ content, trigger, initialFocus: content.querySelector("button"), label: "隐私遥测与诊断" });
}
