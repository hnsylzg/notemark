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

/** iframe 的 allow 属性中不允许出现的敏感权限（剥离，防止嵌入页滥用设备能力） */
const IFRAME_DENIED_PERMISSIONS = new Set([
  "camera", "microphone", "geolocation", "payment", "usb", "midi", "serial",
  "nfc", "bluetooth", "clipboard-read", "xr-spatial-tracking",
  "screen-wake-lock", "display-capture", "publickey-credentials-get",
]);

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
      el.removeAttribute("name");
      const allow = el.getAttribute("allow") ?? "";
      if (allow) {
        const parts = allow
          .split(";")
          .map((p) => p.trim())
          .filter(Boolean);
        el.setAttribute(
          "allow",
          parts
            .filter((p) => !IFRAME_DENIED_PERMISSIONS.has(p.split(/\s+/)[0].toLowerCase()))
            .join("; ")
        );
      }
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
 * - 绝对 http(s) / data:image / blob → 原样保留。
 */
function ensureImgSrc(el: Element): void {
  const src = el.getAttribute("src") ?? "";
  if (!src) return;
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
]);

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
      el.removeAttribute("name");
      const allow = el.getAttribute("allow") ?? "";
      if (allow) {
        const parts = allow
          .split(";")
          .map((p) => p.trim())
          .filter(Boolean);
        el.setAttribute(
          "allow",
          parts
            .filter((p) => !IFRAME_DENIED_PERMISSIONS.has(p.split(/\s+/)[0].toLowerCase()))
            .join("; ")
        );
      }
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
  }
  return template.innerHTML;
}

export const htmlView = $view(
  htmlSchema.node as unknown as $Node,
  () => (node) => {
  const span = document.createElement("span");
  span.dataset.type = "html";
  span.innerHTML = sanitizeHtml(node.attrs.value);
  return { dom: span };
});
