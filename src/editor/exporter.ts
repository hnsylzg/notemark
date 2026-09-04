/*
 * exporter.ts — 导出功能的公共基础（HTML / PDF / TXT / DOCX 共用）
 *
 * 职责：
 * - getEditorHtml()：取编辑器正文 HTML（渲染后的真实 DOM，含公式/图表/代码高亮）
 * - buildStandaloneHtml()：组装自包含 HTML（内联主题 CSS + 运行时样式 + 内嵌图片）
 * - htmlToPlainText()：HTML → 纯文本（TXT 导出）
 * - saveExportFile()：另存为对话框 + 写入文件
 *
 * 设计要点：
 * - 主题 CSS 用 Vite 的 `?inline` 在构建期拿到字符串，避免依赖运行时 <style>/
 *   <link>（生产构建下 Vite 会把 CSS 提取成 <link>，页面里取不到内容）。
 * - 运行时注入的样式（CodeMirror 动态高亮、用户自定义主题）仍从 <head> 收集，
 *   否则导出的代码会丢失配色。
 */

import type { Editor } from "@milkdown/kit/core";
// editorViewCtx 在运行时由 @milkdown/kit/core 导出（d.ts 遗漏声明），见 index.ts 说明。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore editorViewCtx 运行时可用（d.ts 未声明）
import { editorViewCtx } from "@milkdown/kit/core";
// 导出 / 打印自包含的 KaTeX 样式（字体已内联为 data URL），确保公式在 PDF 中正确渲染
import { katexExportCss } from "./katex-export-css";

// ?inline：以字符串形式导入处理后的主题 CSS（含 @import 展开），不注入页面
import themeCss from "@/editor/theme/index.css?inline";
// 语言列表：与编辑器注入 codeBlockConfig 的是同一数组实例，load() 带缓存，
// 导出前预热后，Milkdown 初始化代码块时可直接命中
import { languages } from "@codemirror/language-data";
// EditorView.findFromDOM 是 CM6 公开 API：从 DOM 反查每个代码块的 view 实例，
// 用于在导出前打开 CM6 的打印模式（viewState.printing）强制全量渲染
import { EditorView } from "@codemirror/view";

/** 是否处于 Tauri 环境 */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * 收集运行时注入到 <head> 的样式。
 * 生产构建下页面的 <style> 只包含动态注入内容：
 * - CodeMirror 语法高亮的 style-mod 规则（混淆类名，代码配色全靠它）
 * - 用户自定义主题（<style id="custom-theme">）
 */
function collectRuntimeStyles(): string {
  const parts: string[] = [];
  const styles = document.querySelectorAll<HTMLStyleElement>("head style");
  styles.forEach((el) => {
    const css = el.textContent;
    if (css && css.trim()) parts.push(css);
  });
  return parts.join("\n");
}

/**
 * 导出文档的基础排版。
 *
 * 关键：必须解除应用布局对高度的约束。index.css 里：
 * - html/body 是 height:100% / 100vh + overflow:hidden（窗口占满）
 * - .milkdown 是 height:100% + overflow-y:auto（编辑区滚动容器）
 * 导出时若沿用，浏览器打印只会输出第一屏（实测 40 个章节的文档仅 1 页，
 * 且滚动条被一起打印出来）。这里用 !important 全部重置为自然高度。
 */
const EXPORT_BASE_CSS = `
html, body {
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
  width: auto !important;
}
html { background: var(--mt-color-bg, #ffffff); }
body {
  margin: 0;
  background: var(--mt-color-bg, #ffffff);
  color: var(--mt-color-fg, #333333);
  font-family: var(--mt-font-body, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif);
}
.milkdown {
  height: auto !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: visible !important;
  padding: 0 !important;
  width: auto !important;
}
.mt-export-body {
  max-width: 860px;
  margin: 0 auto;
  padding: 40px 24px;
}
.mt-export-body img,
.mt-export-body svg { max-width: 100%; height: auto; }
`;

