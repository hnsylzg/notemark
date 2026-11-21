/*
 * html-view.ts — 行内 HTML 真实渲染
 *
 * Milkdown 默认把行内 html 节点渲染为纯文本（安全考虑），导致 <u>underline</u>
 * 在编辑器中显示为源码。这里覆盖渲染：白名单 sanitize 后 innerHTML 渲染，
 * 使 <u>、<mark>、<kbd>、<sup> 等安全标签真实显示（如 <u> 下划线），
 * 并支持 <iframe> 嵌入外部内容（仅 http(s)，剥离敏感权限/危险属性）。
 * 序列化仍输出原始 HTML 源码，导入导出往返无损。
 */
import { $view, type $Node } from "@milkdown/kit/utils";
import { htmlSchema } from "@milkdown/kit/preset/commonmark";
import {
  NodeSelection,
  TextSelection,
} from "@milkdown/kit/prose/state";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { resolveImageSrc } from "./image-view";

/** 允许渲染的 HTML 标签白名单 */
const SAFE_HTML_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del",
  "dfn", "em", "i", "iframe", "ins", "kbd", "mark", "q", "rp", "rt", "ruby", "s",
  "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
  // center：虽是废弃标签，md 里仍常见。此前不在白名单 → 被降级成纯文本，
  // 只剩文字、丢失居中（编辑器与 PDF 里都看不出居中）。放行后由浏览器
  // 默认样式（text-align:center）居中；它无危险属性，安全。
  "center",
  // img 单独放行：行内 HTML 图片（<img src="...">）应真实显示。
  // 此前白名单没有 img，行内 <img> 会被降级成空文本节点 → 图片整个消失。
  // src 的协议过滤与相对路径解析见 ensureImgSrc。
  "img",
]);

/** iframe 允许的外部 src：仅 http(s) 绝对地址（拒绝 javascript:/data:/file: 等） */
const IFRAME_SRC_RE = /^https?:\/\//i;

/**
 * 少数可视化服务必须在 iframe 内访问自己的同源 Cookie / API。
 * 只对明确受信任的站点追加 allow-same-origin，不能全局放开：
 * 全局放开会让任意第三方嵌入页获得与源站一致的存储和网络权限。
 */
const IFRAME_SAME_ORIGIN_HOSTS = new Set([
  "pythontutor.com",
  "www.pythontutor.com",
]);

/** 视频嵌入必须访问自身存储，并依赖来源信息完成防盗链校验。 */
const IFRAME_MEDIA_HOSTS = [
  "youtube.com",
  "youtube-nocookie.com",
  "bilibili.com",
  "vimeo.com",
] as const;

const IFRAME_PLAYBACK_PERMISSIONS = [
  "autoplay",
  "encrypted-media",
  "fullscreen",
  "picture-in-picture",
] as const;

/** iframe 的 allow 属性中不允许出现的敏感权限（剥离，防止嵌入页滥用设备能力） */
const IFRAME_DENIED_PERMISSIONS = new Set([
  "camera", "microphone", "geolocation", "payment", "usb", "midi", "serial",
  "nfc", "bluetooth", "clipboard-read", "xr-spatial-tracking",
  "screen-wake-lock", "display-capture", "publickey-credentials-get",
  "top-navigation", "top-navigation-by-user-activation", "downloads",
]);

/**
 * Remote embeds are untrusted document content. Keep them in an opaque-origin
 * sandbox and never allow top-level navigation, forms, downloads or device
 * permissions. A user-provided `sandbox` attribute is intentionally replaced.
 */
