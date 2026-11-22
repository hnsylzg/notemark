/*
 * format-menu.ts — 编辑区右键格式菜单
 *
 * 行内格式、图片、链接、脚注和常用块操作统一由本菜单提供。
 *
 * 交互（与 / 命令行为一致）：
 * - 有选中文字（且右键落在选区上）→ 菜单项对选区做格式 toggle；
 *   链接 = 给选中的文字加链接（只输地址，不替换文字）。
 * - 没有选中文字 → 点格式项把光标移到右键处并「开启输入」，后续输入的字
 *   自动带该格式，按 Esc 退出；点「链接」直接插入可编辑源码 `[]()`，
 *   光标停在方括号中，未输入内容就退出时自动清理。
 *
 * 实现：用 ProseMirror 插件的 handleDOMEvents.contextmenu 拦截编辑器右键。
 * 行内格式统一交给 editor-actions 的 applyFormatMark，再转由 mark-source 插件
 * 托管 Typora 式源码态：选中或空光标都先显示 Markdown 标记，离开后渲染，
 * 点击已渲染文字可重新展开标记。
 *
 * 协调：
 * - 所有组件共用同一菜单外壳，菜单中的“段落”槽位按上下文替换为
 *   表格、代码块、公式、图片等组件菜单。
 * - 图片、代码块、frontmatter/html 编辑块等区域仍由这里的统一入口
 *   捕获，不再进入浏览器原生菜单或第二套组件菜单。
 */
import { $prose } from "@milkdown/utils";
import { serializerCtx } from "@milkdown/kit/core";
import {
  AllSelection,
  NodeSelection,
  Plugin,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/prose/state";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  deleteTable,
  moveTableColumn,
  moveTableRow,
  selectedRect,
} from "@milkdown/prose/tables";
import {
  applyBlockAction,
  applyFormatMark,
  openImagePicker,
  runEditorCommand,
  type EditorBlockAction,
  type EditorInsertCommand,
} from "./editor-actions";
import { insertFootnote } from "./footnote";
import {
  appendFloatingLayer,
  clampFloatingLayer,
} from "./floating-layer";
import {
  presentContextMenu,
  type ContextMenuHandle,
} from "./context-menu-controller";
import {
  canConvertBlockSourceToHeading,
  convertBlockToTextblock,
  convertObjectBlockToTextblock,
  deleteObjectNode,
  objectBlockTextSource,
  objectClipboardSource,
  objectPlainTextSource,
  resolveObjectMenuContext,
  type ObjectMenuContext,
  type TextblockConversion,
} from "./object-menu-context";
import { setColumnAlignment } from "./table-commands";
import {
  normalizeTableClipboardHtml,
  tableHtmlToAlignedPlainText,
} from "./table-clipboard";
import {
  createHeadingTransaction,
  resolveTextblockTarget,
  type TextblockTarget,
} from "./heading-block";
import { formatHtmlFragment, prepareClipboardHtml } from "./html-source";
import { mathClipboardText, mathTex } from "./math-clipboard";
import { canvasToPngBlob, formulaSvgToCanvas } from "./math-image";
import {
  applyMermaidEdgeLabelBackground,
  resolveMermaidExportBackground,
} from "./mermaid-export";
import { insertInlineMath } from "./math-view";
import { formatImageMarkdown } from "./image-markdown";
import {
  MARK_SOURCE_SYNTAX,
  closeActiveMarkSource,
  markSourceKey,
  startMarkSource,
  startMarkSourceRange,
} from "./mark-source";
import { MENU_PRESERVE_EDITING_ATTRIBUTE } from "./menu-preserve";
import { insertLinkReferenceDefinition } from "./link-reference-definition";
import { normalizePastedMarkdown } from "./markdown-paste";
import {
  normalizeClipboardPlainText,
  readClipboardText,
  writeClipboardText,
} from "./clipboard-text";
import { HTML_SOURCE_CONTEXTMENU_EVENT } from "./html-block";
import { IMAGE_SOURCE_CONTEXTMENU_EVENT } from "./image-view";

export { normalizeClipboardPlainText };
import {
  Bold,
  ClipboardPaste,
  Code2,
  Copy,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Scissors,
  Sigma,
  Trash2,
  createElement as createIconElement,
  type IconNode,
} from "lucide";

/** 这些宿主区域由捕获阶段统一接管，避免 ProseMirror 再处理内部控件事件。 */
function isForeignTarget(target: Element | null): boolean {
  if (!target) return false;
  // 行内公式、图片等行内内容交给所在文字块的普通菜单处理。
  if (target.closest(".milkdown-math-inline, .milkdown-math-block")) return false;
  if (target.closest(".cm-content, .cm-editor")) return true; // 代码块（CodeMirror）
  if (target.closest(".mt-frontmatter, .mt-html-block")) return true;
  if (target.closest(".diagram, mjx-container, .md-iframe-wrap")) return true;
  return false;
}

interface Def {
  kind: "mark" | "inlineMath" | "link" | "image";
  markName?: string;
  label: string;
  icon?: string;
  hint?: string;
}

/** markName 为 PM schema marks 名；hint 显示在菜单右侧帮助记忆语法 */
const DEFS: Def[] = [
  { kind: "mark", markName: "strong", label: "加粗", icon: "B", hint: "**" },
  { kind: "mark", markName: "emphasis", label: "斜体", icon: "I", hint: "*" },
  { kind: "mark", markName: "strike_through", label: "删除线", icon: "S", hint: "~~" },
  { kind: "mark", markName: "inlineCode", label: "行内代码", icon: "`", hint: "`" },
  { kind: "mark", markName: "highlight", label: "高亮", icon: "▬", hint: "==" },
  { kind: "mark", markName: "underline", label: "下划线", icon: "U", hint: "<u>" },
  { kind: "mark", markName: "superscript", label: "上标", icon: "A²", hint: "^x^" },
  { kind: "mark", markName: "subscript", label: "下标", icon: "A₂", hint: "~x~" },
];

/** Block components whose source can be preserved while changing textblock type. */
const BLOCK_CONVERTIBLE_OBJECT_KINDS = new Set<ObjectMenuContext["kind"]>([
  "diagram",
  "html-block",
  "frontmatter",
  "toc",
  "horizontal-rule",
  "alert-title",
]);

const HEADING_LABELS = [
  "一级标题",
  "二级标题",
  "三级标题",
  "四级标题",
  "五级标题",
  "六级标题",
] as const;
const CODE_FENCE = "```";

function withCodeFence(source: string, language = ""): string {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  const opening = `${CODE_FENCE}${language}`;
  if (normalized.startsWith(`${opening}\n`)) return normalized;
  return `${opening}\n${normalized}\n${CODE_FENCE}`;
}

function quotedSource(lines: string[]): string {
  return lines
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
    .trimEnd();
}

function alertSourceCode(node: PMNode | null): string {
  const type = String(node?.attrs.alertType ?? "note").toUpperCase();
  const title = String(node?.attrs.title ?? "").trim();
  const marker = `[!${type}]${title ? ` ${title}` : ""}`;
  const body = node
    ? node.textBetween(0, node.content.size, "\n\n", "\n")
    : "";
  return quotedSource([marker, ...body.split("\n")]);
}

function blockquoteSourceCode(node: PMNode): string {
  return quotedSource(
    node.textBetween(0, node.content.size, "\n\n", "\n").split("\n")
  );
}

const ICONS = {
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  delete: Trash2,
  bold: Bold,
  italic: Italic,
  code: Code2,
  formula: Sigma,
  link: Link2,
  quote: Quote,
  orderedList: ListOrdered,
  bulletList: List,
  taskList: ListTodo,
} satisfies Record<string, IconNode>;

let menuHandle: ContextMenuHandle | null = null;
let activeView: EditorView | null = null;
/** 当前右键目标是否为公式；用于生成对象专属的剪贴板子菜单。 */
let activeMath: HTMLElement | null = null;
/** 菜单统一使用的合法光标位置（已规范到鼠标所在文本块内部） */
let hitPos = -1;
let hitSourceControl: TextSourceControl | null = null;
/** 段落转换使用右键时捕获的文本块快照，菜单打开后不再重新计算 */
let activeTextblock: TextblockTarget | null = null;
/** 第一次右键时保留 mousedown 阶段捕获的位置，contextmenu 直接复用 */
let pendingRightClick: {
  clientX: number;
  clientY: number;
  caretPos: number;
  textblock: TextblockTarget | null;
} | null = null;
type MarkdownSourceSerializer = (node: PMNode) => string;
const markdownSourceSerializers = new WeakMap<
  EditorView,
  MarkdownSourceSerializer
>();
interface CodeBlockMenuContext {
  element: HTMLElement;
  view: CodeMirrorView | null;
  fallbackText: string;
  fallbackElement: HTMLElement | null;
}
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function resetMenuState(): void {
  activeView = null;
  activeMath = null;
  hitPos = -1;
  hitSourceControl = null;
  activeTextblock = null;
}

function closeMenu(): void {
  const handle = menuHandle;
  menuHandle = null;
  handle?.close();
  resetMenuState();
}

/** 把光标移到 pos（右键处），用于「无选区时从此处开启输入」 */
function placeCaretAt(
  view: EditorView,
  pos: number,
  pointer = false
): void {
  const max = view.state.doc.content.size;
  const min = max > 0 ? 1 : 0;
  const safe = Math.max(min, Math.min(pos, max));
  let tr = view.state.tr.setSelection(
    TextSelection.create(view.state.doc, safe, safe)
  );
  if (pointer) tr = tr.setMeta("pointer", true);
  view.dispatch(tr);
}

/** 右键是否落在当前文字选区上（决定「转换选区」还是「光标处开启输入」） */
function hitOnSelection(view: EditorView, pos: number): boolean {
  const sel = view.state.selection;
  return !sel.empty && pos >= sel.from && pos <= sel.to;
}

function selectionInTableCell(view: EditorView): boolean {
  const $from = view.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.spec.tableRole === "cell") return true;
  }
  return false;
}

/** 浏览器原生选区是否覆盖右键目标（用于内联代码、链接等对象）。 */
function nativeSelectionIntersectsTarget(
  view: EditorView,
  target: Element | null
): boolean {
  if (!target || !view.dom.contains(target)) return false;
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index++) {
    try {
      if (selection.getRangeAt(index).intersectsNode(target)) return true;
    } catch {
      // 目标或 Range 已失效时继续检查下一个 Range。
    }
  }
  return false;
}

const TEXTBLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6";

/** 展开行内源码时，把光标限制在分隔符内部。 */
function clampToActiveMarkSource(view: EditorView, pos: number): number {
  const session = markSourceKey.getState(view.state);
  if (!session) return pos;
  const syntax = MARK_SOURCE_SYNTAX[session.markName];
  if (!syntax) return pos;
  const contentStart = session.from + syntax.open.length;
  const contentEnd = Math.max(
    contentStart,
    session.to - syntax.close.length
  );
  return Math.max(contentStart, Math.min(pos, contentEnd));
}

/**
 * Capture the paragraph under the pointer once, while the DOM event still has
 * its original target. ProseMirror's own mouse handling may update selection
 * or move the caret before contextmenu runs; neither is allowed to change the
 * paragraph targeted by any formatting or insertion command.
 */