/** 打印（PDF）专用样式：去页边距容器、解除溢出裁剪、避免元素跨页断裂 */
const PRINT_CSS = `
@page { margin: 20mm 18mm; }
.mt-export-body { max-width: none; margin: 0; padding: 0; }
/* 代码块 / 表格 / 图表等容器在应用内有 overflow 限制，打印时需解除，
   否则跨页部分会被裁剪 */
.mt-export-body pre,
.mt-export-body blockquote,
.mt-export-body table,
.mt-export-body img,
.mt-export-body svg,
.mt-export-body .milkdown-code-block,
.mt-export-body .codemirror-host,
.mt-export-body .cm-editor,
.mt-export-body .cm-scroller,
.mt-export-body .diagram {
  max-height: none !important;
  overflow: visible !important;
}
.mt-export-body pre,
.mt-export-body blockquote,
.mt-export-body table,
.mt-export-body img { break-inside: avoid; }
.mt-export-body h1,
.mt-export-body h2,
.mt-export-body h3 { break-after: avoid; }
/* CM6 代码在编辑态默认不换行（white-space: pre）。中文字符占 1em 宽，
   长代码行（如长字符串常量）会把页面撑到 900+px；打印时 Chrome 对超宽
   内容做 shrink-to-fit 整页等比缩小，导致正文字号远小于设定值（实测
   14px 正文缩到约 9.8px、15px 缩到约 10px）。打印时强制代码换行并允许
   .cm-content 收缩（其 CM6 默认 flex-shrink: 0），让内容宽度始终不超过
   纸张可用宽度。行号 gutter 的 flex 布局不受影响。 */
.mt-export-body .cm-content,
.mt-export-body .cm-line {
  min-width: 0 !important;
  flex-shrink: 1 !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
  overflow-wrap: anywhere !important;
}
`;

export interface StandaloneHtmlOptions {
  /** 文档标题（同时作为 <title> 与文件名来源） */
  title: string;
  /** 编辑器正文 HTML */
  bodyHtml: string;
  /** 是否沿用深色外观（导出独立文件时沿用当前主题） */
  dark?: boolean;
  /** 是否用于打印（附加 @page 与防断裂规则） */
  forPrint?: boolean;
  /** 附加样式 */
  extraCss?: string;
}