function hardenIframe(el: Element): void {
  let isPythonTutor = false;
  let needsSameOrigin = false;
  let isMediaEmbed = false;
  try {
    const url = new URL(el.getAttribute("src") ?? "", window.location.href);
    const hostname = url.hostname.toLowerCase();
    isPythonTutor = IFRAME_SAME_ORIGIN_HOSTS.has(hostname);
    isMediaEmbed = IFRAME_MEDIA_HOSTS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
    needsSameOrigin = isPythonTutor || isMediaEmbed;
  } catch {
    // URL 已通过前面的 http(s) 校验；这里仅兜底畸形 URL。
  }
  el.setAttribute(
    "sandbox",
    `allow-scripts allow-presentation allow-popups allow-popups-to-escape-sandbox${
      needsSameOrigin ? " allow-same-origin" : ""
    }`
  );
  if (isPythonTutor) {
    el.setAttribute("data-md-embed-provider", "pythontutor");
  } else if (isMediaEmbed) {
    el.setAttribute("data-md-embed-provider", "media");
  }
  el.setAttribute(
    "referrerpolicy",
    isMediaEmbed ? "strict-origin-when-cross-origin" : "no-referrer"
  );
  el.removeAttribute("name");
  const allow = el.getAttribute("allow") ?? "";
  const parts = allow
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const existingPermissions = new Set(
    parts.map((part) => part.split(/\s+/)[0].toLowerCase())
  );
  for (const permission of IFRAME_PLAYBACK_PERMISSIONS) {
    if (!existingPermissions.has(permission)) parts.push(permission);
  }
  el.setAttribute("allowfullscreen", "");
  if (parts.length > 0) {
    el.setAttribute(
      "allow",
      parts
        .filter((p) => !IFRAME_DENIED_PERMISSIONS.has(p.split(/\s+/)[0].toLowerCase()))
        .join("; ")
    );
  } else {
    el.removeAttribute("allow");
  }
}

/** 白名单过滤 HTML：移除危险标签、事件属性、脚本相关属性 */
export function sanitizeHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;

  // 移除危险标签（SVG/媒体/表单等可能被利用的容器）
  for (const el of content.querySelectorAll(
    "script,style,object,embed,link,meta,form,input,button,select,textarea,svg,math,video,audio"
  )) {
    el.remove();
  }

  // 自底向上处理，避免父元素被替换后影响后续节点
  const elements = Array.from(content.querySelectorAll("*"));
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i] as HTMLElement;
    const tag = el.tagName.toLowerCase();

    // 非白名单标签降级为纯文本
    if (!SAFE_HTML_TAGS.has(tag)) {
      el.replaceWith(document.createTextNode(el.textContent ?? ""));
      continue;
    }
    // 移除事件属性与危险属性
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith("on") ||
        ["style", "srcdoc", "srcset", "formaction"].includes(name)
      ) {
        el.removeAttribute(attr.name);
      }
    }
    // 链接仅允许安全协议或本地相对路径（拒绝 javascript:/data:/file: 等危险协议）
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:|#|\.{0,2}\/)/i.test(href)) el.removeAttribute("href");
    }
    // 行内 HTML 图片：真实显示（协议过滤 + 相对路径基于文件目录解析）
    if (tag === "img") {
      ensureImgSrc(el);
    }
    // iframe：仅允许 http(s) 外部来源；移除可能被跨窗口脚本利用的属性
    if (tag === "iframe") {
      const src = el.getAttribute("src") ?? "";
      if (!IFRAME_SRC_RE.test(src)) {
        el.remove();
        continue;
      }
      hardenIframe(el);
      // 延迟加载 + 默认无边框交给 CSS 主题控制
      el.setAttribute("loading", "lazy");
      // 用包裹层承载 hover：pointer-events:none 的元素自身不产生 :hover 状态，
      // 鼠标移到包裹层上时再唤醒 iframe 交互（见 base.css）
      const wrap = document.createElement("div");
      wrap.className = "md-iframe-wrap";
      el.replaceWith(wrap);
      wrap.appendChild(el);
    }
  }
  return template.innerHTML;
}

/**
 * 处理 img 标签的 src：
 * - 带协议但不是安全来源（javascript:、data:text 等）→ 移除 src，防注入；
 * - 相对路径 → 基于当前打开文件目录解析（与 ![]() 图片同一规则），
 *   并存原始 src 到 data-md-src，便于 setImageBaseDir 变化后刷新；
 * - 绝对 http(s) / data:image / blob → 原样保留；
 * - 统一设置 referrerPolicy="no-referrer"，避免图床防盗链（见下方注释）。
 */