function captureRightClick(
  view: EditorView,
  target: Element | null,
  clientX: number,
  clientY: number
): {
  clientX: number;
  clientY: number;
  caretPos: number;
  textblock: TextblockTarget | null;
} | null {
  const hit = view.posAtCoords({ left: clientX, top: clientY });
  const mathBlock =
    target?.closest<HTMLElement>(".milkdown-math-block") ?? null;
  if (mathBlock && view.dom.contains(mathBlock)) {
    let position = hit?.pos;
    if (position == null) {
      try {
        position = view.posAtDOM(mathBlock, 0, 1);
      } catch {
        return null;
      }
    }
    return {
      clientX,
      clientY,
      caretPos: position,
      textblock: null,
    };
  }

  const domBlock =
    target?.closest<HTMLElement>(TEXTBLOCK_SELECTOR) ??
    target
      ?.closest<HTMLElement>("dd")
      ?.querySelector<HTMLElement>(TEXTBLOCK_SELECTOR) ??
    null;
  let textblock: TextblockTarget | null = null;

  if (domBlock && view.dom.contains(domBlock)) {
    try {
      // `posAtDOM(block, 0, 1)` points just inside the block, independent of
      // where the live DOM selection currently is.
      textblock = resolveTextblockTarget(
        view.state.doc,
        view.posAtDOM(domBlock, 0, 1)
      );
    } catch {
      // Custom node views may not expose this DOM position; use hit testing.
    }
  }

  textblock ??= hit
    ? resolveTextblockTarget(view.state.doc, hit.pos)
    : null;
  if (!textblock) return null;

  const position = hit?.pos ?? textblock.contentStart;
  const contentEnd = textblock.contentStart + textblock.contentSize;
  textblock.caretOffset = Math.max(
    0,
    Math.min(position - textblock.contentStart, textblock.contentSize)
  );
  // posAtCoords can return a block boundary (before the paragraph or at
  // document end). That is not a legal in-paragraph caret and makes an empty
  // mark render on the next line. Normalize to the captured paragraph.
  const caretPos = Math.max(
    textblock.contentStart,
    Math.min(position, contentEnd)
  );

  const selection = view.state.selection;
  if (
    hit &&
    hitOnSelection(view, hit.pos) &&
    selection.from >= textblock.contentStart &&
    selection.to <= contentEnd
  ) {
    textblock.selection = {
      from: selection.from,
      to: selection.to,
    };
  }

  return {
    clientX,
    clientY,
    caretPos,
    textblock,
  };
}

function runMarkItem(
  view: EditorView,
  pos: number,
  def: Def,
  textblock: TextblockTarget | null
): void {
  const caretPos = textblock
    ? textblock.contentStart + textblock.caretOffset
    : pos;
  const keepSelection =
    hitOnSelection(view, pos) || hitOnSelection(view, caretPos);
  if (!keepSelection) placeCaretAt(view, caretPos);
  view.focus();
  applyFormatMark(view, def.markName as string, def.label);
}

function runInlineMathItem(
  view: EditorView,
  pos: number,
  textblock: TextblockTarget | null
): void {
  const caretPos = textblock
    ? textblock.contentStart + textblock.caretOffset
    : pos;
  if (!hitOnSelection(view, pos) && !hitOnSelection(view, caretPos)) {
    placeCaretAt(view, caretPos);
  }
  insertInlineMath(view);
}

function runImageItem(view: EditorView, pos: number): void {
  if (!hitOnSelection(view, pos)) placeCaretAt(view, pos);
  // 与 /图片 一致：宿主(App.vue)打开文件选择，插图到当前光标处。
  // 用 selection.to（选区【末尾】）而不是 from：选中一段文字时图片追加在后面，
  // 与脚注 / 行内公式保持一致，不把图片挤到选中文字前面去。
  openImagePicker(view, view.state.selection.to);
}

function runLinkItem(view: EditorView, pos: number): void {
  if (!hitOnSelection(view, pos)) placeCaretAt(view, pos);
  const sel = view.state.selection;
  if (!sel.empty) {
    const $f = view.state.doc.resolve(sel.from);
    const $t = view.state.doc.resolve(sel.to);
    if ($f.parent === $t.parent) {
      // 选中文字在同段内：给这段文字加链接（只输地址，不替换文字）
      promptLinkForSelection(view, sel.from, sel.to);
      return;
    }
    // 跨段选区：退化为普通插入
  }
  // 无选区：像加粗一样直接插入可编辑源码 `[]()`，光标停在方括号中。
  // 未输入内容就退出时由 mark-source 会话自动清理。
  if (!sel.empty) {
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, sel.to)
      )
    );
  }
  startMarkSource(view, "link");
}

function runDef(def: Def): void {
  const view = activeView;
  const pos = hitPos;
  const textblock = activeTextblock;
  closeMenu();
  if (!view || pos < 0) return;
  if (def.kind === "mark") {
    runMarkItem(view, pos, def, textblock);
  } else if (def.kind === "inlineMath") {
    runInlineMathItem(view, pos, textblock);
  } else if (def.kind === "image") {
    runImageItem(view, pos);
  } else {
    runLinkItem(view, pos);
  }
}

/**
 * 脚注：在右键处（选中文字时在其末尾）插入上标引用，同时在文末建一条定义，
 * 并把光标送进定义里直接输入内容。
 *
 * 与格式项一样，右键没落在选区上就先把光标挪过去；落在选区上则【保留选区】，
 * 由 insertFootnote 把引用插到选区末尾（选中文字不会被吞掉）。
 */
function runFootnote(): void {
  const view = activeView;
  const pos = hitPos;
  closeMenu();
  if (!view || pos < 0) return;
  if (!hitOnSelection(view, pos)) placeCaretAt(view, pos);
  insertFootnote(view);
}

function selectedSlice(view: EditorView) {
  const selection = view.state.selection;
  return selection.empty ? null : selection.content();
}

async function writeRichClipboard(html: string, text: string): Promise<void> {
  const clipboardText = normalizeClipboardPlainText(text);
  if (isTauri) {
    const { writeHtml } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeHtml(html, clipboardText);
    return;
  }
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([clipboardText], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // WebView may deny rich clipboard writes; retain plain-text fallback.
    }
  }

  // Legacy browser fallback keeps rich HTML when async ClipboardItem is absent.
  if (!isTauri) {
    const holder = document.createElement("div");
    holder.contentEditable = "true";
    holder.style.cssText =
      "position:fixed;left:-10000px;top:0;white-space:pre-wrap;";
    holder.innerHTML = html;
    document.body.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(holder);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const copied = document.execCommand("copy");
    selection?.removeAllRanges();
    holder.remove();
    if (copied) return;
  }
  await writeClipboardText(text);
}

async function copySelection(view: EditorView, cut: boolean): Promise<void> {
  const slice = selectedSlice(view);
  if (!slice) return;
  const serialized = view.serializeForClipboard(slice);
  const html = normalizeTableClipboardHtml(serialized.dom.innerHTML);
  const text =
    tableHtmlToAlignedPlainText(html) ?? serialized.text;
  await writeRichClipboard(html, text);
  if (cut) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    view.focus();
  }
}

async function copySelectionAsText(view: EditorView): Promise<void> {
  const slice = selectedSlice(view);
  if (!slice) return;
  const serialized = view.serializeForClipboard(slice);
  const { htmlToPlainText } = await import("./exporter");
  // 与 TXT 导出共用同一套语义转换：列表项同行、表格按显示宽度对齐、
  // 脚注补编号点、
  // 连续空行归一化等规则都与导出文件完全一致。
  await writeClipboardText(htmlToPlainText(serialized.dom.innerHTML));
}

/**
 * 将当前选区序列化为 HTML 源码文本。
 * 与 Typora 的“复制为 HTML 代码”一致：只复制选区，且不写入 data-pm-slice
 * 这类仅供 ProseMirror 内部粘贴恢复结构的标记。
 */
export function selectionHtmlSource(view: EditorView): string | null {
  const slice = selectedSlice(view);
  if (!slice) return null;
  const serialized = view.serializeForClipboard(slice);
  prepareClipboardHtml(serialized.dom);
  return normalizeTableClipboardHtml(formatHtmlFragment(serialized.dom));
}

async function copySelectionAsHtml(view: EditorView): Promise<void> {
  const html = selectionHtmlSource(view);
  if (html === null) return;
  await writeClipboardText(html);
}

async function copyCanvasImage(canvas: HTMLCanvasElement): Promise<void> {
  if (isTauri) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法读取图片像素");
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const { Image } = await import("@tauri-apps/api/image");
    const { writeImage } = await import(
      "@tauri-apps/plugin-clipboard-manager"
    );
    const image = await Image.new(
      new Uint8Array(rgba.buffer.slice(0)),
      canvas.width,
      canvas.height
    );
    try {
      await writeImage(image);
    } finally {
      await image.close();
    }
    return;
  }

  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    const blob = await canvasToPngBlob(canvas);
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob }),
    ]);
    return;
  }
  throw new Error("当前环境不支持图片剪贴板");
}

async function copyMathImage(math: HTMLElement): Promise<void> {
  const svg = math.querySelector<SVGSVGElement>("mjx-container svg");
  if (!svg) throw new Error("当前公式尚未完成渲染");
  await copyCanvasImage(await formulaSvgToCanvas(svg));
}

async function copyImageElement(image: HTMLImageElement): Promise<void> {
  const response = await fetch(image.currentSrc || image.src);
  if (!response.ok) throw new Error("无法读取图片内容");
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建图片画布");
    context.drawImage(bitmap, 0, 0);
    await copyCanvasImage(canvas);
  } finally {
    bitmap.close();
  }
}