/** HTML 文本转义（用于 <title>） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 组装自包含 HTML 文档（内联全部样式，可直接双击打开） */
export function buildStandaloneHtml(opts: StandaloneHtmlOptions): string {
  const { title, bodyHtml, dark = false, forPrint = false, extraCss = "" } = opts;
  const themeAttr = dark ? ' data-theme="dark"' : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${themeCss}</style>
<style>${katexExportCss}</style>
<style>${collectRuntimeStyles()}</style>
<style>${EXPORT_BASE_CSS}</style>
<style>${forPrint ? PRINT_CSS : ""}${extraCss}</style>
</head>
<body>
<div class="milkdown"${themeAttr}>
  <div class="editor mt-export-body">
${bodyHtml}
  </div>
</div>
</body>
</html>`;
}

/**
 * 取编辑器正文 HTML。
 * view.dom 即 ProseMirror 的可编辑根元素，其 innerHTML 是渲染后的真实结构：
 * 公式（KaTeX）、图表（Mermaid SVG）、代码块（CM6 含高亮 span）都已在 DOM 中。
 *
 * 注意：调用前应先 warmUpCodeBlocks()，它保证两件事：
 * 1. 所有代码块完成初始化（视口外默认只有纯文本占位，无语法高亮）
 * 2. CM6 打印模式下整块渲染（代码行默认按窗口可见区域虚拟化，视口外行会
 *    被 .cm-gap 占位，取到的 HTML 会缺行）
 */
export function getEditorHtml(editor: Editor): string {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    return view.dom.innerHTML;
  });
}

/** 等待 rAF 两帧（渲染阶段稳定点） */
function nextTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** 等一小段时间（用于轮询 placeholder / 高亮微任务落地） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** CM6 view 的内部句柄（viewState 未在 d.ts 公开，仅运行时存在） */
type CMViewInternals = { viewState?: { printing?: boolean } };

/** 块是否已渲染到整块（无 gap 占位且行数与文档一致） */
function blockFullyRendered(v: EditorView): boolean {
  return (
    !v.scrollDOM.querySelector(".cm-gap") &&
    v.scrollDOM.querySelectorAll(".cm-line").length >= v.state.doc.lines
  );
}

/**
 * 导出前准备所有代码块，保证取到的 HTML 语法高亮完整、行数齐全。
 *
 * @milkdown/components/code-block 的 NodeView（CodeMirrorBlock）用共享的
 * IntersectionObserver 做懒加载（root 为 null，即页面视口；rootMargin 200px）：
 * - 构造时只渲染占位 `<pre class="milkdown-code-block-placeholder">`，内容是纯文本
 * - 元素矩形进入视口（含 200px 余量）才回调 initializeCodeMirror()，该方法是
 *   同步的：创建 CM6 实例、mount Vue 组件（产生带高亮的 token span）
 * - 离开视口 5 秒后（TEARDOWN_DELAY）销毁实例并退回占位
 *
 * 官方没有"导出前渲染全部代码块"的开关（IO 在源码里硬编码），而 IO 的回调表
 * （visibilityCallbacks WeakMap）是模块私有的，无法直接调用。因此：
 *
 * 第一步（初始化）：把未初始化的代码块临时 `position: fixed` 叠到视口左上角，
 * 其矩形与视口的相交状态必然变化 → 共享 IO 下一帧回调 → 同步初始化。元素临时
 * visibility: hidden，全程无可见变化。轮询等待 placeholder 全部消失（超时兜底）。
 *
 * 第二步（全量渲染）：CM6 只为"浏览器窗口内可见"的代码行创建 DOM（源码
 * visiblePixelRange = scrollDOM 矩形与 innerWidth/innerHeight 的交集），其余行
 * 用一个 .cm-gap 占位——所以即使初始化完成，超过一屏的代码块取到的 HTML 仍
 * 缺行。CM6 为此内置了打印模式：打印事件会把内部开关 viewState.printing 置
 * true，像素视口改走 fullPixelRange（整块高度，无视窗口），全部行 DOM 化
 * （源码 onPrint / fullPixelRange，见 node_modules/@codemirror/view/dist/index.js）。
 * 打印开关由 DOMObserver 的 onPrint 写入，属内部实现，但字段运行时公开可写：
 * 这里用官方公开 API EditorView.findFromDOM() 拿到每个块的 view，直接写
 * viewState.printing（与 CM6 自身打印路径同一开关），measure 收敛后所有代码块
 * 行数齐全、.cm-gap 消失，随后立即复位。
 *
 * 方案史（均已证实不可行/已废弃）：
 * - scale(0.001) 缩放：transform 不改变元素在文档流中的位置，远端块的 rect
 *   仍在视口外，IO 不触发
 * - selection dispatch：PM 的 setSelection 只下探到"选区完全落在其内部"的
 *   那一个节点（viewdesc.setSelection 按 offset 逐子判断），不会广播给全部
 *   NodeView，远端代码块不会初始化
 * - 逐段滚动：能触发但用户可见整篇翻滚，观感差
 * - 离线重建 HTML（highlightTree 自算高亮）：可行但与编辑器渲染存在不一致风险
 * - 本方案已在 debug.html?mode=print 实测：128 个 30-60 行代码块全部满行渲染，
 *   .cm-gap 从 94 降至 0，恢复后行 DOM 保持，导出 HTML 不再缺行
 */
export async function warmUpCodeBlocks(editor: Editor): Promise<void> {
  const view = editor.action((ctx) => ctx.get(editorViewCtx));

  // 预热文档用到的语言包：LanguageDescription.load() 有缓存（this.loading），
  // 预热后 Milkdown 的 LanguageLoader.load() 直接拿到已 resolve 的 Promise
  const used = new Set<string>();
  view.state.doc.descendants((node) => {
    if (node.type.name === "code_block") {
      const lang = (node.attrs as { language?: unknown }).language;
      if (typeof lang === "string" && lang) used.add(lang);
    }
  });
  if (used.size > 0) {
    // 与 Milkdown 的 LanguageLoader 对齐：alias 全小写且含小写 name，
    // 匹配时同样转小写，保证预热命中同一个 LanguageDescription
    const usedLower = new Set(Array.from(used, (s) => s.toLowerCase()));
    await Promise.all(
      languages
        .filter((l) => l.alias.some((a) => usedLower.has(a)))
        .map((l) => l.load().catch(() => null))
    );
  }

  // 没有任何代码块则无需任何操作
  if (!view.dom.querySelector(".milkdown-code-block")) return;

  // 第一步：找出尚未初始化的代码块（内部仍是占位、没有 CM6 高亮 span），
  // 临时 fixed 到视口左上角触发共享 IO 初始化；记录原内联样式以便恢复。
  const pending = Array.from(
    view.dom.querySelectorAll<HTMLElement>(".milkdown-code-block")
  ).filter((el) => el.querySelector(".milkdown-code-block-placeholder"));
  const relocated: { el: HTMLElement; saved: Record<string, string> }[] = [];
  if (pending.length > 0) {
    for (const el of pending) {
      const saved = {
        position: el.style.position,
        top: el.style.top,
        left: el.style.left,
        width: el.style.width,
        visibility: el.style.visibility,
      };
      el.style.position = "fixed";
      el.style.top = "0";
      el.style.left = "0";
      // 折叠到视口左上角期间隐藏元素，避免任何瞬时闪现
      el.style.visibility = "hidden";
      relocated.push({ el, saved });
    }
    // 轮询等待全部占位初始化完成（IO 回调→同步 initializeCodeMirror），
    // 5s 超时兜底：已初始化的块足够多时导出仍可用，只是少部分丢失高亮
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await nextTwoFrames();
      if (!view.dom.querySelector(".milkdown-code-block-placeholder")) break;
      await sleep(50);
    }
  }

  // 第二步：打开 CM6 打印模式，强制每个块整块渲染。
  const views = Array.from(
    view.dom.querySelectorAll<HTMLElement>(".cm-editor")
  )
    .map((dom) => EditorView.findFromDOM(dom))
    .filter((v): v is EditorView => !!v);

  try {
    for (const v of views) {
      const vs = (v as unknown as CMViewInternals).viewState;
      if (vs) vs.printing = true;
    }
    if (views.length > 0) {
      // measure 循环直到全部块行数齐全（多数第一轮即收敛）
      for (let k = 0; k < 10; k++) {
        for (const v of views) {
          const anyV = v as unknown as { measure?: () => void };
          // 优先同步 measure（CM6 打印路径 onPrint 同款）；d.ts 未声明时退回公开 requestMeasure
          if (typeof anyV.measure === "function") anyV.measure();
          else v.requestMeasure();
        }
        await nextTwoFrames();
        if (views.every(blockFullyRendered)) break;
      }
    }
  } finally {
    // 复位打印模式（无论成功与否都要恢复，避免影响后续编辑）
    for (const v of views) {
      const vs = (v as unknown as CMViewInternals).viewState;
      if (vs) vs.printing = false;
    }
    // 恢复原位：DOM 结构从未变化，已生成的行 DOM 会保留到导出快照
    for (const { el, saved } of relocated) {
      el.style.position = saved.position;
      el.style.top = saved.top;
      el.style.left = saved.left;
      el.style.width = saved.width;
      el.style.visibility = saved.visibility;
    }
  }
}

/** Blob → data URL */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 把 HTML 中的图片内联为 data URL，使导出文件真正“自包含”。
 * 内联失败（跨域、协议限制）时保留原 src，不阻断导出流程。
 */
export async function inlineImages(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const images = Array.from(doc.querySelectorAll("img[src]"));
  if (images.length === 0) return html;
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:")) return;
      try {
        const res = await fetch(src);
        if (!res.ok) return;
        img.setAttribute("src", await blobToDataUrl(await res.blob()));
      } catch (err) {
        console.warn("[NoteMark] inline image failed:", src, err);
      }
    })
  );
  return doc.body.innerHTML;
}

/** 段落级元素：前后各加换行（段与段之间留一个空行） */
const PARAGRAPH_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "FIGCAPTION",
]);

/** 块级元素：仅在前面加换行（避免连续的块之间产生多余空行） */
const BLOCK_TAGS = new Set(["DIV", "TR", "PRE", "SECTION"]);

/**
 * 可容纳块级子元素的容器。
 * 这些元素内部由 HTML 缩进产生的纯空白文本节点应忽略（浏览器渲染同样忽略），
 * 否则列表项之间会莫名多出空行。
 */
const BLOCK_CONTAINERS = new Set([
  ...PARAGRAPH_TAGS,
  ...BLOCK_TAGS,
  "LI",
  "OL",
  "UL",
  "TABLE",
  "TBODY",
  "THEAD",
  "BODY",
]);

/**
 * HTML → 纯文本（TXT 导出）。
 *
 * 注意：不能用「每个块级元素前插换行」的朴素做法——列表项是 NodeView 渲染的
 * <li><div class="label-wrapper">1.</div><div class="children">正文</div></li>，
 * 那样会把编号和正文拆成两行。这里按语义递归：列表项整体作为一行输出。
 */
export function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = serializeNode(doc.body);
  return (
    text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n") // 行尾空白
      .replace(/\n{3,}/g, "\n\n") // 连续空行压成两个
      .trim() + "\n"
  );
}

/**
 * 递归序列化 DOM 为纯文本，按元素语义决定是否换行。
 * @param inBlock 当前是否处于块级上下文（决定纯空白文本节点是否忽略）
 */
function serializeNode(node: Node, inBlock = true): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      // 块级上下文：跳过纯空白文本（HTML 源码缩进，渲染时也不显示）。
      // 行内上下文必须保留，否则 "hello <b>world</b>" 会粘成 "helloworld"。
      if (inBlock && text.trim() === "") return;
      out += text;
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    const tag = el.tagName.toUpperCase();

    if (tag === "BR") {
      out += "\n";
      return;
    }
    if (tag === "HR") {
      out += "\n\n";
      return;
    }
    // 图标/图片无法用文字表达（圆点、复选框都是 SVG），跳过
    if (tag === "SVG" || tag === "IMG") return;

    // 列表容器：整体按段落级处理（前后各留换行，让不同列表之间分明），
    // 列表项之间则由 li 自身产生单换行，保持紧凑
    if (tag === "OL" || tag === "UL") {
      const inner = serializeNode(el, true).trim();
      if (inner) out += `\n${inner}\n`;
      return;
    }

    // 列表项：编号（或项目符号）与正文同属一行
    if (tag === "LI") {
      const label = collapseInline(
        el.querySelector(".label-wrapper")?.textContent ?? ""
      );
      const body = collapseInline(el.querySelector(".children")?.textContent ?? "");
      const line = [listItemPrefix(el, label), body].filter(Boolean).join(" ");
      if (line.trim()) out += `\n${line}`;
      return;
    }

    // 脚注定义：<dl data-type="footnote_definition"><dt>1</dt><dd>正文</dd></dl>
    // 编辑器里靠 CSS 排成 "1. 正文" 同行；纯文本需手动拼成一行，
    // 且 dt 后的点号是 CSS ::after 生成的，文本里没有，要补上
    if (tag === "DL" && el.getAttribute("data-type") === "footnote_definition") {
      const label = collapseInline(el.querySelector("dt")?.textContent ?? "");
      const body = collapseInline(el.querySelector("dd")?.textContent ?? "");
      const dot = label && !/[.。]$/.test(label) ? "." : "";
      const line = [label ? `${label}${dot}` : "", body].filter(Boolean).join(" ");
      // 按段落级处理：前后各留一个换行，与正文之间自然分隔
      if (line.trim()) out += `\n${line}\n`;
      return;
    }

    // 表格单元格：用制表符分隔（便于粘贴到表格软件），避免文字粘连
    if (tag === "TD" || tag === "TH") {
      const cell = collapseInline(el.textContent ?? "");
      if (cell) out += `${cell}\t`;
      return;
    }

    if (PARAGRAPH_TAGS.has(tag)) {
      const inner = serializeNode(el, true).trim();
      if (inner) out += `\n${inner}\n`;
      return;
    }

    if (BLOCK_TAGS.has(tag)) {
      const inner = serializeNode(el, true);
      if (!inner.trim()) return;
      // 列表项 NodeView 的包裹层（div.milkdown-list-item-block）本身不换行，
      // 换行交给内部的 li，否则相邻列表项之间会多出一个空行
      const isListItemWrapper =
        tag === "DIV" && /milkdown-list-item-block/.test(el.className || "");
      out += isListItemWrapper ? inner : `\n${inner}`;
      return;
    }

    // 其余行内元素（span / strong / em / code / a 等）：直接拼接内容
    out += serializeNode(el, BLOCK_CONTAINERS.has(tag));
  });
  return out;
}

/**
 * 列表项前缀：
 * - 任务列表：复选框是 SVG，按 data-checked 补 "[x] / [ ]"
 * - 有序列表：NodeView 已把编号渲染成文本（如 "1."），优先直接用；
 *   否则（未走 NodeView）按序号补 "n."
 * - 无序列表：圆点是 SVG、文本里没有，补 "•"
 *
 * 注意：不能用 parentElement 判断列表类型——NodeView 会给 li 套一层
 * div.milkdown-list-item-block，li 的父元素是 div 而非 ol/ul，
 * 必须用 closest() 向上找真实列表容器。
 */
function listItemPrefix(el: Element, labelText: string): string {
  if (el.getAttribute("data-item-type") === "task") {
    return el.getAttribute("data-checked") === "true" ? "[x]" : "[ ]";
  }
  // NodeView 渲染的编号（如 "1."）优先使用
  if (labelText) return labelText;
  const list = el.closest("ol, ul");
  const listTag = list?.tagName.toUpperCase();
  if (listTag === "OL") {
    const start = Number(list?.getAttribute("start") ?? 1);
    const siblings = list ? Array.from(list.querySelectorAll(":scope > li")) : [];
    const index = Math.max(0, siblings.indexOf(el));
    return `${start + index}.`;
  }
  return listTag === "UL" ? "•" : "";
}

/** 折叠空白：文本节点里的换行与缩进压成单个空格 */
function collapseInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 只弹出「另存为」对话框，不做任何耗时准备。
 * @returns 目标路径；用户取消返回 null
 */
export async function pickExportFile(
  defaultName: string,
  filters: { name: string; extensions: string[] }[]
): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters });
}

/** 把导出数据写入已选定的目标文件 */
export async function writeExportFile(
  target: string,
  data: string | Uint8Array
): Promise<void> {
  const { writeTextFile, writeFile } = await import("@tauri-apps/plugin-fs");
  if (typeof data === "string") await writeTextFile(target, data);
  else await writeFile(target, data);
}

/**
 * 弹出「另存为」对话框并写入文件（弹框后立即写，适合不需要长准备的导出）。
 * @returns 实际写入的路径；用户取消返回 null
 */
export async function saveExportFile(
  defaultName: string,
  filters: { name: string; extensions: string[] }[],
  data: string | Uint8Array
): Promise<string | null> {
  const target = await pickExportFile(defaultName, filters);
  if (!target) return null;
  await writeExportFile(target, data);
  return target;
}