function ensureImgSrc(el: Element): void {
  const src = el.getAttribute("src") ?? "";
  if (!src) return;
  // 不带 Referer 请求：与 image-view 里 ![]() 图片的规则保持一致。多数图床
  // （实测 B站 i0.hdslb.com）只放行「空 Referer 或自家域名」，而应用页面的
  // Referer 是 http://localhost:5173/（打包后 tauri://localhost/），会被判
  // 防盗链返回 403 —— 这类 <img> 就会显示不出来（fetch 侧同样问题见
  // docxExporter / exporter）。
  (el as HTMLImageElement).referrerPolicy = "no-referrer";
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    if (!/^(https?:|data:image\/|blob:)/i.test(src)) el.removeAttribute("src");
  } else {
    // Element 类型没有 dataset（只有 HTMLElement 有），这里必然来自
    // DOMParser 解析的 HTML 文档，断言为 HTMLElement 即可。
    (el as HTMLElement).dataset.mdSrc = src;
    el.setAttribute("src", resolveImageSrc(src));
  }
}

/** 块级 HTML 允许的常见标签（行内 + 块级 / 结构标签） */
const SAFE_BLOCK_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn",
  "em", "i", "ins", "kbd", "mark", "q", "rp", "rt", "ruby", "s", "samp",
  "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
  "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
  "header", "footer", "nav", "aside", "main", "ul", "ol", "li", "table",
  "thead", "tbody", "tfoot", "tr", "td", "th", "blockquote", "pre", "hr",
  "figure", "figcaption", "picture", "img", "details", "summary", "dl",
  "dt", "dd", "address", "iframe", "button", "center",
  // 表格结构标签：手写 HTML 表格常用，此前不在白名单 → 被降级成纯文本、
  // <caption>/<col>/<colgroup> 整段消失。它们无脚本能力、仅做结构/样式，
  // 放行安全。col/colgroup 依赖 span 属性（见 SAFE_BLOCK_ATTRS）。
  "caption", "col", "colgroup",
]);

/** 块级 HTML 允许保留的属性（其余危险属性一律移除） */
const SAFE_BLOCK_ATTRS = new Set([
  "class", "id", "title", "width", "height", "alt", "colspan", "rowspan",
  "target", "rel", "src", "style", "loading",
  // span：<col span="2"> / <colgroup span="2"> 跨列必备，放行以保留列结构
  "span",
  // referrerpolicy：ensureImgSrc 会给 <img> 设 no-referrer 绕图床防盗链。
  // 必须放行 —— 块级 HTML 是以字符串存进节点 attrs 的，下次渲染要重新
  // sanitize，属性若被剥掉，图片就又带上 Referer 而被图床 403。
  "referrerpolicy",
]);

const FLOW_CONTAINER_BLOCK_CHILDREN = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

function wrapInlineContentInParagraph(container: HTMLElement): void {
  const hasBlockChild = Array.from(container.children).some((child) =>
    FLOW_CONTAINER_BLOCK_CHILDREN.has(child.tagName.toLowerCase())
  );
  if (hasBlockChild) return;
  if (!container.textContent?.trim()) return;
  const paragraph = document.createElement("p");
  while (container.firstChild) paragraph.appendChild(container.firstChild);
  container.appendChild(paragraph);
}

/**
 * 块级 HTML 块的 sanitize：比行内白名单宽松，允许 div / p / h1 / table / img
 * 等常见块级标签及 class/style 等属性；仍移除 script/style/表单/SVG 等危险容器、
 * 所有 on* 事件属性，并对 a/img/iframe 的 src/href 做协议校验。
 */
