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

/** 允许渲染的 HTML 标签白名单 */
const SAFE_HTML_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del",
  "dfn", "em", "i", "iframe", "ins", "kbd", "mark", "q", "rp", "rt", "ruby", "s",
  "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
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
function sanitizeHtml(html: string): string {
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

export const htmlView = $view(
  htmlSchema.node as unknown as $Node,
  () => (node) => {
  const span = document.createElement("span");
  span.dataset.type = "html";
  span.innerHTML = sanitizeHtml(node.attrs.value);
  return { dom: span };
});
