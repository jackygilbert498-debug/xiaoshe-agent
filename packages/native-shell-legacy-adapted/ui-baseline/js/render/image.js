/* ============================================================================
 * 小蛇 · 图片渲染（SPEC §12.2 render/image：thumb + 灯箱）
 * 图片 URL：/api/images/{ref}?thumb=1&token=（S2 dee6db5：二进制端点放行 query token）
 * 灯箱挂 #modal-root，Esc/遮罩关闭。
 * ========================================================================== */

import { imageUrl } from "../net.js";
import { el } from "../lib/dom.js";
import { openModal } from "../modal.js";

/** 缩略图（点击开灯箱）；target 为图片来源说明（look 编号截图等） */
export function imageThumb(ref, target = null) {
  const fig = el("figure.imgthumb", { role: "button", tabindex: "0", "aria-label": `查看图片 ${ref}` });
  const img = el("img", { src: imageUrl(ref, true), alt: target || ref, loading: "lazy" });
  img.onerror = () => {
    fig.replaceChildren(el("figcaption.imgthumb-err", { text: `图片 ${ref} 已不可用` }));
    fig.classList.add("broken");
    fig.removeAttribute("role");
    fig.removeAttribute("tabindex");
  };
  fig.append(img, el("figcaption.imgthumb-cap", { text: target ? `${ref}｜${target}` : ref }));
  const open = () => openLightbox(ref, target, fig);
  fig.addEventListener("click", open);
  fig.addEventListener("keydown", (ev) => { if (ev.key === "Enter") open(); });
  return fig;
}

/** 灯箱：原图 + 说明；挂 #modal-root */
export function openLightbox(ref, target = null, trigger = document.activeElement) {
  let handle;
  const close = () => handle?.close("button");
  const box = el("div.lightbox", { role: "dialog", "aria-label": `图片 ${ref}` },
    el("img", { src: imageUrl(ref, false), alt: target || ref }),
    el("div.lightbox-cap", { text: target ? `${ref}｜${target}` : ref }),
    el("button.icbtn.lightbox-x", { "aria-label": "关闭灯箱", onclick: close },
      iconSvg("close")),
  );
  handle = openModal({
    content: box,
    trigger,
    initialFocus: ".lightbox-x",
    label: `图片 ${ref}`,
  });
  return handle;
}

function iconSvg(name) {
  if (!/^[a-z0-9-]+$/.test(name)) name = "image";   // 终审 G1：innerHTML 插值白名单防御
  const t = document.createElement("template");
  t.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#${name}"></use></svg>`;
  return t.content.firstElementChild;
}