export function sanitizeHtmlBlock(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const content = template.content;

  // 移除危险容器（button 作为静态展示保留，交由下方白名单处理）
  for (const el of content.querySelectorAll(
    "script,style,object,embed,link,meta,form,input,select,textarea,svg,math,video,audio"
  )) {
    el.remove();
  }

  const elements = Array.from(content.querySelectorAll("*"));
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i] as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === "iframe") {
      const src = el.getAttribute("src") ?? "";
      if (!IFRAME_SRC_RE.test(src)) {
        el.remove();
        continue;
      }
      hardenIframe(el);
      el.setAttribute("loading", "lazy");
      const wrap = document.createElement("div");
      wrap.className = "md-iframe-wrap";
      el.replaceWith(wrap);
      wrap.appendChild(el);
      continue;
    }

    if (!SAFE_BLOCK_TAGS.has(tag)) {
      el.replaceWith(document.createTextNode(el.textContent ?? ""));
      continue;
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith("on") ||
        !SAFE_BLOCK_ATTRS.has(name) ||
        ["srcdoc", "srcset", "formaction"].includes(name)
      ) {
        el.removeAttribute(attr.name);
      }
    }

    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:|#|\.{0,2}\/)/i.test(href)) el.removeAttribute("href");
    }
    if (tag === "img") {
      ensureImgSrc(el);
    }
    if (tag === "td" || tag === "th") {
      wrapInlineContentInParagraph(el);
    }
    if (tag === "blockquote") {
      wrapInlineContentInParagraph(el);
    }
  }
  return template.innerHTML;
}

const EDITABLE_INLINE_HTML_TAGS = new Set([
  "abbr",
  "b",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
]);

const RENDERED_NON_EDITABLE_INLINE_HTML_TAGS = new Set([
  "a",
  "br",
  "iframe",
  "img",
  "wbr",
]);

const EMBED_INLINE_HTML_TAGS = new Set(["iframe", "img"]);

const PAIRED_INLINE_HTML_RE =
  /^<([a-z][a-z0-9-]*)(?:\s[^>]*)?>[\s\S]*<\/\1\s*>$/i;