function clickElement(element: Element | null): void {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function copyObjectToClipboard(
  context: ObjectMenuContext
): Promise<void> {
  if (context.kind === "diagram") {
    const svg = context.element.querySelector<SVGSVGElement>("svg");
    if (!svg) throw new Error("图表尚未完成渲染");
    const background = resolveMermaidExportBackground(context.element);
    await copyCanvasImage(
      await formulaSvgToCanvas(svg, (clone) =>
        applyMermaidEdgeLabelBackground(clone, background)
      )
    );
    return;
  }
  await writeClipboardText(objectClipboardSource(context));
}

export function htmlBlockVisibleText(element: Element): string {
  const preview = element.querySelector<HTMLElement>(
    ".mt-html-block-preview"
  );
  return (preview?.innerText || preview?.textContent || "").trim();
}

export function replaceHtmlBlockSource(
  view: EditorView,
  context: ObjectMenuContext,
  source: string
): boolean {
  if (
    context.kind !== "html-block" ||
    !context.node ||
    context.pos < 0
  ) {
    return false;
  }
  const live = view.state.doc.nodeAt(context.pos);
  if (live?.type.name !== "htmlBlock") return false;
  view.dispatch(
    view.state.tr
      .setNodeAttribute(context.pos, "value", source)
      .scrollIntoView()
  );
  view.focus();
  return true;
}

function tableElementToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.querySelectorAll<HTMLTableCellElement>("th, td")).map(
      (cell) =>
        (cell.innerText || cell.textContent || "")
          .trim()
          .replace(/\|/g, "\\|")
          .replace(/\r?\n/g, "<br>")
    )
  );
  const header = rows[0] ?? [];
  if (header.length === 0) return "";
  const cells = rows.map((row) =>
    header.map((_, index) => row[index] ?? "")
  );
  const firstRowCells = Array.from(
    table.querySelectorAll<HTMLTableCellElement>("tr:first-child th, tr:first-child td")
  );
  const separator = header.map((_, index) => {
    const align = firstRowCells[index]
      ? getComputedStyle(firstRowCells[index]).textAlign
      : "left";
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });
  return [header, separator, ...cells.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

function renderTableSubmenu(
  view: EditorView,
  tableCell: HTMLElement,
  panel: HTMLElement
): void {
  // The table menu reuses the paragraph submenu slot in the shared menu.
  panel.replaceChildren();

  const addTableAction = (
    label: string,
    run: (
      state: EditorState,
      dispatch?: (tr: Transaction) => void
    ) => boolean,
    danger = false,
    disabled = false
  ): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mt-context-menu__item";
    button.setAttribute("role", "menuitem");
    button.disabled = disabled;
    if (danger) button.classList.add("mt-context-menu__item--danger");
    const text = document.createElement("span");
    text.className = "mt-context-menu__label";
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", () => {
      closeMenu();
      run(view.state, view.dispatch);
      view.focus();
    });
    panel.append(button);
  };
  const addTableCommand = (
    label: string,
    run: () => void | Promise<void>,
    danger = false
  ): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mt-context-menu__item";
    button.setAttribute("role", "menuitem");
    if (danger) button.classList.add("mt-context-menu__item--danger");
    const text = document.createElement("span");
    text.className = "mt-context-menu__label";
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", () => {
      closeMenu();
      Promise.resolve(run()).catch((error) => {
        alert(
          `表格操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
    });
    panel.append(button);
  };
  const addTableSeparator = (): void => {
    const separator = document.createElement("div");
    separator.className = "mt-context-menu__sep";
    separator.setAttribute("role", "separator");
    panel.append(separator);
  };

  addTableAction("在上方插入行", addRowBefore);
  addTableAction("在下方插入行", addRowAfter);
  addTableSeparator();
  addTableAction("在左侧插入列", addColumnBefore);
  addTableAction("在右侧插入列", addColumnAfter);
  addTableSeparator();
  const rect = selectedRect(view.state);
  addTableAction(
    "上移该行",
    (state, dispatch) =>
      moveTableRow({
        pos: rect.tableStart,
        from: rect.top,
        to: rect.top - 1,
      })(state, dispatch),
    false,
    rect.top <= 0
  );
  addTableAction(
    "下移该行",
    (state, dispatch) =>
      moveTableRow({
        pos: rect.tableStart,
        from: rect.top,
        to: rect.top + 1,
      })(state, dispatch),
    false,
    rect.top >= rect.map.height - 1
  );
  addTableAction(
    "左移该列",
    (state, dispatch) =>
      moveTableColumn({
        pos: rect.tableStart,
        from: rect.left,
        to: rect.left - 1,
      })(state, dispatch),
    false,
    rect.left <= 0
  );
  addTableAction(
    "右移该列",
    (state, dispatch) =>
      moveTableColumn({
        pos: rect.tableStart,
        from: rect.left,
        to: rect.left + 1,
      })(state, dispatch),
    false,
    rect.left >= rect.map.width - 1
  );
  addTableSeparator();
  addTableAction("左对齐", setColumnAlignment("left"));
  addTableAction("居中对齐", setColumnAlignment("center"));
  addTableAction("右对齐", setColumnAlignment("right"));
  addTableSeparator();
  addTableAction("删除行", deleteRow, true);
  addTableAction("删除列", deleteColumn, true);
  addTableSeparator();
  const table = tableCell.closest<HTMLTableElement>("table");
  addTableCommand("复制表格", () => {
    if (!table) throw new Error("未找到表格");
    return writeRichClipboard(table.outerHTML, tableElementToMarkdown(table));
  });
  addTableCommand("格式化表格源码", () => {
    if (!table) throw new Error("未找到表格");
    return writeClipboardText(tableElementToMarkdown(table));
  });
  addTableSeparator();
  addTableAction("删除表格", deleteTable, true);
}

async function runMathCopy(
  action: "word" | "mathml" | "tex" | "image"
): Promise<void> {
  const view = activeView;
  const math = activeMath;
  closeMenu();
  if (!view || !math) return;

  try {
    if (action === "image") {
      await copyMathImage(math);
      return;
    }
    const tex = mathTex(math);
    const displayMode = math.classList.contains("milkdown-math-block");
    const text = await mathClipboardText(tex, action, displayMode);
    if (!text) {
      alert("无法将公式转换为 MathML。");
      return;
    }
    await writeClipboardText(text);
  } catch (error) {
    alert(`无法写入剪贴板：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    view.focus();
  }
}

function codeSelection(view: CodeMirrorView): { from: number; to: number } {
  const selection = view.state.selection.main;
  return { from: selection.from, to: selection.to };
}

export function tableCellPlainText(cell: HTMLElement): string {
  return (cell.innerText || cell.textContent || "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function resolveBlockNodeAt(
  view: EditorView,
  pos: number
): { node: PMNode; pos: number } | null {
  if (pos < 0) return null;
  const safe = Math.max(0, Math.min(pos, view.state.doc.content.size));
  const $pos = view.state.doc.resolve(safe);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.isBlock && node.type.name !== "doc") {
      return { node, pos: $pos.before(depth) };
    }
  }
  for (const candidate of [safe, safe - 1, safe + 1]) {
    if (candidate < 0 || candidate > view.state.doc.content.size) continue;
    const node = view.state.doc.nodeAt(candidate);
    if (node?.isBlock) return { node, pos: candidate };
  }
  return null;
}

function sourceNodeTargetAt(
  view: EditorView,
  element: Element,
  nodeNames: ReadonlySet<string>
): { node: PMNode; pos: number } | null {
  let pos = -1;
  try {
    pos = view.posAtDOM(element, 0);
  } catch {
    return null;
  }

  const safe = Math.max(0, Math.min(pos, view.state.doc.content.size));
  const $pos = view.state.doc.resolve(safe);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (nodeNames.has(node.type.name)) {
      return { node, pos: $pos.before(depth) };
    }
  }
  for (const candidate of [safe, safe - 1, safe + 1]) {
    if (candidate < 0 || candidate > view.state.doc.content.size) continue;
    const node = view.state.doc.nodeAt(candidate);
    if (node && nodeNames.has(node.type.name)) {
      return { node, pos: candidate };
    }
  }
  return null;
}

function sourceContainerTargetAt(
  view: EditorView,
  pos: number,
  nodeNames: ReadonlySet<string>
): { node: PMNode; pos: number } | null {
  if (pos < 0) return null;
  const safe = Math.max(0, Math.min(pos, view.state.doc.content.size));
  const $pos = view.state.doc.resolve(safe);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (nodeNames.has(node.type.name)) {
      return { node, pos: $pos.before(depth) };
    }
  }
  return null;
}

function deleteSourceTarget(
  view: EditorView,
  target: { node: PMNode; pos: number }
): void {
  const live = view.state.doc.nodeAt(target.pos);
  if (!live || live.type !== target.node.type) return;

  const $pos = view.state.doc.resolve(target.pos);
  const parent = $pos.parent;
  const paragraph = view.state.schema.nodes.paragraph?.createAndFill();
  const tr = view.state.tr;
  if (parent.childCount === 1 && paragraph) {
    tr.replaceWith(target.pos, target.pos + live.nodeSize, paragraph);
  } else {
    tr.delete(target.pos, target.pos + live.nodeSize);
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function normalizeMarkdownSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").trimEnd();
}

function serializeSourceNode(
  view: EditorView,
  node: PMNode | null
): string | null {
  if (!node) return null;
  const serializer = markdownSourceSerializers.get(view);
  if (!serializer) return null;
  try {
    const paragraph = view.state.schema.nodes.paragraph;
    const content =
      node.isInline && paragraph
        ? paragraph.create(null, node)
        : node;
    const doc = view.state.schema.nodes.doc.create(null, content);
    return normalizeMarkdownSource(serializer(doc));
  } catch {
    return null;
  }
}

function serializeSourceSelection(view: EditorView): string | null {
  const selection = view.state.selection;
  if (selection.empty) return null;
  const serializer = markdownSourceSerializers.get(view);
  if (!serializer) return null;
  try {
    const doc = view.state.schema.nodes.doc.create(
      null,
      selection.content().content
    );
    return normalizeMarkdownSource(serializer(doc));
  } catch {
    return null;
  }
}

async function pasteAt(
  view: EditorView,
  pos: number,
  stripTrailingLineBreak = false
): Promise<void> {
  view.focus();
  const target = clampToActiveMarkSource(view, pos);
  if (!hitOnSelection(view, target)) placeCaretAt(view, target);

  let html = "";
  let text = "";
  // Desktop paste goes straight through Tauri; calling navigator.clipboard.read
  // first triggers a browser permission prompt for tauri.localhost.
  if (!isTauri && navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (!html && item.types.includes("text/html")) {
          html = await (await item.getType("text/html")).text();
        }
        if (!text && item.types.includes("text/plain")) {
          text = await (await item.getType("text/plain")).text();
        }
      }
    } catch {
      // Permission denied or unsupported: use text clipboard below.
    }
  }
  if (!html && !text) {
    try {
      if (!isTauri && navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch {
      // Fall through to Tauri clipboard plugin.
    }
  }
  if (!html && !text && isTauri) {
    text = await readClipboardText();
  }
  if (html) view.pasteHTML(html);
  else if (text) {
    pasteMarkdownText(
      view,
      stripTrailingLineBreak ? stripTrailingClipboardLineBreak(text) : text
    );
  }
  view.focus();
}

/**
 * 用合成 paste 事件复用 Ctrl+V 完全相同的 Markdown 解析和插入链路。
 * “粘贴为纯文本”传入 normalize=false：剪贴板原文直接作为 Markdown 源，
 * 不额外添加、去除或改写任何 Markdown 转义，由 Milkdown 系统解析器渲染。
 */
function pasteMarkdownText(
  view: EditorView,
  text: string,
  normalize = true
): void {
  const source = normalize ? normalizePastedMarkdown(text) : text;
  try {
    const data = new DataTransfer();
    data.setData("text/plain", source);
    const event = new Event("paste", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "clipboardData", { value: data });
    // ProseMirror handlePaste 命中后会 preventDefault。
    if (!view.dom.dispatchEvent(event)) return;
  } catch {
    // WebView 不支持合成 ClipboardEvent 时回退纯文本。
  }
  view.pasteText(source);
}

async function pastePlainSourceAt(
  view: EditorView,
  pos: number,
  stripTrailingLineBreak = false
): Promise<void> {
  view.focus();
  const target = clampToActiveMarkSource(view, pos);
  if (!hitOnSelection(view, target)) placeCaretAt(view, target);
  const text = await readClipboardText();
  if (text) {
    pasteMarkdownText(
      view,
      stripTrailingLineBreak ? stripTrailingClipboardLineBreak(text) : text,
      false
    );
  }
  view.focus();
}

type TextSourceControl = HTMLInputElement | HTMLTextAreaElement;

function stripTrailingClipboardLineBreak(text: string): string {
  return text.replace(/(?:\r\n|\r|\n)$/, "");
}

const BLOCK_SOURCE_CONTROL_SELECTOR = [
  ".milkdown-math-inline-input",
  ".math-block-editor",
  ".diagram-editor",
  ".mt-frontmatter-body",
  ".mt-html-block-body",
  ".mt-link-reference-definition input",
  ".mt-footnote-label-source",
].join(", ");

function activeBlockSourceControl(): TextSourceControl | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
    return null;
  }
  return active.matches(BLOCK_SOURCE_CONTROL_SELECTOR) ? active : null;
}

function sourceControlAtTarget(
  target: Element | null
): TextSourceControl | null {
  if (!target) return null;
  const control =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
      ? target
      : target.closest(BLOCK_SOURCE_CONTROL_SELECTOR);
  return control instanceof HTMLInputElement ||
    control instanceof HTMLTextAreaElement
    ? control
    : null;
}

function currentBlockSourceControl(): TextSourceControl | null {
  return hitSourceControl ?? activeBlockSourceControl();
}

function replaceTextControlSelection(
  control: TextSourceControl,
  start: number,
  end: number,
  text: string
): void {
  control.focus();
  control.value =
    control.value.slice(0, start) + text + control.value.slice(end);
  const caret = start + text.length;
  control.setSelectionRange(caret, caret);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

async function pasteIntoSourceControl(
  control: TextSourceControl
): Promise<void> {
  const start = control.selectionStart ?? control.value.length;
  const end = control.selectionEnd ?? start;
  const text = stripTrailingClipboardLineBreak(await readClipboardText());
  if (!text || !control.isConnected) return;
  replaceTextControlSelection(control, start, end, text);
}

function runQuickAction(
  action: "cut" | "copy" | "paste" | "delete",
  tableContext = false
): void {
  const view = activeView;
  const pos = hitPos;
  const sourceControl =
    action === "paste" ? currentBlockSourceControl() : null;
  const tablePaste =
    action === "paste" &&
    !!view &&
    (tableContext || selectionInTableCell(view));
  closeMenu();
  if (!view) return;
  try {
    if (action === "copy" || action === "cut") {
      void copySelection(view, action === "cut").catch((error) => {
        alert(`无法写入剪贴板：${error instanceof Error ? error.message : String(error)}`);
      });
    } else if (action === "paste") {
      const paste = sourceControl
        ? pasteIntoSourceControl(sourceControl)
        : pasteAt(view, pos, tablePaste);
      void paste.catch((error) => {
        alert(`无法读取剪贴板：${error instanceof Error ? error.message : String(error)}`);
      });
    } else if (!view.state.selection.empty) {
      view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    }
  } finally {
    if (!sourceControl) view.focus();
  }
}

function runCodeBlockQuickAction(
  context: CodeBlockMenuContext,
  action: "cut" | "copy" | "paste" | "delete"
): void {
  const view = context.view;
  closeMenu();
  if (!view) return;
  const selection = codeSelection(view);
  const hasSelection = selection.from !== selection.to;

  try {
    if (action === "copy" || action === "cut") {
      if (!hasSelection) return;
      void writeClipboardText(
        view.state.sliceDoc(selection.from, selection.to)
      ).then(() => {
        if (action === "cut") {
          view.dispatch({
            changes: { from: selection.from, to: selection.to },
            selection: { anchor: selection.from },
          });
        }
      }).catch((error) => {
        alert(
          `无法写入剪贴板：${error instanceof Error ? error.message : String(error)}`
        );
      });
    } else if (action === "paste") {
      void readClipboardText().then((text) => {
        const pasteText = stripTrailingClipboardLineBreak(text);
        view.dispatch({
          changes: {
            from: selection.from,
            to: selection.to,
            insert: pasteText,
          },
          selection: { anchor: selection.from + pasteText.length },
        });
      }).catch((error) => {
        alert(
          `无法读取剪贴板：${error instanceof Error ? error.message : String(error)}`
        );
      });
    } else if (hasSelection) {
      view.dispatch({
        changes: { from: selection.from, to: selection.to },
        selection: { anchor: selection.from },
      });
    }
  } finally {
    view.focus();
  }
}

function runObjectQuickAction(
  context: ObjectMenuContext,
  action: "cut" | "copy" | "paste" | "delete"
): void {
  const view = activeView;
  const sourceControl =
    action === "paste" ? currentBlockSourceControl() : null;
  closeMenu();
  if (action === "cut" && context.kind === "html-block") {
    void writeClipboardText(context.source)
      .then(() => {
        if (view) deleteObjectNode(view, context);
      })
      .catch((error) => {
        alert(
          `无法写入剪贴板：${error instanceof Error ? error.message : String(error)}`
        );
      });
    return;
  }
  if (action === "copy") {
    if (context.kind === "diagram") {
      void writeClipboardText(context.source)
        .then(() => view?.focus())
        .catch((error) => {
          alert(
            `无法写入剪贴板：${error instanceof Error ? error.message : String(error)}`
          );
        });
      return;
    }
    void copyObjectToClipboard(context).catch((error) => {
      alert(
        `对象复制失败：${error instanceof Error ? error.message : String(error)}`
      );
    });
  } else if (action === "paste" && sourceControl) {
    void pasteIntoSourceControl(sourceControl).catch((error) => {
      alert(
        `无法读取剪贴板：${error instanceof Error ? error.message : String(error)}`
      );
    });
  } else if (action === "paste" && context.kind === "html-block") {
    void readClipboardText()
      .then((text) => {
        if (view) {
          replaceHtmlBlockSource(
            view,
            context,
            stripTrailingClipboardLineBreak(text)
          );
        }
      })
      .catch((error) => {
        alert(
          `无法读取剪贴板：${error instanceof Error ? error.message : String(error)}`
        );
      });
  } else if (action === "delete") {
    if (view) deleteObjectNode(view, context);
  }
}

function replaceHtmlSourceSelection(
  editor: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string
): void {
  replaceTextControlSelection(
    editor,
    start,
    end,
    stripTrailingClipboardLineBreak(text)
  );
}

interface HtmlSourceSelection {
  start: number;
  end: number;
}

function currentHtmlSourceSelection(
  editor: HTMLTextAreaElement
): HtmlSourceSelection {
  return {
    start: editor.selectionStart,
    end: editor.selectionEnd,
  };
}

export function htmlSourceCopyText(
  editor: HTMLTextAreaElement,
  selection: HtmlSourceSelection = currentHtmlSourceSelection(editor)
): string {
  return selection.end > selection.start
    ? editor.value.slice(selection.start, selection.end)
    : editor.value;
}

function currentContentEditableSelection(
  editor: HTMLElement
): HtmlSourceSelection {
  const text = editor.textContent ?? "";
  const selection = editor.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { start: text.length, end: text.length };
  }
  const range = selection.getRangeAt(0);
  if (
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  ) {
    return { start: text.length, end: text.length };
  }
  const beforeStart = range.cloneRange();
  beforeStart.selectNodeContents(editor);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = range.cloneRange();
  beforeEnd.selectNodeContents(editor);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  return {
    start: beforeStart.toString().length,
    end: beforeEnd.toString().length,
  };
}

export function contentEditableSourceCopyText(
  editor: HTMLElement,
  selection: HtmlSourceSelection = currentContentEditableSelection(editor)
): string {
  const text = editor.textContent ?? "";
  return selection.end > selection.start
    ? text.slice(selection.start, selection.end)
    : text;
}

function replaceContentEditableSelection(
  editor: HTMLElement,
  selection: HtmlSourceSelection,
  text: string
): void {
  const value = editor.textContent ?? "";
  const next =
    value.slice(0, selection.start) + text + value.slice(selection.end);
  editor.textContent = next;
  editor.focus();

  const caret = selection.start + text.length;
  const range = editor.ownerDocument.createRange();
  const textNode = editor.firstChild;
  if (textNode?.nodeType === Node.TEXT_NODE) {
    range.setStart(textNode, Math.min(caret, textNode.textContent?.length ?? 0));
  } else {
    range.selectNodeContents(editor);
  }
  range.collapse(true);
  const domSelection = editor.ownerDocument.getSelection();
  domSelection?.removeAllRanges();
  domSelection?.addRange(range);
}

function copyHtmlSourceSelection(
  editor: HTMLTextAreaElement,
  selection: HtmlSourceSelection
): void {
  const text = htmlSourceCopyText(editor, selection);
  if (!text) {
    editor.focus();
    return;
  }
  closeMenu();
  void writeClipboardText(text)
    .then(() => editor.focus())
    .catch((error) => {
      alert(
        `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
      );
    });
}

function copyImageSourceSelection(
  editor: HTMLElement,
  selection: HtmlSourceSelection
): void {
  const text = contentEditableSourceCopyText(editor, selection);
  if (!text) {
    editor.focus();
    return;
  }
  closeMenu();
  void writeClipboardText(text)
    .then(() => editor.focus())
    .catch((error) => {
      alert(
        `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
      );
    });
}

function pasteHtmlSourceSelection(
  editor: HTMLTextAreaElement,
  selection: HtmlSourceSelection
): void {
  closeMenu();
  void readClipboardText()
    .then((text) =>
      replaceHtmlSourceSelection(
        editor,
        selection.start,
        selection.end,
        text
      )
    )
    .catch((error) => {
      alert(
        `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
      );
    });
}

function pasteImageSourceSelection(
  editor: HTMLElement,
  selection: HtmlSourceSelection
): void {
  closeMenu();
  void readClipboardText()
    .then((text) =>
      replaceContentEditableSelection(
        editor,
        selection,
        stripTrailingClipboardLineBreak(text)
      )
    )
    .catch((error) => {
      alert(
        `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
      );
    });
}