function inlineHtmlTag(value: string): string | null {
  const match = /^<\s*([a-z][a-z0-9-]*)\b/i.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

function editableInlineHtmlTag(value: string): string | null {
  const match = PAIRED_INLINE_HTML_RE.exec(value.trim());
  if (!match) return null;
  const tag = match[1].toLowerCase();
  return EDITABLE_INLINE_HTML_TAGS.has(tag) ? tag : null;
}

function isNonEditableInlineHtml(value: string): boolean {
  const tag = inlineHtmlTag(value);
  return tag !== null && RENDERED_NON_EDITABLE_INLINE_HTML_TAGS.has(tag);
}

export const createInlineHtmlNodeView: NodeViewConstructor = (
  node,
  view,
  getPos
) => {
  const wrapper = document.createElement("span");
  wrapper.className = "mt-inline-html-node";
  wrapper.dataset.type = "html";

  const preview = document.createElement("span");
  preview.className = "mt-inline-html-preview";
  const source = document.createElement("span");
  source.className = "mt-inline-html-source";
  source.contentEditable = "plaintext-only";
  source.spellcheck = false;
  source.hidden = true;
  source.setAttribute("role", "textbox");
  source.setAttribute("aria-label", "HTML 源码");

  const editButton = document.createElement("button");
  editButton.className = "mt-inline-html-edit";
  editButton.type = "button";
  editButton.textContent = "HTML </>";
  editButton.title = "编辑 HTML 源码";
  editButton.setAttribute("aria-label", "编辑 HTML 源码");
  editButton.hidden = true;
  wrapper.append(preview, source, editButton);

  let currentNode = node;
  let editing = false;
  const rawValue = (): string => String(currentNode.attrs.value ?? "");

  const renderPreview = (): void => {
    const value = rawValue();
    const tag = inlineHtmlTag(value);
    const isEmbed = tag !== null && EMBED_INLINE_HTML_TAGS.has(tag);
    const rendered =
      editableInlineHtmlTag(value) !== null || isNonEditableInlineHtml(value);
    wrapper.classList.toggle("mt-inline-html-node--embed", isEmbed);
    editButton.hidden = !isEmbed || editing;
    preview.classList.toggle("mt-inline-html-literal", !rendered);
    if (rendered) {
      preview.innerHTML = sanitizeHtml(value);
    } else {
      preview.textContent = value;
    }
    preview.hidden = false;
  };

  const closeSourceEditor = (): void => {
    editing = false;
    source.hidden = true;
    wrapper.classList.remove("mt-inline-html-source-editing");
    renderPreview();
  };

  const activateSourceEditor = (force = false): void => {
    if (editing || (!force && isNonEditableInlineHtml(rawValue()))) return;
    editing = true;
    source.textContent = rawValue();
    source.hidden = false;
    preview.hidden = true;
    editButton.hidden = true;
    wrapper.classList.add("mt-inline-html-source-editing");
    requestAnimationFrame(() => {
      source.focus();
      const selection = source.ownerDocument.getSelection();
      if (!selection) return;
      const range = source.ownerDocument.createRange();
      range.selectNodeContents(source);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  };

  const clearAtomSelection = (): void => {
    const pos = getPos();
    if (
      typeof pos !== "number" ||
      !(view.state.selection instanceof NodeSelection) ||
      view.state.selection.from !== pos
    ) {
      return;
    }
    try {
      view.dispatch(
        view.state.tr
          .setSelection(
            TextSelection.near(view.state.doc.resolve(pos), -1)
          )
          .setMeta("addToHistory", false)
      );
    } catch {
      /* Ignore selection cleanup when the node has just been replaced. */
    }
  };

  const commitSourceEditor = (focusEditor = false): void => {
    if (!editing) return;
    const next = source.textContent ?? "";
    const changed = next !== rawValue();
    const pos = getPos();
    const live = typeof pos === "number" ? view.state.doc.nodeAt(pos) : null;
    closeSourceEditor();

    if (
      changed &&
      typeof pos === "number" &&
      live &&
      live.type === currentNode.type
    ) {
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, {
          ...currentNode.attrs,
          value: next,
        })
      );
    }
    if (focusEditor) view.focus();
  };

  const startsSourceEditing = (): boolean =>
    !isNonEditableInlineHtml(rawValue());

  const activateOnPointer = (event: MouseEvent): void => {
    if (event.button !== 0 || !startsSourceEditing()) return;
    event.preventDefault();
    event.stopPropagation();
    activateSourceEditor();
  };
  preview.addEventListener("pointerdown", activateOnPointer);
  preview.addEventListener("mousedown", activateOnPointer);
  preview.addEventListener("click", (event) => {
    if (!startsSourceEditing()) return;
    event.preventDefault();
    event.stopPropagation();
    activateSourceEditor();
  });
  source.addEventListener("mousedown", (event) => event.stopPropagation());
  source.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeSourceEditor();
      view.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      commitSourceEditor(true);
    }
  });
  source.addEventListener("blur", () => commitSourceEditor(false));
  editButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  editButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  editButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    activateSourceEditor(true);
  });

  renderPreview();

  return {
    dom: wrapper,
    selectNode: () => {
      if (!startsSourceEditing()) return;
      requestAnimationFrame(() => {
        clearAtomSelection();
        activateSourceEditor();
      });
    },
    update: (newNode) => {
      if (newNode.type !== currentNode.type) return false;
      currentNode = newNode;
      if (!editing) {
        source.textContent = rawValue();
        renderPreview();
      }
      return true;
    },
    ignoreMutation: () => true,
    stopEvent: (event) =>
      event.target instanceof Node &&
      (source.contains(event.target) ||
        editButton.contains(event.target) ||
        (startsSourceEditing() && preview.contains(event.target))),
  };
};

export const htmlView = $view(
  htmlSchema.node as unknown as $Node,
  () => createInlineHtmlNodeView
);