function runHtmlSourceQuickAction(
  editor: HTMLTextAreaElement,
  action: "cut" | "copy" | "paste" | "delete",
  selection: HtmlSourceSelection
): void {
  const { start, end } = selection;
  const selected = editor.value.slice(start, end);
  const hasSelection = end > start;
  closeMenu();
  if ((action === "cut" || action === "copy" || action === "delete") && !hasSelection) {
    editor.focus();
    return;
  }
  if (action === "copy") {
    void writeClipboardText(selected)
      .then(() => editor.focus())
      .catch((error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
    return;
  }
  if (action === "cut") {
    void writeClipboardText(selected)
      .then(() => replaceHtmlSourceSelection(editor, start, end, ""))
      .catch((error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
    return;
  }
  if (action === "delete") {
    replaceHtmlSourceSelection(editor, start, end, "");
    return;
  }
  void readClipboardText()
    .then((text) => replaceHtmlSourceSelection(editor, start, end, text))
    .catch((error) => {
      alert(
        `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
      );
    });
}

function runImageSourceQuickAction(
  editor: HTMLElement,
  action: "cut" | "copy" | "paste" | "delete",
  selection: HtmlSourceSelection
): void {
  const selected = contentEditableSourceCopyText(editor, selection);
  const hasSelection = selection.end > selection.start;
  closeMenu();
  if ((action === "cut" || action === "copy" || action === "delete") && !hasSelection) {
    editor.focus();
    return;
  }
  if (action === "copy") {
    void writeClipboardText(selected)
      .then(() => editor.focus())
      .catch((error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
    return;
  }
  if (action === "cut") {
    void writeClipboardText(selected)
      .then(() => replaceContentEditableSelection(editor, selection, ""))
      .catch((error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
    return;
  }
  if (action === "delete") {
    replaceContentEditableSelection(editor, selection, "");
    return;
  }
  void readClipboardText()
    .then((text) =>
      replaceContentEditableSelection(editor, selection, text)
    )
    .catch((error) => {
      alert(
        `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
      );
    });
}

function runClipboardAs(
  action: "copyText" | "copyHtml" | "pasteText"
): void {
  const view = activeView;
  const pos = hitPos;
  const sourceControl =
    action === "pasteText" ? currentBlockSourceControl() : null;
  const tablePaste =
    action === "pasteText" && !!view && selectionInTableCell(view);
  closeMenu();
  if (!view) return;
  if (action === "copyText") {
    void copySelectionAsText(view).catch((error) => {
      alert(`无法写入剪贴板：${error instanceof Error ? error.message : String(error)}`);
    });
  } else if (action === "copyHtml") {
    void copySelectionAsHtml(view).catch((error) => {
      alert(`无法写入剪贴板：${error instanceof Error ? error.message : String(error)}`);
    });
  } else if (action === "pasteText") {
    const paste = sourceControl
      ? pasteIntoSourceControl(sourceControl)
      : pastePlainSourceAt(view, pos, tablePaste);
    void paste.catch((error) => {
      alert(`无法读取剪贴板：${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

function runBlockItem(action: EditorBlockAction): void {
  const view = activeView;
  const pos = hitPos;
  closeMenu();
  if (!view || pos < 0) return;
  let targetPos = pos;
  if (hitOnSelection(view, pos)) {
    const selected = view.state.selection;
    const $selected = selected.$from;
    let selectedDepth = $selected.depth;
    while (
      selectedDepth > 0 &&
      !$selected.node(selectedDepth).isTextblock
    ) {
      selectedDepth -= 1;
    }
    if (
      selectedDepth > 0 &&
      $selected.node(selectedDepth).type.name === "heading"
    ) {
      targetPos = selected.from;
    }
  }
  view.focus();
  placeCaretAt(view, targetPos);
  applyBlockAction(view, action);
}

function applyHeadingLevel(level: 1 | 2 | 3 | 4 | 5 | 6): void {
  const view = activeView;
  const target = activeTextblock;
  closeMenu();
  if (!view || !target) return;

  const tr = createHeadingTransaction(view.state, target, level);
  if (!tr) {
    console.warn("[format-menu] 当前文本块无法转换为标题");
    view.focus();
    return;
  }

  // Build and dispatch against the captured block only. Do not query the live
  // selection or mouse coordinates here; on the first native right-click those
  // can still describe the pre-focus caret rather than the clicked paragraph.
  view.dispatch(tr);
  view.focus();
}

function runInsertCommand(id: EditorInsertCommand): void {
  const view = activeView;
  const pos = hitPos;
  closeMenu();
  if (!view || pos < 0) return;
  view.focus();
  placeCaretAt(view, pos);
  runEditorCommand(view, id);
}

function insertParagraphNear(before: boolean): void {
  const view = activeView;
  const pos = hitPos;
  closeMenu();
  if (!view || pos < 0) return;
  view.focus();
  if (!hitOnSelection(view, pos)) placeCaretAt(view, pos);

  const paragraph = view.state.schema.nodes.paragraph;
  const { $from } = view.state.selection;
  let depth = $from.depth;
  while (depth > 0 && !$from.node(depth).isTextblock) depth -= 1;
  if (depth === 0) return;

  const insertPos = before ? $from.before(depth) : $from.after(depth);
  let tr = view.state.tr.insert(insertPos, paragraph.create());
  tr = tr
    .setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)))
    .scrollIntoView();
  view.dispatch(tr);
  view.focus();
}

/** 给选中文字加链接（与 /链接 的"插入占位"不同：保留并转换已有文字） */
function promptLinkForSelection(view: EditorView, from: number, to: number): void {
  const linkType = view.state.schema.marks["link"];
  if (!linkType) return;
  const box = document.createElement("div");
  box.className = "mt-slash-linkbox";
  appendFloatingLayer(box);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "mt-slash-linkbox__input";
  input.value = "https://";
  input.setAttribute("spellcheck", "false");
  box.appendChild(input);

  const tip = document.createElement("span");
  tip.className = "mt-slash-linkbox__tip";
  tip.textContent = "为选中文字加链接 · Enter 确认 · Esc 取消";
  box.appendChild(tip);

  // 定位到选区起点下方（与 /链接 的浮层一致；浮层期间文档不应变动）
  try {
    const coords = view.coordsAtPos(from);
    clampFloatingLayer(box, coords.left, coords.bottom + 6, 8);
  } catch {
    /* 位置失效时保持默认角落 */
  }

  const close = (): void => {
    box.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("scroll", onScroll, true);
  };
  const onDown = (e: MouseEvent): void => {
    if (!box.contains(e.target as Node)) {
      e.stopPropagation();
      close();
      view.focus();
    }
  };
  const onScroll = (): void => close();
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const href = input.value.trim();
      close();
      if (href) {
        const tr = view.state.tr
          .addMark(from, to, linkType.create({ href }))
          .scrollIntoView();
        view.dispatch(tr);
        startMarkSourceRange(view, "link", from, to);
      }
      view.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      view.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  window.addEventListener("scroll", onScroll, true);

  input.focus();
  input.select();
}

/** 在右键坐标处弹出菜单 */
function openMenu(
  view: EditorView,
  clientX: number,
  clientY: number,
  pos: number,
  textblock: TextblockTarget | null,
  math: HTMLElement | null,
  codeBlock: CodeBlockMenuContext | null = null,
  objectMenu: ObjectMenuContext | null = null,
  tableCell: HTMLElement | null = null,
  inlineMath: HTMLElement | null = null,
  inlineImage: HTMLImageElement | null = null,
  sourceEditor: HTMLTextAreaElement | null = null,
  imageSourceEditor: HTMLElement | null = null,
  sourceControl: TextSourceControl | null = null
): void {
  closeMenu();
  activeView = view;
  activeMath = math ?? inlineMath;
  hitPos = pos;
  hitSourceControl = sourceControl;
  activeTextblock = textblock;

  const menu = document.createElement("div");
  menu.className = "mt-context-menu mt-context-menu--typora";
  menu.setAttribute("role", "menu");

  const addSeparator = (parent: HTMLElement = menu): void => {
    const separator = document.createElement("div");
    separator.className = "mt-context-menu__sep";
    separator.setAttribute("role", "separator");
    parent.appendChild(separator);
  };

  const addRow = (
    parent: HTMLElement,
    icon: string,
    label: string,
    shortcut?: string,
    opts?: {
      active?: boolean;
      disabled?: boolean;
      danger?: boolean;
    }
  ): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mt-context-menu__item";
    btn.setAttribute("role", "menuitem");
    if (opts?.active) btn.classList.add("is-active");
    if (opts?.danger) btn.classList.add("mt-context-menu__item--danger");
    btn.disabled = !!opts?.disabled;
    const iconSpan = document.createElement("span");
    iconSpan.className = "mt-context-menu__icon";
    iconSpan.textContent = icon;
    const textSpan = document.createElement("span");
    textSpan.className = "mt-context-menu__label";
    textSpan.textContent = label;
    if (icon || parent.classList.contains("mt-context-menu__submenu")) {
      btn.appendChild(iconSpan);
    }
    btn.appendChild(textSpan);
    if (shortcut) {
      const shortcutSpan = document.createElement("span");
      shortcutSpan.className = "mt-context-menu__shortcut";
      shortcutSpan.textContent = shortcut;
      btn.appendChild(shortcutSpan);
    }
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    parent.appendChild(btn);
    return btn;
  };

  const addIconButton = (
    parent: HTMLElement,
    icon: keyof typeof ICONS,
    label: string,
    run: () => void,
    opts?: {
      active?: boolean;
      disabled?: boolean;
      danger?: boolean;
      preserveEditing?: boolean;
    }
  ): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mt-context-menu__item mt-context-menu__item--icon";
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-label", label);
    btn.title = label;
    if (opts?.preserveEditing) {
      btn.setAttribute(MENU_PRESERVE_EDITING_ATTRIBUTE, "");
    }
    if (opts?.active) btn.classList.add("is-active");
    if (opts?.danger) btn.classList.add("mt-context-menu__item--danger");
    btn.disabled = !!opts?.disabled;
    const iconSpan = document.createElement("span");
    iconSpan.className = "mt-context-menu__icon";
    iconSpan.appendChild(createIconElement(ICONS[icon]));
    btn.appendChild(iconSpan);
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", run);
    parent.appendChild(btn);
    return btn;
  };

  const finishMenu = (): void => {
    menuHandle = presentContextMenu({
      menu,
      clientX,
      clientY,
      onClose: resetMenuState,
    });
  };

  const submenus: Array<{
    button: HTMLButtonElement;
    panel: HTMLDivElement;
    parent: HTMLElement;
  }> = [];
  const addSubmenu = (
    icon: string,
    label: string,
    parent: HTMLElement = menu
  ): HTMLDivElement => {
    const button = addRow(parent, icon, label);
    button.classList.add("mt-context-menu__item--submenu");
    const panel = document.createElement("div");
    panel.className = "mt-context-menu__submenu";
    panel.setAttribute("role", "menu");
    panel.hidden = true;
    menu.appendChild(panel);
    const open = (): void => {
      const visiblePanels = new Set<HTMLElement>([panel]);
      let ancestor: HTMLElement | null = parent;
      while (ancestor && ancestor !== menu) {
        visiblePanels.add(ancestor);
        const entry = submenus.find((item) => item.panel === ancestor);
        ancestor = entry?.parent ?? menu;
      }
      submenus.forEach((entry) => {
        if (!visiblePanels.has(entry.panel)) {
          entry.panel.hidden = true;
          entry.button.classList.remove("is-submenu-open");
        }
      });
      panel.hidden = false;
      button.classList.add("is-submenu-open");
      const menuRect = menu.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const panelHeight = panel.offsetHeight;
      const minTop = 6 - menuRect.top;
      const maxTop = window.innerHeight - menuRect.top - panelHeight - 6;
      panel.style.top = `${Math.max(
        minTop,
        Math.min(buttonRect.top - menuRect.top - 4, maxTop)
      )}px`;
      const panelWidth = panel.offsetWidth;
      const rightCandidate = buttonRect.right - menuRect.left - 2;
      const leftCandidate = buttonRect.left - menuRect.left - panelWidth + 2;
      const desiredLeft =
        rightCandidate + panelWidth <= window.innerWidth - 6
          ? rightCandidate
          : leftCandidate;
      const minLeft = 6 - menuRect.left;
      const maxLeft = window.innerWidth - menuRect.left - panelWidth - 6;
      panel.style.left = `${Math.max(
        minLeft,
        Math.min(desiredLeft, maxLeft)
      )}px`;
      panel.style.right = "auto";
    };
    button.addEventListener("mouseenter", open);
    button.addEventListener("click", open);
    submenus.push({ button, panel, parent });
    return panel;
  };

  let contextSlot: HTMLElement | null = null;
  let contextLabel = tableCell ? "表格" : "段落";

  if (objectMenu) {
    const objectLabels: Record<ObjectMenuContext["kind"], string> = {
      diagram: "代码块",
      "html-block": "HTML",
      "link-reference-definition": "链接引用",
      "footnote-reference": "脚注索引",
      frontmatter: "Front Matter",
      toc: "目录",
      "horizontal-rule": "水平线",
      "alert-title": "段落",
    };
    contextLabel =
      sourceEditor && objectMenu.kind === "html-block"
        ? "HTML 源码"
        : objectLabels[objectMenu.kind];
    contextSlot = document.createElement("div");
    contextSlot.className = "mt-context-menu__submenu";
    const objectPanel = contextSlot;
    const ensureObjectPanel = (): HTMLElement => objectPanel;
    const addObjectAction = (
      label: string,
      shortcut: string,
      run: () => void | Promise<void>,
      opts?: { active?: boolean; disabled?: boolean; danger?: boolean }
    ): void => {
      const button = addRow(
        ensureObjectPanel(),
        "",
        label,
        shortcut,
        opts
      );
      button.addEventListener("click", () => {
        closeMenu();
        Promise.resolve(run()).catch((error) => {
          alert(
            `对象操作失败：${error instanceof Error ? error.message : String(error)}`
          );
        });
      });
    };
    switch (objectMenu.kind) {
      case "diagram": {
        break;
      }
      case "html-block": {
        break;
      }
      case "link-reference-definition": {
        break;
      }
      case "footnote-reference": {
        break;
      }
      case "frontmatter": {
        break;
      }
      case "toc": {
        break;
      }
      case "horizontal-rule": {
        break;
      }
      case "alert-title": {
        break;
      }
    }

    if (BLOCK_CONVERTIBLE_OBJECT_KINDS.has(objectMenu.kind)) {
      const conversionContext =
        sourceEditor && objectMenu.kind === "html-block"
          ? { ...objectMenu, source: sourceEditor.value }
          : objectMenu;
      const conversionSource = objectBlockTextSource(conversionContext);
      addObjectAction(
        "段落",
        "Ctrl+0",
        () => {
          if (objectMenu.kind === "alert-title") return;
          convertObjectBlockToTextblock(view, conversionContext, {
            type: "paragraph",
          });
        },
        {
          active: objectMenu.kind === "alert-title",
        }
      );
      if (
        !sourceEditor &&
        (objectMenu.kind === "alert-title" ||
          (objectMenu.kind !== "diagram" &&
            objectMenu.kind !== "toc" &&
            canConvertBlockSourceToHeading(conversionSource)))
      ) {
        const levels: Array<{
          label: string;
          shortcut: string;
          level: 1 | 2 | 3 | 4 | 5 | 6;
        }> = [
          { label: "一级标题", shortcut: "Ctrl+1", level: 1 },
          { label: "二级标题", shortcut: "Ctrl+2", level: 2 },
          { label: "三级标题", shortcut: "Ctrl+3", level: 3 },
          { label: "四级标题", shortcut: "Ctrl+4", level: 4 },
          { label: "五级标题", shortcut: "Ctrl+5", level: 5 },
          { label: "六级标题", shortcut: "Ctrl+6", level: 6 },
        ];
        levels.forEach(({ label, shortcut, level }) => {
          addObjectAction(label, shortcut, () => {
            convertObjectBlockToTextblock(view, conversionContext, {
              type: "heading",
              level,
            });
          });
        });
      }
    }
  }

  if (codeBlock) {
    contextLabel = "代码块";
    contextSlot = document.createElement("div");
    contextSlot.className = "mt-context-menu__submenu";
  }

  // All contexts share this menu shell; only the context submenu changes.
  {
  const sourceRange = sourceEditor
    ? currentHtmlSourceSelection(sourceEditor)
    : imageSourceEditor
      ? currentContentEditableSelection(imageSourceEditor)
      : null;
  const sourceSelection =
    !!sourceRange && sourceRange.end > sourceRange.start;
  const noSelection = sourceEditor || imageSourceEditor
    ? !sourceSelection
    : view.state.selection.empty;
  const hasPlainTextSelection =
    !view.state.selection.empty &&
    !(view.state.selection instanceof NodeSelection);
  const sourcePlainText =
    sourceEditor && sourceRange
      ? htmlSourceCopyText(sourceEditor, sourceRange)
      : imageSourceEditor && sourceRange
        ? contentEditableSourceCopyText(imageSourceEditor, sourceRange)
      : "";
  const codeBlockPlainText = codeBlock
    ? (codeBlock.view?.state.doc.toString() ?? codeBlock.fallbackText)
    : "";
  const tablePlainText = tableCell ? tableCellPlainText(tableCell) : "";
  const objectPlainText = objectMenu
    ? objectMenu.kind === "html-block"
      ? htmlBlockVisibleText(objectMenu.element)
      : objectPlainTextSource(objectMenu)
    : "";
  const codeQuickSelection = codeBlock?.view
    ? codeSelection(codeBlock.view)
    : null;
  const hasCodeSelection =
    !!codeQuickSelection &&
    codeQuickSelection.from !== codeQuickSelection.to;
  const codeSource = codeBlock
    ? codeBlock.view && hasCodeSelection
      ? codeBlock.view.state.sliceDoc(
          codeQuickSelection!.from,
          codeQuickSelection!.to
        )
      : codeBlockPlainText
    : "";
  const plainTextCopyAvailable = sourceEditor || imageSourceEditor
    ? !!sourcePlainText
    : codeBlock
      ? !!codeBlockPlainText
      : objectMenu
        ? !!objectPlainText
        : tableCell
          ? !!tablePlainText
          : inlineImage
            ? false
            : hasPlainTextSelection;
  const hasActiveSourceControl = !!currentBlockSourceControl();
  const enclosingSourceTarget = sourceContainerTargetAt(
    view,
    pos,
    new Set(["alert", "blockquote"])
  );
  const quickCopyLabel = sourceEditor
    ? "复制 HTML 源码"
    : imageSourceEditor
      ? "复制图片源码"
      : tableCell
        ? "复制表格源码"
        : codeBlock
          ? "复制代码源码"
          : math || inlineMath
            ? "复制公式源码"
            : inlineImage
              ? "复制图片源码"
              : objectMenu
                ? "复制组件源码"
                : enclosingSourceTarget
                  ? enclosingSourceTarget.node.type.name === "alert"
                    ? "复制 Alert 源码"
                    : "复制引用源码"
                : "复制 Markdown 源码";
  const canCopySource =
    !!sourceEditor ||
    !!imageSourceEditor ||
    !!codeBlock ||
    !!tableCell ||
    !!math ||
    !!inlineMath ||
    !!inlineImage ||
    !!objectMenu ||
    !!enclosingSourceTarget ||
    !view.state.selection.empty;

  const copyContextSource = (cut = false): void => {
    if (sourceEditor && sourceRange) {
      if (cut) {
        runHtmlSourceQuickAction(sourceEditor, "cut", sourceRange);
      } else {
        copyHtmlSourceSelection(sourceEditor, sourceRange);
      }
      return;
    }
    if (imageSourceEditor && sourceRange) {
      if (cut) {
        runImageSourceQuickAction(imageSourceEditor, "cut", sourceRange);
      } else {
        copyImageSourceSelection(imageSourceEditor, sourceRange);
      }
      return;
    }

    let source: string | null = null;
    let deleteTarget: { node: PMNode; pos: number } | null = null;
    let deleteSelection = false;
    if (codeBlock) {
      deleteTarget = sourceNodeTargetAt(
        view,
        codeBlock.element,
        new Set(["code_block"])
      );
      source = serializeSourceNode(
        view,
        deleteTarget?.node ?? null
      );
      if (source == null) {
        const language =
          codeBlock.element
            .querySelector<HTMLElement>(".language-button")
            ?.textContent?.trim() ?? "";
        source = withCodeFence(codeSource, language);
      }
    } else if (objectMenu) {
      if (objectMenu.node) {
        deleteTarget = { node: objectMenu.node, pos: objectMenu.pos };
      }
      source = serializeSourceNode(view, objectMenu.node);
      source ??= objectClipboardSource(objectMenu);
      if (
        objectMenu.kind === "alert-title" &&
        !/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(source)
      ) {
        source = alertSourceCode(objectMenu.node);
      } else if (objectMenu.kind === "diagram") {
        source = withCodeFence(source, "mermaid");
      }
    } else if (tableCell) {
      const table = tableCell.closest<HTMLTableElement>("table");
      deleteTarget = table
        ? sourceNodeTargetAt(view, table, new Set(["table"]))
        : null;
      source = serializeSourceNode(
        view,
        deleteTarget?.node ?? null
      );
      if (source == null && table) source = tableElementToMarkdown(table);
    } else if (math || inlineMath) {
      const element = math ?? inlineMath!;
      deleteTarget = sourceNodeTargetAt(
        view,
        element,
        new Set(["math_block", "math_inline"])
      );
      source = serializeSourceNode(
        view,
        deleteTarget?.node ?? null
      );
      if (source == null) {
        const tex = mathTex(element);
        source = math
          ? `$$\n${tex}\n$$`
          : `$${tex}$`;
      }
    } else if (inlineImage) {
      deleteTarget = sourceNodeTargetAt(
        view,
        inlineImage,
        new Set(["image"])
      );
      source = serializeSourceNode(
        view,
        deleteTarget?.node ?? null
      );
      source ??= formatImageMarkdown({
        src: inlineImage.dataset.mdSrc ?? inlineImage.getAttribute("src") ?? "",
        alt: inlineImage.alt,
        title: inlineImage.title || null,
      });
    } else {
      deleteTarget = enclosingSourceTarget;
      if (deleteTarget) {
        source = serializeSourceNode(view, deleteTarget.node);
        if (source == null) {
          source =
            deleteTarget.node.type.name === "alert"
              ? alertSourceCode(deleteTarget.node)
              : blockquoteSourceCode(deleteTarget.node);
        }
      } else {
        source = serializeSourceSelection(view);
        deleteSelection = true;
      }
    }

    closeMenu();
    if (!source) return;
    void writeClipboardText(source)
      .then(() => {
        if (!cut) return;
        if (deleteTarget) {
          deleteSourceTarget(view, deleteTarget);
        } else if (deleteSelection && !view.state.selection.empty) {
          view.dispatch(view.state.tr.deleteSelection());
        }
        view.focus();
      })
      .catch((error) => {
        alert(
          `无法写入剪贴板：${error instanceof Error ? error.message : String(error)}`
        );
      });
  };
  const runContextQuick = (
    action: "cut" | "copy" | "paste" | "delete"
  ): void => {
    if (sourceEditor && sourceRange) {
      runHtmlSourceQuickAction(sourceEditor, action, sourceRange);
      return;
    }
    if (imageSourceEditor && sourceRange) {
      runImageSourceQuickAction(imageSourceEditor, action, sourceRange);
      return;
    }
    if (objectMenu) {
      runObjectQuickAction(objectMenu, action);
      return;
    }
    if (codeBlock) {
      runCodeBlockQuickAction(codeBlock, action);
      return;
    }
    runQuickAction(action, action === "paste" && !!tableCell);
  };

  const quickGrid = document.createElement("div");
  quickGrid.className =
    "mt-context-menu__grid mt-context-menu__grid--4 mt-context-menu__grid--icons";
  addIconButton(
    quickGrid,
    "cut",
    quickCopyLabel.replace(/^复制/, "剪切"),
    () => copyContextSource(true),
    {
      disabled:
        sourceEditor || imageSourceEditor ? !sourceSelection : !canCopySource,
    }
  );
  addIconButton(
    quickGrid,
    "copy",
    quickCopyLabel,
    () => copyContextSource(),
    { disabled: !canCopySource }
  );
  addIconButton(
    quickGrid,
    "paste",
    "粘贴",
    () => runContextQuick("paste"),
    {
      preserveEditing: true,
      disabled: sourceEditor || imageSourceEditor
        ? false
        : objectMenu
          ? (objectMenu.kind !== "html-block" || !objectMenu.node) &&
            !hasActiveSourceControl
          : !!codeBlock && !codeBlock.view,
    }
  );
  addIconButton(quickGrid, "delete", "删除", () => runContextQuick("delete"), {
    disabled: sourceEditor || imageSourceEditor
      ? !sourceSelection
      : objectMenu
        ? !objectMenu.node
        : codeBlock
          ? !hasCodeSelection
          : noSelection,
    danger: true,
  });
  menu.appendChild(quickGrid);

  const markIsActive = (def: Def): boolean => {
    const mark = def.markName ? view.state.schema.marks[def.markName] : null;
    const selection = view.state.selection;
    return mark
      ? selection.empty
        ? !!mark.isInSet(selection.$from.marks())
        : view.state.doc.rangeHasMark(selection.from, selection.to, mark)
      : false;
  };

  const currentBlock = activeTextblock
    ? view.state.doc.nodeAt(activeTextblock.blockPos)
    : null;
  const currentHeadingLevel =
    currentBlock?.type.name === "heading"
      ? Number(currentBlock.attrs.level)
      : null;

  const addTextAction = (
    parent: HTMLElement,
    label: string,
    run: () => void,
    opts?: {
      shortcut?: string;
      active?: boolean;
      disabled?: boolean;
      title?: string;
      preserveEditing?: boolean;
    }
  ): HTMLButtonElement => {
    const btn = addRow(parent, opts?.active ? "✓" : "", label, opts?.shortcut);
    if (opts?.preserveEditing) {
      btn.setAttribute(MENU_PRESERVE_EDITING_ATTRIBUTE, "");
    }
    if (opts?.active) btn.classList.add("is-active");
    if (opts?.disabled) {
      btn.disabled = true;
      if (opts.title) btn.title = opts.title;
    }
    btn.addEventListener("click", run);
    return btn;
  };

  const addBlockConversions = (
    parent: HTMLElement,
    source: string,
    allowHeadings = true
  ): void => {
    const block = resolveBlockNodeAt(view, hitPos);
    if (!block) return;
    const convert = (target: TextblockConversion): void => {
      closeMenu();
      convertBlockToTextblock(
        view,
        block.node,
        block.pos,
        source,
        target
      );
    };
    if (parent.childElementCount > 0) addSeparator(parent);
    addTextAction(parent, "段落", () => convert({ type: "paragraph" }), {
      shortcut: "Ctrl+0",
    });
    if (allowHeadings && canConvertBlockSourceToHeading(source)) {
      for (const level of [1, 2, 3, 4, 5, 6] as const) {
        addTextAction(
          parent,
          `${["一", "二", "三", "四", "五", "六"][level - 1]}级标题`,
          () => convert({ type: "heading", level }),
          { shortcut: `Ctrl+${level}` }
        );
      }
    }
  };

  const clipboardAs = addSubmenu("", "复制 / 粘贴为…");
  const clipboardMath = math ?? inlineMath;
  const hasSpecificClipboardActions =
    !!clipboardMath ||
    !!inlineImage ||
    objectMenu?.kind === "diagram";
  if (objectMenu?.kind === "diagram") {
    addTextAction(clipboardAs, "复制为图片", () => {
      closeMenu();
      void copyObjectToClipboard(objectMenu).catch((error) => {
        alert(
          `图片复制失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
    });
  } else if (clipboardMath) {
    addTextAction(clipboardAs, "复制到 Word", () =>
      void runMathCopy("word")
    );
    addTextAction(clipboardAs, "复制为 MathML", () =>
      void runMathCopy("mathml")
    );
    addTextAction(clipboardAs, "复制为 TeX", () =>
      void runMathCopy("tex")
    );
    if (clipboardMath.classList.contains("milkdown-math-block")) {
      addTextAction(clipboardAs, "复制为图片", () =>
        void runMathCopy("image")
      );
    }
  } else if (inlineImage) {
    addTextAction(clipboardAs, "复制为图片", () => {
      closeMenu();
      void copyImageElement(inlineImage).catch((error) => {
        alert(
          `图片复制失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
    });
  }
  const copyGlobalText = (): void => {
    if (sourceEditor && sourceRange) {
      copyHtmlSourceSelection(sourceEditor, sourceRange);
      return;
    }
    if (imageSourceEditor && sourceRange) {
      copyImageSourceSelection(imageSourceEditor, sourceRange);
      return;
    }
    if (codeBlock) {
      const selection = codeBlock.view
        ? codeSelection(codeBlock.view)
        : null;
      const text =
        codeBlock.view &&
        selection &&
        selection.from !== selection.to
          ? codeBlock.view.state.sliceDoc(selection.from, selection.to)
          : codeBlockPlainText;
      closeMenu();
      void writeClipboardText(text).catch((error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }
    if (tableCell && noSelection) {
      closeMenu();
      void writeClipboardText(tablePlainText).catch((error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }
    if (!objectMenu) {
      runClipboardAs("copyText");
      return;
    }
    closeMenu();
    void writeClipboardText(objectPlainText).catch(
      (error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    );
  };
  const pasteGlobalPlainText = (): void => {
    if (sourceEditor && sourceRange) {
      pasteHtmlSourceSelection(sourceEditor, sourceRange);
      return;
    }
    if (imageSourceEditor && sourceRange) {
      pasteImageSourceSelection(imageSourceEditor, sourceRange);
      return;
    }
    if (codeBlock?.view) {
      const cm = codeBlock.view;
      const selection = codeSelection(cm);
      closeMenu();
      void readClipboardText().then((text) => {
        const pasteText = stripTrailingClipboardLineBreak(text);
        cm.dispatch({
          changes: {
            from: selection.from,
            to: selection.to,
            insert: pasteText,
          },
          selection: { anchor: selection.from + pasteText.length },
        });
        cm.focus();
      }).catch((error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }
    if (objectMenu?.kind === "html-block") {
      closeMenu();
      void readClipboardText()
        .then((text) =>
          replaceHtmlBlockSource(
            view,
            objectMenu,
            stripTrailingClipboardLineBreak(text)
          )
        )
        .catch((error) => {
          alert(
            `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
          );
        });
      return;
    }
    if (tableCell) {
      const selection = view.state.selection;
      closeMenu();
      void readClipboardText().then((text) => {
        const pasteText = stripTrailingClipboardLineBreak(text);
        view.dispatch(
          view.state.tr.insertText(
            pasteText,
            selection.from,
            selection.to
          )
        );
        view.focus();
      }).catch((error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }
    runClipboardAs("pasteText");
  };
  if (hasSpecificClipboardActions) addSeparator(clipboardAs);
  addTextAction(clipboardAs, "复制为纯文本", copyGlobalText, {
    disabled: !plainTextCopyAvailable,
  });
  addTextAction(clipboardAs, "复制为 HTML 代码", () => {
    if (sourceEditor && sourceRange) {
      copyHtmlSourceSelection(sourceEditor, sourceRange);
      return;
    }
    if (imageSourceEditor && sourceRange) {
      copyImageSourceSelection(imageSourceEditor, sourceRange);
      return;
    }
    if (objectMenu?.kind === "html-block") {
      closeMenu();
      void writeClipboardText(objectMenu.source).catch((error) => {
        alert(
          `剪贴板操作失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }
    runClipboardAs("copyHtml");
  });
  addTextAction(clipboardAs, "粘贴为纯文本", pasteGlobalPlainText, {
    preserveEditing: true,
  });

  {
    const textFormattingEnabled =
      !objectMenu && !codeBlock && !math && !imageSourceEditor;
    const formatGrid = document.createElement("div");
    formatGrid.className =
      "mt-context-menu__grid mt-context-menu__grid--5 mt-context-menu__grid--icons";
    const strongDef = DEFS.find((def) => def.markName === "strong") as Def;
    const emphasisDef = DEFS.find((def) => def.markName === "emphasis") as Def;
    const inlineCodeDef = DEFS.find(
      (def) => def.markName === "inlineCode"
    ) as Def;
    addIconButton(
      formatGrid,
      "bold",
      "加粗",
      () => runDef(strongDef),
      {
        active: textFormattingEnabled && markIsActive(strongDef),
        disabled: !textFormattingEnabled,
      }
    );
    addIconButton(
      formatGrid,
      "italic",
      "斜体",
      () => runDef(emphasisDef),
      {
        active: textFormattingEnabled && markIsActive(emphasisDef),
        disabled: !textFormattingEnabled,
      }
    );
    addIconButton(
      formatGrid,
      "code",
      "行内代码",
      () => runDef(inlineCodeDef),
      {
        active: textFormattingEnabled && markIsActive(inlineCodeDef),
        disabled: !textFormattingEnabled,
      }
    );
    addIconButton(
      formatGrid,
      "formula",
      "行内公式",
      () => runDef({ kind: "inlineMath", label: "行内公式" }),
      { disabled: !textFormattingEnabled }
    );
    addIconButton(
      formatGrid,
      "link",
      "链接",
      () => runDef({ kind: "link", label: "链接" }),
      { disabled: !textFormattingEnabled }
    );
    menu.appendChild(formatGrid);

    const blockGrid = document.createElement("div");
    blockGrid.className =
      "mt-context-menu__grid mt-context-menu__grid--4 mt-context-menu__grid--icons";
    addIconButton(
      blockGrid,
      "quote",
      "引用",
      () => runBlockItem("blockquote"),
      { disabled: !textFormattingEnabled }
    );
    addIconButton(
      blockGrid,
      "orderedList",
      "有序列表",
      () => runBlockItem("orderedList"),
      { disabled: !textFormattingEnabled }
    );
    addIconButton(
      blockGrid,
      "bulletList",
      "无序列表",
      () => runBlockItem("bulletList"),
      { disabled: !textFormattingEnabled }
    );
    addIconButton(
      blockGrid,
      "taskList",
      "任务列表",
      () => runBlockItem("taskList"),
      { disabled: !textFormattingEnabled }
    );
    menu.appendChild(blockGrid);
  }

  if (math) {
    contextLabel = math.classList.contains("milkdown-math-block")
      ? "公式块"
      : "行内公式";
  } else if (
    !tableCell &&
    !codeBlock &&
    !objectMenu &&
    currentHeadingLevel !== null
  ) {
    contextLabel =
      HEADING_LABELS[
        Math.max(1, Math.min(currentHeadingLevel, 6)) - 1
      ];
  }
  const contextPanel = addSubmenu("", contextLabel);
  if (contextSlot) {
    while (contextSlot.firstChild) {
      contextPanel.appendChild(contextSlot.firstChild);
    }
    if (codeBlock) {
      addBlockConversions(
        contextPanel,
        codeBlock.view?.state.doc.toString() ?? codeBlock.fallbackText,
        false
      );
    }
  } else if (tableCell) {
    renderTableSubmenu(view, tableCell, contextPanel);
  } else if (math) {
    addTextAction(contextPanel, "编辑公式", () => {
      closeMenu();
      clickElement(math);
    });
    if (math.classList.contains("milkdown-math-block")) {
      addBlockConversions(contextPanel, mathTex(math));
    }
  } else {
    HEADING_LABELS.forEach((label, index) => {
      const level = (index + 1) as 1 | 2 | 3 | 4 | 5 | 6;
      addTextAction(contextPanel, label, () => applyHeadingLevel(level), {
        shortcut: `Ctrl+${level}`,
        active: currentHeadingLevel === level,
      });
    });
    if (currentHeadingLevel === null) {
      addSeparator(contextPanel);
      addTextAction(contextPanel, "段落", () => runBlockItem("paragraph"), {
        shortcut: "Ctrl+0",
        active: currentBlock?.type.name === "paragraph",
      });
    }
  }

  const inserts = addSubmenu("", "插入");
  addTextAction(inserts, "图像", () => runInsertCommand("image"), {
    shortcut: "Ctrl+Shift+I",
  });
  addSeparator(inserts);
  addTextAction(inserts, "脚注", () => runFootnote());
  addTextAction(inserts, "链接引用", () => {
    closeMenu();
    closeActiveMarkSource(view);
    // A collapsed inline source session removes temporary delimiters and
    // shifts positions. Re-hit the original pointer coordinates so a line-start
    // insertion still lands before the paragraph.
    const current = view.posAtCoords({
      left: clientX,
      top: clientY,
    });
    const insertionPos = current?.pos ?? pos;
    if (!hitOnSelection(view, insertionPos)) {
      placeCaretAt(view, insertionPos, true);
    }
    insertLinkReferenceDefinition(view);
  });
  addTextAction(inserts, "水平分割线", () => runInsertCommand("hr"));
  addTextAction(inserts, "表格", () => runInsertCommand("table"), {
    shortcut: "Ctrl+T",
  });
  addTextAction(inserts, "代码块", () => runInsertCommand("code"), {
    shortcut: "Ctrl+Shift+K",
  });
  addTextAction(inserts, "公式块", () => runInsertCommand("math"), {
    shortcut: "Ctrl+Shift+M",
  });
  addTextAction(inserts, "流程图", () => runInsertCommand("diagram"));
  addTextAction(inserts, "内容目录", () => runInsertCommand("toc"));
  addTextAction(inserts, "YAML Front Matter", () =>
    runInsertCommand("frontmatter")
  );
  addSeparator(inserts);
  addTextAction(inserts, "段落（上方）", () => insertParagraphNear(true));
  addTextAction(inserts, "段落（下方）", () => insertParagraphNear(false));
  }

  finishMenu();
}

export function createFormatMenuProsePlugin(
  sourceSerializer?: MarkdownSourceSerializer
): Plugin {
  return new Plugin({
      view(editorView) {
        if (sourceSerializer) {
          markdownSourceSerializers.set(editorView, sourceSerializer);
        }
        const onImageSourceContextMenu = (event: Event): void => {
          if (!(event instanceof CustomEvent)) return;
          const sourceEditor = event.target;
          if (
            !(sourceEditor instanceof HTMLElement) ||
            !sourceEditor.classList.contains("mt-image-source")
          ) {
            return;
          }
          const wrapper = sourceEditor.closest<HTMLElement>(
            ".mt-image-node"
          );
          if (!wrapper) return;
          const image = wrapper.querySelector<HTMLImageElement>("img");
          if (!image) return;

          const detail = event.detail as
            | { clientX?: unknown; clientY?: unknown }
            | null;
          const bounds = sourceEditor.getBoundingClientRect();
          const clientX =
            typeof detail?.clientX === "number"
              ? detail.clientX
              : bounds.left;
          const clientY =
            typeof detail?.clientY === "number"
              ? detail.clientY
              : bounds.top;
          const captured = captureRightClick(
            editorView,
            wrapper,
            clientX,
            clientY
          );

          event.preventDefault();
          event.stopPropagation();
          openMenu(
            editorView,
            clientX,
            clientY,
            captured?.caretPos ?? editorView.state.selection.from,
            captured?.textblock ?? null,
            null,
            null,
            null,
            null,
            null,
            image,
            null,
            sourceEditor
          );
        };
        const onHtmlSourceContextMenu = (event: Event): void => {
          if (!(event instanceof CustomEvent)) return;
          const sourceEditor = event.target;
          if (
            !(sourceEditor instanceof HTMLTextAreaElement) ||
            !sourceEditor.classList.contains("mt-html-block-body")
          ) {
            return;
          }
          const objectMenu = resolveObjectMenuContext(
            editorView,
            sourceEditor
          );
          if (objectMenu?.kind !== "html-block") return;

          const detail = event.detail as
            | { clientX?: unknown; clientY?: unknown }
            | null;
          const bounds = sourceEditor.getBoundingClientRect();
          const clientX =
            typeof detail?.clientX === "number"
              ? detail.clientX
              : bounds.left;
          const clientY =
            typeof detail?.clientY === "number"
              ? detail.clientY
              : bounds.top;

          event.preventDefault();
          event.stopPropagation();
          openMenu(
            editorView,
            clientX,
            clientY,
            objectMenu.pos,
            null,
            null,
            null,
            objectMenu,
            null,
            null,
            null,
            sourceEditor
          );
        };
        const onContextMenu = (event: MouseEvent): void => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const objectMenu = resolveObjectMenuContext(editorView, target);
          if (objectMenu) {
            if (objectMenu.kind === "html-block") return;
            const captured = captureRightClick(
              editorView,
              target,
              event.clientX,
              event.clientY
            );
            event.preventDefault();
            event.stopPropagation();
            openMenu(
              editorView,
              event.clientX,
              event.clientY,
              captured?.caretPos ?? objectMenu.pos,
              captured?.textblock ?? null,
              null,
              null,
              objectMenu,
              null,
              null,
              null,
              null,
              null,
              sourceControlAtTarget(target)
            );
            return;
          }
          const math = target.closest<HTMLElement>(
            ".milkdown-math-block"
          );
          if (math) {
            const captured = captureRightClick(
              editorView,
              target,
              event.clientX,
              event.clientY
            );
            event.preventDefault();
            event.stopPropagation();
            openMenu(
              editorView,
              event.clientX,
              event.clientY,
              captured?.caretPos ?? editorView.state.selection.from,
              captured?.textblock ?? null,
              math
            );
            return;
          }
          const tableCell = target.closest<HTMLElement>("td, th");
          if (tableCell) {
            const pos = editorView.posAtDOM(tableCell, 0);
            const captured = captureRightClick(
              editorView,
              target,
              event.clientX,
              event.clientY
            );
            const caretPos = captured?.caretPos ?? pos;
            const selection = editorView.state.selection;
            if (
              pos >= 0 &&
              !hitOnSelection(editorView, caretPos) &&
              !nativeSelectionIntersectsTarget(editorView, target) &&
              !(selection instanceof AllSelection) &&
              !(selection instanceof CellSelection)
            ) {
              editorView.dispatch(
                editorView.state.tr.setSelection(
                  TextSelection.create(editorView.state.doc, caretPos)
                )
              );
            }
            event.preventDefault();
            event.stopPropagation();
            openMenu(
              editorView,
              event.clientX,
              event.clientY,
              caretPos,
              captured?.textblock ?? null,
              null,
              null,
              null,
              tableCell
            );
            return;
          }
          const codeBlock = target.closest<HTMLElement>(
            ".milkdown-code-block"
          );
          if (!codeBlock) return;
          const codeEditor = codeBlock.querySelector<HTMLElement>(".cm-editor");
          const codeView = codeEditor
            ? CodeMirrorView.findFromDOM(codeEditor)
            : null;
          const placeholder = codeBlock.querySelector<HTMLElement>(
            ".milkdown-code-block-placeholder code"
          );
          if (!codeView && !placeholder) return;

          if (codeView && target.closest(".cm-editor")) {
            const pos = codeView.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            });
            const selection = codeView.state.selection.main;
            if (
              pos !== null &&
              (selection.empty ||
                pos < selection.from ||
                pos > selection.to)
            ) {
              codeView.dispatch({ selection: { anchor: pos } });
            }
          }

          event.preventDefault();
          event.stopPropagation();
          const captured = captureRightClick(
            editorView,
            target,
            event.clientX,
            event.clientY
          );
          openMenu(
            editorView,
            event.clientX,
            event.clientY,
            captured?.caretPos ?? editorView.state.selection.from,
            captured?.textblock ?? null,
            null,
            {
              element: codeBlock,
              view: codeView,
              fallbackText: placeholder?.textContent ?? "",
              fallbackElement: placeholder,
            }
          );
        };
        editorView.dom.addEventListener(
          "contextmenu",
          onContextMenu,
          true
        );
        editorView.dom.addEventListener(
          HTML_SOURCE_CONTEXTMENU_EVENT,
          onHtmlSourceContextMenu,
          true
        );
        editorView.dom.addEventListener(
          IMAGE_SOURCE_CONTEXTMENU_EVENT,
          onImageSourceContextMenu,
          true
        );
        return {
          destroy() {
            markdownSourceSerializers.delete(editorView);
            editorView.dom.removeEventListener(
              "contextmenu",
              onContextMenu,
              true
            );
            editorView.dom.removeEventListener(
              HTML_SOURCE_CONTEXTMENU_EVENT,
              onHtmlSourceContextMenu,
              true
            );
            editorView.dom.removeEventListener(
              IMAGE_SOURCE_CONTEXTMENU_EVENT,
              onImageSourceContextMenu,
              true
            );
          },
        };
      },
      props: {
        handleDOMEvents: {
          copy(view, event) {
            const selection = view.state.selection;
            if (!(selection instanceof CellSelection)) return false;
            const serialized = view.serializeForClipboard(selection.content());
            const html = normalizeTableClipboardHtml(
              serialized.dom.innerHTML
            );
            event.clipboardData?.setData(
              "text/html",
              html
            );
            event.clipboardData?.setData(
              "text/plain",
              tableHtmlToAlignedPlainText(html) ?? serialized.text
            );
            event.preventDefault();
            return true;
          },
          mousedown(view, event) {
            if (event.button !== 2) {
              pendingRightClick = null;
              return false;
            }
            const target = event.target as Element | null;
            if (isForeignTarget(target)) return false;
            const captured = captureRightClick(
              view,
              target,
              event.clientX,
              event.clientY
            );
            if (!captured) return false;
            pendingRightClick = captured;
            const onSelection =
              hitOnSelection(view, captured.caretPos) ||
              nativeSelectionIntersectsTarget(view, target);
            const keepSelection =
              view.state.selection instanceof AllSelection ||
              view.state.selection instanceof CellSelection ||
              onSelection;
            if (target?.closest?.("td, th") && !keepSelection) return false;
            if (keepSelection) {
              // ProseMirror's handleDOMEvents contract requires the handler
              // itself to cancel the native mousedown default action. This
              // keeps a document-wide AllSelection from collapsing before the
              // contextmenu event arrives.
              event.preventDefault();
              view.focus();
              return true;
            }
            placeCaretAt(view, captured.caretPos);
            view.focus();
            return false;
          },
          contextmenu(view, event) {
            const target = event.target as Element | null;
            if (isForeignTarget(target)) return false;
            const math =
              target?.closest<HTMLElement>(
                ".milkdown-math-block"
              ) ?? null;
            const inlineMath =
              target?.closest<HTMLElement>(
                ".milkdown-math-inline"
              ) ?? null;
            const inlineImage =
              target?.closest<HTMLImageElement>("img") ?? null;
            const pending =
              pendingRightClick &&
              Math.abs(pendingRightClick.clientX - event.clientX) <= 2 &&
              Math.abs(pendingRightClick.clientY - event.clientY) <= 2
                ? pendingRightClick
                : null;
            const captured =
              pending ??
              captureRightClick(
                view,
                target,
                event.clientX,
                event.clientY
              );
            pendingRightClick = null;
            if (!captured) return false;
            const onSelection =
              hitOnSelection(view, captured.caretPos) ||
              nativeSelectionIntersectsTarget(view, target);
            // 表格单元格内：默认交给表格右键菜单；右键落在已有文字选区上时
            // 格式菜单优先（给选中的单元格文字套格式）
            if (target?.closest?.("td, th") && !onSelection) return false;
            event.preventDefault();
            openMenu(
              view,
              event.clientX,
              event.clientY,
              captured.caretPos,
              captured.textblock,
              math,
              null,
              null,
              null,
              inlineMath,
              inlineImage,
              null,
              null,
              sourceControlAtTarget(target)
            );
            return true;
          },
        },
      },
  });
}

export const formatMenuPlugin = $prose((ctx) =>
  createFormatMenuProsePlugin((node) => ctx.get(serializerCtx)(node))
);
