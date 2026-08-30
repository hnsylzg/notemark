<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from "vue";
import "@/editor/theme/index.css";
import Sidebar from "@/components/Sidebar.vue";
import FindBar from "@/components/FindBar.vue";
import {
  createEditor,
  getMarkdown,
  setMarkdown,
  wysiwygSelectionToMarkdownOffsets,
  setCaretByMarkdownOffset,
  setSelectionByMarkdownOffsets,
  getCaretViewY,
  getHeadings,
  scrollToPos,
  posAtCoords,
  coordsAtPos,
  focusEditorStart,
} from "@/editor/index";
import type { HeadingItem } from "@/editor/index";
import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import { importImagePaths } from "@/editor/image-files";
import { openFile, saveFile, newFile } from "@/editor/fileOps";
import {
  clearRecentFiles,
  clearWorkspaceDir,
  createTextFile,
  ensureMarkdownExt,
  joinPath,
  listWorkspace,
  loadRecentFiles,
  loadSidebarOpen,
  loadWorkspaceDir,
  parentDir,
  pathExists,
  pickFolder,
  pushRecentFile,
  readMarkdownFile,
  removeRecentFile,
  renamePath,
  revealInFileManager,
  saveSidebarOpen,
  saveWorkspaceDir,
  trashPath,
} from "@/editor/workspace";
import type {
  BlankAction,
  DirAction,
  FileAction,
  RecentFile,
  WorkspaceItem,
  WorkspaceListing,
} from "@/editor/workspace";
import {
  buildStandaloneHtml,
  getEditorHtml,
  htmlToPlainText,
  inlineImages,
  saveExportFile,
} from "@/editor/exporter";
import { buildDocx } from "@/editor/docxExporter";
import { setImageBaseDir } from "@/editor/image-view";
import {
  closeFind as closeEditorFind,
  getFindState,
  openFind as openEditorFind,
  replaceAllMatches,
  replaceCurrent,
  searchText,
  setFindOptions,
  setFindQuery,
  stepMatch,
} from "@/editor/find-replace";
import type { FindMatch } from "@/editor/find-replace";
import {
  applyDarkMode,
  applyInstalledTheme,
  getActiveThemePath,
  importCustomTheme,
  isDarkMode,
  listInstalledThemes,
  loadCustomTheme,
  loadDarkModePreference,
  openThemesDir,
  resetToDefaultTheme,
  saveDarkModePreference,
} from "@/editor/themeManager";

// 是否处于 Tauri 环境（纯浏览器 vite dev 下不调用 Tauri API）
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 新建文档的默认内容（空文档） */
const INITIAL_CONTENT = "";

// 编辑器挂载容器
const editorHost = ref<HTMLElement | null>(null);
// 持有 editor 实例，便于卸载时销毁与读写
let editorInstance: ReturnType<typeof createEditor> | null = null;

// 文件状态
const currentPath = ref<string | null>(null);
const displayName = ref<string>("untitled");
/**
 * 最后一次保存/加载时的内容快照，用于判断是否有未保存修改。
 * 初始值设为 INITIAL_CONTENT：启动时的示例内容不算"未保存修改"，
 * 避免用户未做任何编辑时关闭窗口也被拦截。
 */
const savedContent = ref<string | null>(INITIAL_CONTENT);
/** 是否有未保存的修改（工具栏显示 ● 标记） */
const isDirty = ref(false);
/**
 * 最近一次「加载 / 保存 / 退出源码模式」时的 Markdown 原文。
 * 源码模式优先展示这份原文（而非重新序列化结果）：
 * markdown 的 AST 不保留空行/紧凑排版信息，重新序列化会在
 * 标题后、块级节点间强制补空行，导致「磁盘没有空行，源码却显示有空行」。
 * 记录原文即可让源码模式所见与磁盘一致。
 */
const rawContent = ref<string>(INITIAL_CONTENT);
/**
 * 可视化模式中是否发生过用户编辑。
 * 为 false 时进入源码模式直接展示 rawContent（保留用户排版）；
 * 为 true 时编辑器文档已是新内容，只能用 getMarkdown 序列化结果展示。
 * 打开 / 保存 / 退出源码模式后重置。
 */
let visualEdited = false;
/**
 * 「待应用」的源码草稿 / 磁盘原文。
 * markdownUpdated 回调是异步触发的（退出源码模式的 setMarkdown、
 * 打开文件的 setMarkdown 之后数百毫秒才回调），此时 sourceMode 已切换、
 * visualEdited 也已被重置，无法从状态区分「这次回调来自哪里」。
 * 因此在退出源码模式 / 打开文件时记录 pendingApply，
 * 下一次 markdownUpdated 命中它即视为「应用了草稿/原文」：
 * 重建 rawContent 基线、不置 visualEdited，从而保留用户的紧凑排版。
 */
let pendingApply: string | null = null;
/** 最近打开的文件列表（最近使用的排在最前，持久化在 store 中） */
const recentFiles = ref<RecentFile[]>([]);

// 源码模式：查看/编辑 Markdown 原文（WYSIWYG ⇄ 源码）
/** 是否处于源码模式 */
const sourceMode = ref(false);
/** 源码模式下 textarea 的当前内容（进入源码模式时的快照 + 用户后续编辑） */
const sourceDraft = ref("");
/** 源码 textarea 元素（进入源码模式时聚焦） */
const sourceTextarea = ref<HTMLTextAreaElement | null>(null);

// textarea 坐标 ⇄ 源码原文坐标 换算：
// 浏览器对 <textarea> 的 value / selectionStart / selectionEnd 做 CRLF→LF 归一化，
// 而 sourceDraft / rawContent 保留磁盘原文（可能含 \r，如 CRLF 文件）。
// 因此凡是「用源码坐标设置 textarea 选区」或「读 textarea 选区去映射」的地方，
// 都必须先换算坐标，否则选区会按 \r 数量整体偏移。
/** 统计 raw 文本 [0, to) 区间内的 \r 数量 */
function crCountInRaw(raw: string, to: number): number {
  const hi = Math.min(to, raw.length);
  let n = 0;
  for (let i = 0; i < hi; i++) if (raw.charCodeAt(i) === 13) n++;
  return n;
}
/** 源码原文坐标 → textarea 坐标（去掉前面的 \r） */
function toTextareaOffset(raw: string, offset: number): number {
  return offset - crCountInRaw(raw, offset);
}
/** textarea 坐标 → 源码原文坐标（把 \r 加回） */
function toRawOffset(raw: string, textareaOffset: number): number {
  let vis = 0;
  let i = 0;
  while (vis < textareaOffset && i < raw.length) {
    if (raw.charCodeAt(i) !== 13) vis++;
    i++;
  }
  return i;
}

/**
 * 把 textarea 滚动到选区可见。
 *
 * textarea 无法直接测量文本行位置，借助同尺寸同字体的隐藏镜像 div 排版，
 * 用两个标记元素分别承接「选区内」与「选区后」的内容，其 offsetTop 即
 * 选区首行与末行的位置。
 *
 * 切换模式时 textarea 是新建的（scrollTop 为 0），setSelectionRange 只设置
 * 选区、不会滚动，必须显式滚动，否则选区虽已正确却落在视口外。
 * 选区能整体容纳时居中显示，一眼就能看到选中了什么；超过一屏才退化为
 * 起点对齐（否则居中会让起点跑出视口）。
 */
function createTextareaMirror(el: HTMLTextAreaElement): HTMLDivElement {
  const style = getComputedStyle(el);
  const props = [
    "box-sizing",
    "width",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "letter-spacing",
    "line-height",
    "text-transform",
    "word-spacing",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "text-indent",
  ];
  const mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.height = "auto";
  mirror.style.overflow = "hidden";
  for (const p of props) mirror.style.setProperty(p, style.getPropertyValue(p));
  return mirror;
}

/**
 * 测量 textarea 中指定字符位置在当前视口中的 y（相对 textarea 顶部）。
 * 切换模式前调用，把结果交给另一侧，即可让光标停在屏幕原处。
 */
function measureTextareaCaretY(el: HTMLTextAreaElement, offset: number): number {
  const mirror = createTextareaMirror(el);
  mirror.textContent = el.value.slice(0, offset);
  const marker = document.createElement("span");
  marker.textContent = el.value.slice(offset) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  document.body.removeChild(mirror);
  return top - el.scrollTop;
}

function scrollTextareaToOffset(
  el: HTMLTextAreaElement,
  start: number,
  end: number,
  /** 期望选区起点停留的视口位置；非空时优先对齐到该位置（保持光标停在原处） */
  targetY: number | null = null
): void {
  const style = getComputedStyle(el);
  const mirror = createTextareaMirror(el);
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 20;
  // 选区之前的内容原样排布；标记一承接选区本身，标记二承接选区之后的内容
  mirror.textContent = el.value.slice(0, start);
  const markStart = document.createElement("span");
  // 选区在文末时标记内容为空会量不到位置，补占位字符
  markStart.textContent = el.value.slice(start, end) || ".";
  const markEnd = document.createElement("span");
  markEnd.textContent = el.value.slice(end) || ".";
  mirror.appendChild(markStart);
  mirror.appendChild(markEnd);
  document.body.appendChild(mirror);
  const top = markStart.offsetTop;
  const bottom = markEnd.offsetTop + (markEnd.offsetHeight || line);
  document.body.removeChild(mirror);

  if (targetY != null) {
    // 对齐到切换前的屏幕位置：视线不动
    el.scrollTop = Math.max(0, top - targetY);
    return;
  }
  const selHeight = Math.max(line, bottom - top);
  const pad = line * 2;
  if (selHeight + pad * 2 <= el.clientHeight) {
    // 放得下：整段居中，一眼看到选中了什么
    el.scrollTop = Math.max(0, top + selHeight / 2 - el.clientHeight / 2);
  } else {
    // 放不下：起点对齐并留余量，保证至少能看到选区开头
    el.scrollTop = Math.max(0, top - pad);
  }
}

// 侧边栏状态（文件列表 + 大纲）
/** 侧边栏是否展开 */
const sidebarOpen = ref(true);
/** 当前工作目录（侧边栏「文件」面板浏览的目录） */
const workspaceDir = ref<string | null>(null);
/** 当前目录下的子目录 */
const workspaceDirs = ref<WorkspaceItem[]>([]);
/** 当前目录下的文本文件 */
const workspaceFiles = ref<WorkspaceItem[]>([]);
/** 当前文档的标题列表（侧边栏「大纲」面板） */
const headings = ref<HeadingItem[]>([]);
/** 大纲刷新节流定时器（避免每次输入都遍历文档） */
let headingTimer: number | null = null;

// 主题菜单状态
/** 主题下拉菜单是否展开 */
const themeMenuOpen = ref(false);
/** 主题菜单容器（用于点击外部时收起菜单） */
const themeMenuWrap = ref<HTMLElement | null>(null);
/** 固定主题目录下已安装的主题列表（打开菜单时刷新） */
const installedThemes = ref<{ name: string; filePath: string }[]>([]);

/** 刷新固定主题目录下的已安装主题列表 */
async function refreshThemeList() {
  installedThemes.value = await listInstalledThemes();
}

/** 是否为深色模式（同步 <html data-theme> 当前值） */
const isDark = ref<boolean>(isDarkMode());

/** 切换深色模式：应用 + 持久化偏好 */
async function toggleDarkMode() {
  isDark.value = !isDark.value;
  applyDarkMode(isDark.value);
  await saveDarkModePreference(isDark.value);
}

type WebviewWindow = Awaited<
  ReturnType<typeof import("@tauri-apps/api/webviewWindow").getCurrentWebviewWindow>
>;
let webview: WebviewWindow | null = null;

/** 同步窗口标题与工具栏文件名 */
function updateTitle(name: string) {
  displayName.value = name;
  if (isTauri && webview) {
    webview.setTitle(`NoteMark - ${name}`);
  }
}

/** 编辑器内容变化回调（listenerCtx.markdownUpdated） */
function onEditorChange(markdown: string) {
  if (pendingApply !== null) {
    // 退出源码模式 setMarkdown(草稿) / 打开文件 setMarkdown(原文) 触发的
    // 异步回调：以草稿/原文重建基线，保留用户排版，不算可视化编辑。
    rawContent.value = pendingApply;
    pendingApply = null;
  } else if (!sourceMode.value) {
    // 可视化模式下的真实用户编辑：之后进入源码只能展示序列化结果。
    visualEdited = true;
  }
  isDirty.value = markdown !== savedContent.value;
  // 标题增删/改名后刷新大纲（内部节流，避免每次按键都遍历文档）
  scheduleHeadingRefresh();
  // 查找栏打开时同步结果数：编辑会改变匹配位置，插件已重算，这里只取结果
  if (findOpen.value && !sourceMode.value) syncFindState();
}

// ==================== 源码模式 ====================

/** 进入源码模式：以「原文基线」或当前编辑器序列化结果填充草稿。
 * 未在可视化模式改过内容时展示 rawContent（保留加载/保存时的用户排版，
 * 不被序列化强制补空行）；可视化改过则只能展示序列化结果。 */
function enterSourceMode() {
  if (sourceMode.value || !editorInstance) return;
  const editor = editorInstance;
  // 未在可视化模式改过内容时展示 rawContent（保留加载/保存时的用户排版，
  // 不被序列化强制补空行）；可视化改过则只能展示序列化结果。
  const source = visualEdited ? getMarkdown(editor) : rawContent.value;
  sourceDraft.value = source;
  sourceMode.value = true;
  // 记录 WYSIWYG 选区对应的源码字符区间（块级锚点：定位到同一块所在行，
  // 有选区时两端各自映射，源码里恢复选中；无选区时退化为单点光标）
  const sel = wysiwygSelectionToMarkdownOffsets(editor, source);
  // 切换前先量出光标在屏幕上的位置（DOM 此刻仍是可视化模式），
  // 切过去后对齐到同一位置，做到视线不动
  const caretY = getCaretViewY(editor);
  nextTick(() => {
    const el = sourceTextarea.value;
    if (el) {
      if (sel != null) {
        // 映射结果是源码原文坐标（CRLF 文件含 \r），
        // textarea 的 value/选区被浏览器归一化为 LF，需换算后再设置
        const start = toTextareaOffset(source, sel.from);
        const end = toTextareaOffset(source, sel.to);
        el.setSelectionRange(start, end);
        // 先聚焦：未聚焦的 textarea 不会显示选区高亮
        el.focus();
        // 让选区停在切换前的屏幕位置（视线不动）；量不到位置时才退化居中
        scrollTextareaToOffset(el, start, end, caretY);
        // textarea 刚从 display:none 显示出来，字体/布局可能在下一帧才最终确定，
        // 再校准一次，避免首帧测量偏早导致没滚到位
        requestAnimationFrame(() => scrollTextareaToOffset(el, start, end, caretY));
      } else {
        el.focus();
      }
    }
    // 查找栏开着时按新模式重算（两种模式的位置体系不同，沿用会错位）
    resyncFindOnModeSwitch();
  });
}

/** 退出源码模式：把草稿应用回编辑器（重新解析渲染）。setMarkdown 会触发
 *  markdownUpdated → onEditorChange，脏标记随之按新内容重新计算。 */
function exitSourceMode() {
  if (!sourceMode.value || !editorInstance) return;
  const editor = editorInstance;
  const el = sourceTextarea.value;
  // 记录 textarea 选区（有选中时两端都要还原；无选区时两点重合退化为光标）。
  // textarea 选区是 CRLF→LF 归一化坐标，映射前换算回源码原文坐标
  const from = el && el.value.length > 0 ? toRawOffset(sourceDraft.value, el.selectionStart) : null;
  const to = el && el.value.length > 0 ? toRawOffset(sourceDraft.value, el.selectionEnd) : null;
  // 切换前先量出光标在屏幕上的位置（textarea 此刻仍可见），
  // 返回可视化后对齐到同一位置，做到视线不动
  const caretY = el && el.value.length > 0 ? measureTextareaCaretY(el, el.selectionStart) : null;
  // 用户编辑后的草稿成为新的原文基线（保留排版）。
  // setMarkdown 触发的 markdownUpdated 是异步的，届时 sourceMode 已为 false，
  // 无法靠 sourceMode 区分回调来源，因此用 pendingApply 标记：
  // 下一次 markdownUpdated 命中它即视为「应用了草稿」，重建基线而不置 visualEdited。
  rawContent.value = sourceDraft.value;
  visualEdited = false;
  pendingApply = sourceDraft.value;
  setMarkdown(editor, sourceDraft.value);
  sourceMode.value = false;
  nextTick(() => {
    if (from != null && sourceDraft.value) {
      if (to != null && to !== from) {
        setSelectionByMarkdownOffsets(editor, sourceDraft.value, from, to, caretY);
      } else {
        setCaretByMarkdownOffset(editor, sourceDraft.value, from, caretY);
      }
    } else {
      document.querySelector<HTMLElement>(".milkdown .editor")?.focus();
    }
    // 光标复位后再重建查找状态：WYSIWYG 以光标为锚点定位当前匹配
    resyncFindOnModeSwitch();
  });
}

/** 切换源码模式 */
function toggleSourceMode() {
  if (sourceMode.value) exitSourceMode();
  else enterSourceMode();
}

/** 源码 textarea 输入：更新草稿与脏标记 */
function onSourceInput(e: Event) {
  sourceDraft.value = (e.target as HTMLTextAreaElement).value;
  isDirty.value = sourceDraft.value !== savedContent.value;
  // 查找栏打开时重算匹配：以光标为锚点，边输入边跟随结果
  if (findOpen.value) syncSourceFind();
}

/** 获取当前内容（用于保存到磁盘）：
 * - 源码模式下返回草稿原样（用户编辑的文本，排版原样保留）；
 * - 可视化模式下，若未发生用户编辑则返回原文基线 rawContent——
 *   保存的是磁盘原文，避免序列化在标题后等处强制补空行、改变文件格式；
 * - 可视化模式下编辑过则只能返回序列化结果（文档结构已变，排版信息已丢失）。 */
function getCurrentContent(): string {
  if (!editorInstance) return "";
  if (sourceMode.value) return sourceDraft.value;
  return visualEdited ? getMarkdown(editorInstance) : rawContent.value;
}

/**
 * 把 Markdown 文本解析再序列化，得到规范形式。
 * 脏检查基准必须用规范形式：markdownUpdated 回调给的是序列化结果，
 * 若基准存的是源码草稿（保留用户紧凑排版），
 * 退出源码模式后序列化结果与之比较会误报「未保存修改」。
 */
function normalizeMarkdown(md: string): string {
  if (!editorInstance) return md;
  return editorInstance.action((ctx) => {
    const parser = ctx.get(parserCtx);
    const serializer = ctx.get(serializerCtx);
    try {
      return serializer(parser(md));
    } catch {
      return md;
    }
  });
}

/** 打开/新建后若处于源码模式，把新内容同步进草稿（优先用原文基线） */
function syncSourceDraft() {
  if (sourceMode.value && editorInstance) {
    sourceDraft.value = visualEdited ? getMarkdown(editorInstance) : rawContent.value;
  }
}

type SaveAction = "save" | "discard" | "cancel";

/**
 * "未保存修改"确认框状态。
 * 为 null 时隐藏；显示时持有提示消息与 resolve 回调。
 * 采用前端自绘对话框而非 Tauri ask()，避免依赖 dialog 插件权限，
 * 保证浏览器与桌面端行为一致。
 */
const confirmState = ref<{
  message: string;
  resolve: (action: SaveAction) => void;
} | null>(null);

/** 弹出确认框，等待用户在"保存 / 不保存 / 取消"中作出选择 */
function askSaveConfirm(message: string): Promise<SaveAction> {
  return new Promise((resolve) => {
    confirmState.value = { message, resolve };
  });
}

/** 用户点击确认框按钮后触发，把选择交还给等待中的流程 */
function resolveConfirm(action: SaveAction) {
  confirmState.value?.resolve(action);
  confirmState.value = null;
}

/** 通用确认对话框状态（两按钮：取消 / 确定） */
const confirmDialog = ref<{
  message: string;
  confirmText: string;
  /** true 时确定按钮使用危险色（删除等不可撤销操作） */
  danger: boolean;
  resolve: (ok: boolean) => void;
} | null>(null);

/** 弹出通用确认对话框，等待用户选择「确定 / 取消」 */
function askConfirm(
  message: string,
  confirmText = "确定",
  danger = false
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmDialog.value = { message, confirmText, danger, resolve };
  });
}

/** 通用确认对话框的按钮回调 */
function resolveConfirmDialog(ok: boolean) {
  confirmDialog.value?.resolve(ok);
  confirmDialog.value = null;
}

/** 输入对话框状态（重命名 / 新建文件） */
const promptState = ref<{
  title: string;
  value: string;
  confirmText: string;
  /** 输入框初始选中的字符范围；重命名时用于预选文件名主体 */
  selection: [number, number] | null;
  resolve: (value: string | null) => void;
} | null>(null);
const promptInput = ref<HTMLInputElement | null>(null);

/**
 * 弹出输入对话框，等待用户输入文本。
 * 与确认框一致采用前端自绘，避免依赖 Tauri 原生 dialog（浏览器端行为统一）。
 */
function askPrompt(
  title: string,
  defaultValue = "",
  confirmText = "确定",
  selection: [number, number] | null = null
): Promise<string | null> {
  return new Promise((resolve) => {
    promptState.value = { title, value: defaultValue, confirmText, selection, resolve };
    nextTick(() => {
      const el = promptInput.value;
      if (!el) return;
      el.focus();
      if (selection) el.setSelectionRange(selection[0], selection[1]);
      else el.select();
    });
  });
}

/** 输入对话框的按钮回调；value 为 null 表示取消 */
function resolvePrompt(value: string | null) {
  promptState.value?.resolve(value);
  promptState.value = null;
}

/** 计算文件名主体（不含扩展名）的选中范围，重命名时直接改写主体而非整名 */
function stemRange(name: string): [number, number] {
  const match = name.match(/^(.*?)(\.(md|markdown|txt))?$/i);
  return [0, (match?.[1] ?? name).length];
}

/**
 * 有未保存修改时先询问处理方式。
 * @returns 是否允许继续后续操作；用户取消或保存失败时返回 false
 */
async function confirmDiscardIfDirty(): Promise<boolean> {
  if (!isDirty.value) return true;
  const action = await askSaveConfirm("当前文档有未保存的修改，是否先保存？");
  if (action === "cancel") return false;
  if (action === "save") return await handleSave();
  return true;
}

/**
 * 把文件内容载入编辑器，并同步标题、脏标记、侧边栏与最近文件列表。
 * 「打开对话框」与「最近打开」两个入口共用这段逻辑，避免行为分叉。
 */
async function loadFileIntoEditor(path: string, name: string, content: string) {
  if (!editorInstance) return;
  currentPath.value = path;
  // 必须先设置图片基准目录，再渲染文档，
  // 否则首次渲染时相对路径图片会按 WebView 页面 URL 解析导致裂图。
  setImageBaseDir(path);
  // 记录磁盘原文作为源码模式基线（保留用户的紧凑/宽松排版），
  // 避免序列化在标题后等处强制补空行。
  rawContent.value = content;
  visualEdited = false;
  // setMarkdown 触发的 markdownUpdated 是异步回调，届时 sourceMode 可能已变，
  // 用 pendingApply 标记让该回调命中「应用了原文」分支，不置 visualEdited。
  pendingApply = content;
  await setMarkdown(editorInstance, content);
  updateTitle(name);
  // 快照必须用"编辑器序列化结果"而非文件原文：
  // setMarkdown 会触发 markdownUpdated，其回调拿到的文本是序列化结果，
  // 若文件带 CRLF 换行等差异，与原文比较会产生误报。
  // 等渲染完成后（且 setMarkdown 已触发 markdownUpdated 后）再重置标记。
  await nextTick();
  visualEdited = false;
  if (editorInstance) {
    savedContent.value = getMarkdown(editorInstance);
    isDirty.value = false;
    syncSourceDraft();
    refreshHeadings();
  }
  // 侧边栏同步到该文件所在目录，文件列表即展示同级文件（同时记住该目录）
  await syncWorkspaceToFile(path);
  // 记入「最近打开」（写入失败仅告警，不影响已打开的文档）
  recentFiles.value = await pushRecentFile({ path, name });
}

async function handleOpen() {
  if (!isTauri || !editorInstance) return;
  if (!(await confirmDiscardIfDirty())) return;
  try {
    const file = await openFile();
    if (!file) return; // 用户取消
    await loadFileIntoEditor(file.path, file.name, file.content);
  } catch (err) {
    console.error("[NoteMark] open failed:", err);
    alert(`打开失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 保存文件。返回是否真正完成保存（用户取消或失败返回 false）。 */
async function handleSave(): Promise<boolean> {
  if (!isTauri || !editorInstance) return false;
  try {
    const content = getCurrentContent();
    const result = await saveFile(content, currentPath.value);
    if (!result) return false; // 用户取消
    currentPath.value = result.path;
    setImageBaseDir(result.path);
    updateTitle(result.name);
    // 脏检查基准用规范形式（markdownUpdated 回调给的是序列化结果），
    // 否则源码模式保存紧凑排版后，退出源码会被误报为未保存修改。
    savedContent.value = normalizeMarkdown(content);
    isDirty.value = false;
    // 保存的内容成为新的原文基线（源码模式下即用户草稿，排版原样保留）
    rawContent.value = content;
    visualEdited = false;
    // 另存为/首次保存：侧边栏同步到新文件所在目录，使新文件出现在列表中
    await syncWorkspaceToFile(result.path);
    // 首次保存 / 另存为产生的新路径也应进入「最近打开」
    recentFiles.value = await pushRecentFile({
      path: result.path,
      name: result.name,
    });
    return true;
  } catch (err) {
    console.error("[NoteMark] save failed:", err);
    alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ==================== 原生拖放（图片插入 / 文档打开） ====================

/** 拖放认为是图片的扩展名 */
const DROP_IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
/** 拖放认为是可编辑文本的扩展名（与「打开」对话框的过滤器保持一致） */
const DROP_TEXT_EXT = /\.(md|markdown|txt)$/i;

/**
 * 处理从系统拖进来的文件。
 *
 * 走 Tauri 原生 DragDrop 事件而不是前端 HTML5 拖放：
 * HTML5 的 File 对象出于安全限制拿不到磁盘上的真实路径，
 * 拖进来的 .md 就无法「打开后再存回原处」；原生事件给的是完整路径。
 *
 * 分流规则：含文本文件就打开第一个（拖文档是明确的替换意图），
 * 否则把图片插到鼠标落点。
 */
async function handleFileDrop(payload: {
  paths: string[];
  x: number;
  y: number;
}): Promise<void> {
  if (!editorInstance) return;
  const paths = payload.paths ?? [];
  if (paths.length === 0) return;

  const doc = paths.find((p) => DROP_TEXT_EXT.test(p));
  if (doc) {
    if (!(await confirmDiscardIfDirty())) return;
    try {
      const content = await readMarkdownFile(doc);
      await loadFileIntoEditor(doc, doc.split(/[\\/]/).pop() || doc, content);
    } catch (err) {
      console.error("[NoteMark] open dropped file failed:", err);
      alert(`打开失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const images = paths.filter((p) => DROP_IMAGE_EXT.test(p));
  if (images.length === 0) return;
  importImagePaths(
    editorInstance,
    images,
    posAtCoords(editorInstance, payload.x, payload.y)
  );
}

// ==================== 拖放视觉反馈（落点指示线 / 全窗提示） ====================
//
// dragDropEnabled=true 时 Windows 的 OLE 劫持了 HTML5 dragover/drop，
// 前端拖动过程中收不到任何事件，看不到「图片会插到哪」。
// Rust 侧把原生 DragDropEvent::Over 的实时坐标转发过来（file-drag-over），
// 这里在鼠标位置对应的文档位置画一条竖线；drop / leave 时清掉反馈。

/** 插入位置指示线（跟随拖拽中的鼠标实时移动） */
let dropIndicator: HTMLElement | null = null;
/** 拖入 .md 文档时的全窗提示遮罩 */
let dropOverlay: HTMLElement | null = null;
/** Enter 时记录拖的是什么文件（Over 事件只带坐标不带路径） */
let lastDragPaths: string[] = [];

/** 在鼠标位置对应的文档位置显示插入指示线（仅图片拖入时） */
function showDropIndicator(x: number, y: number): void {
  const editor = editorInstance;
  const host = editorHost.value;
  if (!editor || !host || sourceMode.value) return;
  const pos = posAtCoords(editor, x, y);
  const coords = coordsAtPos(editor, pos);
  const hostRect = host.getBoundingClientRect();
  if (!dropIndicator) {
    dropIndicator = document.createElement("div");
    dropIndicator.style.cssText =
      "position:absolute;width:2px;border-radius:1px;background:var(--mt-color-fg,currentColor);" +
      "pointer-events:none;z-index:100;display:none;";
    host.appendChild(dropIndicator);
  }
  dropIndicator.style.display = "block";
  dropIndicator.style.left = `${coords.left - hostRect.left}px`;
  dropIndicator.style.top = `${coords.top - hostRect.top + host.scrollTop}px`;
  dropIndicator.style.height = `${Math.max(2, coords.bottom - coords.top)}px`;
}

function hideDropIndicator(): void {
  if (dropIndicator) dropIndicator.style.display = "none";
}

/** 拖入文档时显示「释放以打开」全窗提示 */
function showDropOverlay(text: string): void {
  if (!dropOverlay) {
    dropOverlay = document.createElement("div");
    dropOverlay.style.cssText =
      "position:fixed;inset:0;display:none;align-items:center;justify-content:center;" +
      "z-index:200;background:rgba(0,0,0,.22);pointer-events:none;";
    const label = document.createElement("div");
    label.style.cssText =
      "padding:10px 22px;border-radius:8px;background:rgba(0,0,0,.55);" +
      "color:#fff;font-size:15px;box-shadow:0 4px 16px rgba(0,0,0,.25);";
    dropOverlay.appendChild(label);
    document.body.appendChild(dropOverlay);
  }
  (dropOverlay.firstElementChild as HTMLElement).textContent = text;
  dropOverlay.style.display = "flex";
}

function hideDropOverlay(): void {
  if (dropOverlay) dropOverlay.style.display = "none";
}

/** 清空所有拖放反馈（drop / leave 时调用） */
function hideDropFeedback(): void {
  lastDragPaths = [];
  hideDropIndicator();
  hideDropOverlay();
}

/** 拖拽悬停中：按文件类型切换反馈形态 */
function handleFileDragOver(payload: { paths: string[]; x: number; y: number }): void {
  if (payload.paths && payload.paths.length > 0) lastDragPaths = payload.paths;
  if (lastDragPaths.length === 0) return;
  if (lastDragPaths.some((p) => DROP_IMAGE_EXT.test(p))) {
    hideDropOverlay();
    showDropIndicator(payload.x, payload.y);
  } else if (lastDragPaths.some((p) => DROP_TEXT_EXT.test(p))) {
    hideDropIndicator();
    showDropOverlay("释放以打开文档");
  }
}

async function handleNew() {
  if (!editorInstance) return;
  if (!(await confirmDiscardIfDirty())) return;
  setMarkdown(editorInstance, "");
  const fresh = newFile();
  currentPath.value = fresh.path;
  setImageBaseDir(fresh.path);
  updateTitle(fresh.name);
  // 新文档的原文基线为空；setMarkdown("") 会触发 markdownUpdated，
  // 在 nextTick 后再重置 visualEdited（异步回调由 pendingApply 命中处理）。
  rawContent.value = "";
  visualEdited = false;
  pendingApply = "";
  // 与打开文件一致：等渲染完成后用序列化结果作为脏检查基准
  await nextTick();
  visualEdited = false;
  if (editorInstance) {
    savedContent.value = getMarkdown(editorInstance);
    isDirty.value = false;
    syncSourceDraft();
    refreshHeadings();
    // 焦点还停在工具栏按钮上，交给编辑区，用户可以直接开始输入
    focusEditorStart(editorInstance);
  }
}

// ==================== 侧边栏（文件列表 + 大纲） ====================

/** 取文件所在目录；无法确定（如只有文件名）时返回 null */
function dirOfPath(path: string): string | null {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : null;
}

/** 展开 / 收拢侧边栏（状态持久化到 store） */
function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value;
  saveSidebarOpen(sidebarOpen.value).catch((e) =>
    console.warn("[NoteMark] save sidebar state failed:", e)
  );
}

/**
 * 扫描指定目录，更新侧边栏的子目录与文件列表。
 * 目录不可读（已被删除/移动/无权限）时清空面板，避免停留在无效目录上。
 */
async function refreshWorkspace(dir: string | null) {
  if (!dir) {
    workspaceDir.value = null;
    workspaceDirs.value = [];
    workspaceFiles.value = [];
    return;
  }
  let listing: WorkspaceListing | null = null;
  try {
    listing = await listWorkspace(dir);
  } catch (err) {
    console.warn("[NoteMark] refresh workspace failed:", err);
  }
  if (!listing) {
    workspaceDir.value = null;
    workspaceDirs.value = [];
    workspaceFiles.value = [];
    return;
  }
  workspaceDir.value = dir;
  workspaceDirs.value = listing.dirs;
  workspaceFiles.value = listing.files;
}

/** 选择要浏览的文件夹（侧边栏「打开文件夹」按钮） */
async function handlePickFolder() {
  try {
    const dir = await pickFolder();
    if (!dir) return; // 用户取消
    await refreshWorkspace(dir);
    await saveWorkspaceDir(dir);
  } catch (err) {
    console.error("[NoteMark] pick folder failed:", err);
    alert(`打开文件夹失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 进入某个子目录 */
async function handleEnterDir(path: string) {
  await refreshWorkspace(path);
}

/** 返回上级目录 */
async function handleGoParent() {
  if (!workspaceDir.value) return;
  const parent = parentDir(workspaceDir.value);
  if (parent) await refreshWorkspace(parent);
}

/** 从侧边栏打开文件（有未保存修改时先询问，与「打开」保持一致） */
async function handleSidebarOpenFile(path: string) {
  if (!isTauri || !editorInstance) return;
  if (isDirty.value) {
    const action = await askSaveConfirm("当前文档有未保存的修改，是否先保存？");
    if (action === "cancel") return;
    if (action === "save") {
      const saved = await handleSave();
      if (!saved) return;
    }
  }
  try {
    const content = await readMarkdownFile(path);
    const name = path.split(/[\\/]/).pop() || path;
    currentPath.value = path;
    // 与 handleOpen 一致：必须先设置图片基准目录，再渲染文档
    setImageBaseDir(path);
    // 与 loadFileIntoEditor 一致：记录原文基线，保留用户排版
    rawContent.value = content;
    visualEdited = false;
    pendingApply = content;
    await setMarkdown(editorInstance, content);
    updateTitle(name);
    await nextTick();
    visualEdited = false;
    if (editorInstance) {
      savedContent.value = getMarkdown(editorInstance);
      isDirty.value = false;
      syncSourceDraft();
      refreshHeadings();
    }
  } catch (err) {
    console.error("[NoteMark] sidebar open file failed:", err);
    alert(`打开失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 立即重新收集大纲数据 */
function refreshHeadings() {
  if (!editorInstance) return;
  try {
    headings.value = getHeadings(editorInstance);
  } catch (err) {
    console.warn("[NoteMark] collect headings failed:", err);
  }
}

/** 节流刷新大纲：编辑过程中 250ms 内的多次变更合并为一次 */
function scheduleHeadingRefresh() {
  if (headingTimer !== null) clearTimeout(headingTimer);
  headingTimer = window.setTimeout(refreshHeadings, 250);
}

/** 点击大纲项：跳转并滚动到对应标题 */
function handleGotoHeading(pos: number) {
  if (!editorInstance) return;
  const editor = editorInstance;
  // 源码模式下编辑器被隐藏，需先切回 WYSIWYG；
  // 且必须等 DOM 更新（编辑器重新可见）后再滚动，否则 scrollIntoView 无效。
  if (sourceMode.value) {
    exitSourceMode();
    nextTick(() => scrollToPos(editor, pos));
    return;
  }
  scrollToPos(editor, pos);
}

/**
 * 把侧边栏工作区同步到指定文件所在目录，并持久化。
 * 打开 / 另存为之后调用，使文件列表始终展示「当前文件所在目录」，
 * 下次启动也恢复到该目录（目录未变化时不重复写 store）。
 */
async function syncWorkspaceToFile(path: string) {
  const dir = dirOfPath(path);
  if (!dir) return;
  const changed = dir !== workspaceDir.value;
  await refreshWorkspace(dir);
  if (changed) await saveWorkspaceDir(dir);
}

// ==================== 侧边栏右键菜单（文件处理） ====================

/** Windows / Unix 通用的文件名非法字符 */
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/;

/** 复制文本到剪贴板 */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.warn("[NoteMark] clipboard failed:", err);
    alert("复制失败，请手动记录路径。");
  }
}

/** 在系统文件管理器中定位并选中该路径 */
async function revealPath(path: string) {
  if (!isTauri) return;
  try {
    await revealInFileManager(path);
  } catch (err) {
    console.error("[NoteMark] reveal failed:", err);
    alert(`无法打开文件管理器：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 重命名文件：弹输入框 → 校验 → 重命名 → 同步当前文件路径与标题 */
async function renameFileItem(item: WorkspaceItem) {
  if (!isTauri) return;
  const input = await askPrompt(
    `重命名「${item.name}」`,
    item.name,
    "重命名",
    stemRange(item.name)
  );
  if (input === null) return;
  const newName = input.trim();
  if (!newName || newName === item.name) return;
  if (INVALID_NAME_CHARS.test(newName)) {
    alert('文件名不能包含 \\ / : * ? " < > | 等字符。');
    return;
  }
  const dir = dirOfPath(item.path);
  if (!dir) return;
  const target = await joinPath(dir, newName);
  if (await pathExists(target)) {
    alert(`「${newName}」已存在，请换一个名称。`);
    return;
  }
  try {
    await renamePath(item.path, target);
    // 重命名的是当前打开的文件：同步路径与标题（内容不变，脏标记不受影响）
    if (currentPath.value === item.path) {
      currentPath.value = target;
      setImageBaseDir(target);
      updateTitle(newName);
    }
    await refreshWorkspace(workspaceDir.value);
  } catch (err) {
    console.error("[NoteMark] rename failed:", err);
    alert(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 移入回收站：二次确认 → 调用后端 trash 命令 →
 * 若移除的是当前文件则退回「未保存的新文档」状态。
 * 走系统回收站，用户可在回收站中还原。
 */
async function deleteFileItem(item: WorkspaceItem) {
  if (!isTauri) return;
  const ok = await askConfirm(
    `确定要把「${item.name}」移入回收站吗？\n移入后可在系统回收站中还原。`,
    "移入回收站",
    true
  );
  if (!ok) return;
  try {
    await trashPath(item.path);
    if (currentPath.value === item.path) {
      // 内容仍在编辑器里，但已没有对应文件：退回未保存状态，提醒用户另存
      currentPath.value = null;
      setImageBaseDir(null);
      updateTitle("untitled");
      isDirty.value = true;
    }
    await refreshWorkspace(workspaceDir.value);
  } catch (err) {
    console.error("[NoteMark] delete failed:", err);
    alert(`删除失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 在当前目录下新建 Markdown 文件，并立即打开 */
async function createNewFile() {
  if (!isTauri || !workspaceDir.value) return;
  const defaultName = "untitled.md";
  const input = await askPrompt(
    "新建 Markdown 文件",
    defaultName,
    "创建",
    stemRange(defaultName)
  );
  if (input === null) return;
  const rawName = input.trim();
  if (!rawName) return;
  if (INVALID_NAME_CHARS.test(rawName)) {
    alert('文件名不能包含 \\ / : * ? " < > | 等字符。');
    return;
  }
  const name = ensureMarkdownExt(rawName);
  const target = await joinPath(workspaceDir.value, name);
  if (await pathExists(target)) {
    alert(`「${name}」已存在，请换一个名称。`);
    return;
  }
  try {
    await createTextFile(target, "");
    await refreshWorkspace(workspaceDir.value);
    // 新建后直接打开，符合「新建即可编辑」的直觉
    await handleSidebarOpenFile(target);
    // 同上：新建的空文档把焦点交给编辑区，打开即可输入
    if (editorInstance) focusEditorStart(editorInstance);
  } catch (err) {
    console.error("[NoteMark] create file failed:", err);
    alert(`创建失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 文件项右键菜单动作分发 */
async function handleFileAction(action: FileAction, item: WorkspaceItem) {
  switch (action) {
    case "open":
      await handleSidebarOpenFile(item.path);
      break;
    case "copyPath":
      await copyText(item.path);
      break;
    case "reveal":
      await revealPath(item.path);
      break;
    case "rename":
      await renameFileItem(item);
      break;
    case "delete":
      await deleteFileItem(item);
      break;
  }
}

/** 目录项右键菜单动作分发 */
async function handleDirAction(action: DirAction, item: WorkspaceItem) {
  if (action === "reveal") await revealPath(item.path);
}

/** 文件面板空白处右键菜单动作分发 */
async function handleBlankAction(action: BlankAction) {
  if (action === "newFile") await createNewFile();
  else if (action === "refresh") await refreshWorkspace(workspaceDir.value);
}

// ==================== 查找 / 替换 ====================

/** 查找栏是否展开 */
const findOpen = ref(false);
/** 是否展开替换行（Ctrl+H 直接展开） */
const findReplaceMode = ref(false);
const findQuery = ref("");
const findReplacement = ref("");
const findCaseSensitive = ref(false);
const findWholeWord = ref(false);
/** 匹配总数（WYSIWYG 与源码模式共用） */
const findCount = ref(0);
/** 当前匹配下标，0 起；-1 表示无匹配 */
const findIndex = ref(-1);
/** 查找栏组件（源码模式下需要它把焦点从 textarea 收回来） */
const findBarRef = ref<InstanceType<typeof FindBar> | null>(null);

/** 源码模式下的匹配位置（纯文本偏移，不是 ProseMirror 位置） */
const srcMatches = ref<FindMatch[]>([]);
/** 源码模式下当前匹配下标；-1 表示无匹配 */
const srcIndex = ref(-1);

/** WYSIWYG：把插件状态同步进 UI */
function syncFindState() {
  if (!editorInstance) return;
  const st = getFindState(editorInstance);
  if (!st) return;
  findCount.value = st.matches.length;
  findIndex.value = st.index;
}

/**
 * 源码模式：按当前查询词重算匹配。
 * @param keepIndex true 时尽量保持当前下标（替换后重算用），否则以光标为锚点定位
 */
function syncSourceFind(keepIndex = false) {
  srcMatches.value = findQuery.value
    ? searchText(sourceDraft.value, findQuery.value, {
        caseSensitive: findCaseSensitive.value,
        wholeWord: findWholeWord.value,
      })
    : [];
  if (srcMatches.value.length === 0) {
    srcIndex.value = -1;
  } else if (keepIndex && srcIndex.value >= 0) {
    srcIndex.value = Math.min(srcIndex.value, srcMatches.value.length - 1);
  } else {
    // 定位到光标之后的第一个匹配（找不到就回到第一个）。
    // 匹配坐标基于源码原文（可能含 \r），textarea 光标是归一化坐标，需先换算
    const anchor = toRawOffset(
      sourceDraft.value,
      sourceTextarea.value?.selectionStart ?? 0
    );
    const found = srcMatches.value.findIndex((m) => m.from >= anchor);
    srcIndex.value = found >= 0 ? found : 0;
  }
  findCount.value = srcMatches.value.length;
  findIndex.value = srcIndex.value;
}

/**
 * 源码模式：把 textarea 的选区移到当前匹配并滚动到可见区域。
 * textarea 没有「滚动到选区」的 API，这里借「聚焦一次」让浏览器自行滚动，
 * 再把焦点还给查找框（滚动位置会保留），保证连按 Enter 仍然有效。
 */
function srcReveal() {
  const el = sourceTextarea.value;
  const m = srcMatches.value[srcIndex.value];
  if (!el || !m) return;
  el.focus();
  // 匹配坐标是源码原文坐标，textarea 需要归一化坐标
  el.setSelectionRange(
    toTextareaOffset(sourceDraft.value, m.from),
    toTextareaOffset(sourceDraft.value, m.to)
  );
  findBarRef.value?.focusInput();
}

/** 源码模式：上一个（-1）/ 下一个（+1） */
function srcStep(delta: number) {
  const len = srcMatches.value.length;
  if (len === 0) return;
  const base = srcIndex.value < 0 ? (delta > 0 ? -1 : 0) : srcIndex.value;
  srcIndex.value = (base + delta + len) % len;
  findIndex.value = srcIndex.value;
  srcReveal();
}

/** 源码模式：替换当前匹配，并把光标停在替换文本之后继续向后查找 */
async function srcReplaceOne() {
  const el = sourceTextarea.value;
  const m = srcMatches.value[srcIndex.value];
  if (!el || !m) return;
  const draft = sourceDraft.value;
  const next = draft.slice(0, m.from) + findReplacement.value + draft.slice(m.to);
  sourceDraft.value = next;
  isDirty.value = next !== savedContent.value;
  const caret = m.from + findReplacement.value.length;
  // 等 textarea 的 value 随 draft 更新后再设置选区，否则会被重置。
  // caret 是源码原文坐标，textarea 需要归一化坐标
  await nextTick();
  el.focus();
  el.setSelectionRange(
    toTextareaOffset(sourceDraft.value, caret),
    toTextareaOffset(sourceDraft.value, caret)
  );
  syncSourceFind();
  findBarRef.value?.focusInput();
}

/** 源码模式：替换全部匹配（整体替换成一个新字符串，天然不会位置错乱） */
async function srcReplaceAll() {
  const list = srcMatches.value;
  if (list.length === 0) return;
  const draft = sourceDraft.value;
  let out = "";
  let cursor = 0;
  for (const m of list) {
    out += draft.slice(cursor, m.from) + findReplacement.value;
    cursor = m.to;
  }
  out += draft.slice(cursor);
  sourceDraft.value = out;
  isDirty.value = out !== savedContent.value;
  await nextTick();
  syncSourceFind();
}

/** 打开查找栏；replaceMode=true 时同时展开替换行 */
async function openFindBar(replaceMode = false) {
  if (!editorInstance) return;
  findOpen.value = true;
  // 展开过替换行后再按 Ctrl+F 不应把它收起来
  if (replaceMode) findReplaceMode.value = true;
  if (sourceMode.value) {
    // 等组件挂载后再定位，否则 focusInput() 拿不到组件实例，焦点会留在 textarea
    await nextTick();
    syncSourceFind();
    srcReveal();
    return;
  }
  applyEditorFind();
}

/** 用当前查询词与选项重建 WYSIWYG 查找状态（打开 / 改选项 / 切模式共用） */
function applyEditorFind() {
  if (!editorInstance) return;
  openEditorFind(editorInstance, findQuery.value, {
    caseSensitive: findCaseSensitive.value,
    wholeWord: findWholeWord.value,
  });
  syncFindState();
}

/** 关闭查找栏：清除高亮并把焦点还给编辑器 */
function closeFindBar() {
  findOpen.value = false;
  findReplaceMode.value = false;
  findCount.value = 0;
  findIndex.value = -1;
  srcMatches.value = [];
  srcIndex.value = -1;
  if (editorInstance && !sourceMode.value) closeEditorFind(editorInstance);
  if (!sourceMode.value) {
    document.querySelector<HTMLElement>(".milkdown .editor")?.focus();
  }
}

function onFindQuery(value: string) {
  findQuery.value = value;
  if (!editorInstance) return;
  if (sourceMode.value) {
    syncSourceFind();
    srcReveal();
    return;
  }
  setFindQuery(editorInstance, value);
  syncFindState();
}

/** 区分大小写 / 全字匹配开关变化后重算匹配 */
function onFindOptionChange() {
  if (!editorInstance) return;
  if (sourceMode.value) {
    syncSourceFind();
    srcReveal();
    return;
  }
  setFindOptions(editorInstance, {
    caseSensitive: findCaseSensitive.value,
    wholeWord: findWholeWord.value,
  });
  syncFindState();
}

function handleFindStep(delta: number) {
  if (!editorInstance) return;
  if (sourceMode.value) {
    srcStep(delta);
    return;
  }
  stepMatch(editorInstance, delta);
  syncFindState();
}

function handleReplaceOne() {
  if (!editorInstance) return;
  if (sourceMode.value) {
    void srcReplaceOne();
    return;
  }
  replaceCurrent(editorInstance, findReplacement.value);
  syncFindState();
}

function handleReplaceAll() {
  if (!editorInstance) return;
  if (sourceMode.value) {
    void srcReplaceAll();
    return;
  }
  replaceAllMatches(editorInstance, findReplacement.value);
  syncFindState();
}

function toggleCaseSensitive() {
  findCaseSensitive.value = !findCaseSensitive.value;
  onFindOptionChange();
}

function toggleWholeWord() {
  findWholeWord.value = !findWholeWord.value;
  onFindOptionChange();
}

/**
 * 模式切换后重建查找状态。
 * WYSIWYG 用 ProseMirror 位置、源码模式用纯文本偏移，两者互不相通，
 * 直接沿用会让计数与跳转全部错位，必须按新模式重算。
 */
function resyncFindOnModeSwitch() {
  if (!findOpen.value) return;
  if (sourceMode.value) syncSourceFind();
  else applyEditorFind();
}

// ==================== 导出（HTML / PDF / TXT / DOCX） ====================

/** 导出下拉菜单是否展开 */
const exportMenuOpen = ref(false);
/** 导出菜单容器（点击外部时收起） */
const exportMenuWrap = ref<HTMLElement | null>(null);

/** 展开 / 收起导出菜单 */
function toggleExportMenu() {
  exportMenuOpen.value = !exportMenuOpen.value;
}

/** 最近打开菜单是否展开 */
const recentMenuOpen = ref(false);
/** 最近打开菜单容器（点击外部时收起） */
const recentMenuWrap = ref<HTMLElement | null>(null);

/** 展开 / 收起「最近打开」菜单 */
function toggleRecentMenu() {
  recentMenuOpen.value = !recentMenuOpen.value;
}

/**
 * 打开最近列表中的某个文件。
 * 文件已失效（被删除/移动）时提示并从列表移除，避免留下打不开的死条目。
 */
async function openRecentFile(path: string) {
  recentMenuOpen.value = false;
  if (!isTauri || !editorInstance) return;
  if (path === currentPath.value) return; // 已在编辑该文件，无需重复加载
  if (!(await confirmDiscardIfDirty())) return;
  try {
    if (!(await pathExists(path))) {
      alert("该文件已不存在或已被移动，已从最近打开列表中移除。");
      recentFiles.value = await removeRecentFile(path);
      return;
    }
    // 走与侧边栏一致的读取路径（UTF-8 优先，GBK 回退）
    const content = await readMarkdownFile(path);
    const name = path.split(/[\\/]/).pop() || path;
    await loadFileIntoEditor(path, name, content);
  } catch (err) {
    console.error("[NoteMark] open recent file failed:", err);
    alert(`打开失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 清空最近打开列表 */
async function clearRecent() {
  recentMenuOpen.value = false;
  await clearRecentFiles();
  recentFiles.value = [];
}

/** 导出用的文档标题（去掉 md 扩展名） */
function exportTitle(): string {
  const name = displayName.value || "untitled";
  return name.replace(/\.(md|markdown|txt)$/i, "") || "untitled";
}

/** 取编辑器正文 HTML（含已渲染的公式、图表、代码高亮） */
function currentEditorHtml(): string {
  if (!editorInstance) return "";
  return getEditorHtml(editorInstance);
}

/** 导出为自包含 HTML（内联样式 + 内嵌图片，可双击打开） */
async function exportHtml() {
  if (!editorInstance) return;
  exportMenuOpen.value = false;
  try {
    const html = await inlineImages(currentEditorHtml());
    const full = buildStandaloneHtml({
      title: exportTitle(),
      bodyHtml: html,
      dark: isDark.value,
    });
    await saveExportFile(
      `${exportTitle()}.html`,
      [{ name: "网页", extensions: ["html"] }],
      full
    );
  } catch (err) {
    console.error("[NoteMark] export html failed:", err);
    alert(`导出 HTML 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 导出为纯文本（去掉语法标记） */
async function exportTxt() {
  if (!editorInstance) return;
  exportMenuOpen.value = false;
  try {
    const text = htmlToPlainText(currentEditorHtml());
    await saveExportFile(
      `${exportTitle()}.txt`,
      [{ name: "纯文本", extensions: ["txt"] }],
      text
    );
  } catch (err) {
    console.error("[NoteMark] export txt failed:", err);
    alert(`导出纯文本失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 导出为 Word 文档（按文档结构生成真正的 .docx） */
async function exportDocx() {
  if (!editorInstance) return;
  exportMenuOpen.value = false;
  try {
    const data = await buildDocx(editorInstance);
    await saveExportFile(
      `${exportTitle()}.docx`,
      [{ name: "Word 文档", extensions: ["docx"] }],
      data
    );
  } catch (err) {
    console.error("[NoteMark] export docx failed:", err);
    alert(`导出 Word 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 导出为 PDF。
 * 优先静默生成（后端调系统 Edge/Chrome 无头打印，直接输出到用户选择的路径）；
 * 失败时回退到打印对话框（隐藏 iframe + window.print，用户选「另存为 PDF」）。
 */
async function exportPdf() {
  if (!isTauri || !editorInstance) return;
  exportMenuOpen.value = false;

  let full: string;
  try {
    const html = await inlineImages(currentEditorHtml());
    full = buildStandaloneHtml({
      title: exportTitle(),
      bodyHtml: html,
      dark: isDark.value,
      forPrint: true,
    });
  } catch (err) {
    console.error("[NoteMark] prepare pdf content failed:", err);
    alert(`准备导出内容失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile, remove } = await import("@tauri-apps/plugin-fs");
    const { tempDir, join } = await import("@tauri-apps/api/path");
    const { invoke } = await import("@tauri-apps/api/core");

    // 先选保存位置，让后端直接输出到该路径，省去生成后再复制一步
    const target = await save({
      defaultPath: `${exportTitle()}.pdf`,
      filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
    });
    if (!target) return;

    const htmlPath = await join(await tempDir(), `notemark-export-${Date.now()}.html`);
    try {
      await writeTextFile(htmlPath, full);
      await invoke<void>("export_pdf", { htmlPath, pdfPath: target });
    } finally {
      // 清理临时 HTML（清理失败不影响导出结果）
      await remove(htmlPath).catch(() => {});
    }
  } catch (err) {
    console.warn("[NoteMark] silent pdf export failed, fallback to print:", err);
    printHtml(full);
  }
}

/**
 * PDF 导出的回退方案：在隐藏 iframe 中渲染完整 HTML 并调起系统打印对话框。
 * 用户在打印预览里选择「另存为 PDF」即可完成导出。
 */
function printHtml(html: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    alert("无法打开打印预览，请改用 HTML 导出。");
    return;
  }

  const doPrint = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // 延后移除，避免打印对话框还没弹出 iframe 就被销毁
    window.setTimeout(() => frame.remove(), 2000);
  };

  doc.open();
  doc.write(html);
  doc.close();
  if (doc.readyState === "complete") doPrint();
  else frame.addEventListener("load", doPrint, { once: true });
}

// ==================== 主题菜单 ====================

/** 展开 / 收起主题下拉菜单（展开时刷新已安装主题列表） */
function toggleThemeMenu() {
  themeMenuOpen.value = !themeMenuOpen.value;
  if (themeMenuOpen.value) {
    refreshThemeList().catch((e) =>
      console.warn("[NoteMark] refresh theme list failed:", e)
    );
  }
}

/** 切换回内置主题（默认）：移除自定义主题 <style> 标签，并清除持久化路径 */
async function useDefaultTheme() {
  themeMenuOpen.value = false;
  await resetToDefaultTheme();
}

/** 切换到固定主题目录中的某个已安装主题 */
async function switchTheme(theme: { name: string; filePath: string }) {
  themeMenuOpen.value = false;
  try {
    await applyInstalledTheme(theme.filePath);
  } catch (err) {
    console.error("[NoteMark] apply theme failed:", err);
    alert(`切换主题失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 在系统文件管理器中打开主题文件夹（Typora 风格，可手动放 CSS 进去） */
async function openThemeFolder() {
  themeMenuOpen.value = false;
  const dir = await openThemesDir();
  if (!dir) alert("无法打开主题文件夹");
}

/** 该已安装主题是否为当前生效主题 */
function isThemeActive(theme: { name: string; filePath: string }): boolean {
  const p = getActiveThemePath();
  return p !== null && p.toLowerCase() === theme.filePath.toLowerCase();
}

/** 当前是否处于内置主题 */
function isDefaultThemeActive(): boolean {
  return getActiveThemePath() === null;
}

/** 导入自定义主题：文件对话框（支持多选）→ 校验 → 复制到固定目录 → 应用 */
async function importTheme() {
  themeMenuOpen.value = false;
  try {
    const count = await importCustomTheme();
    if (count > 0) {
      // 刷新列表，让新导入的主题立刻出现在菜单里（带 ✓ 标记）
      await refreshThemeList().catch((e) =>
        console.warn("[NoteMark] refresh theme list failed:", e)
      );
      alert(
        count === 1
          ? "自定义主题已应用。"
          : `已导入 ${count} 个主题，最后一个已应用，可在主题菜单中切换。`
      );
    }
    // count === 0 表示用户取消了选择，无需反馈
  } catch (err) {
    console.error("[NoteMark] import theme failed:", err);
    alert(`导入主题失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 点击主题菜单外部区域时收起菜单 */
function onDocumentClick(e: MouseEvent) {
  if (exportMenuOpen.value && !exportMenuWrap.value?.contains(e.target as Node)) {
    exportMenuOpen.value = false;
  }
  if (themeMenuOpen.value && !themeMenuWrap.value?.contains(e.target as Node)) {
    themeMenuOpen.value = false;
  }
  if (recentMenuOpen.value && !recentMenuWrap.value?.contains(e.target as Node)) {
    recentMenuOpen.value = false;
  }
  // 编辑器内点击超链接：交给系统浏览器打开
  const target = e.target as Element | null;
  const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  // 锚点链接（#xxx）在编辑器内没有跳转目标，忽略
  if (!href || href.startsWith("#")) return;
  e.preventDefault();
  openExternalLink(href).catch((err) =>
    console.error("[NoteMark] open link failed:", err)
  );
}

/** 用系统默认程序打开链接；支持 http(s)/mailto 与本地相对路径（./xxx.md 等） */
async function openExternalLink(href: string): Promise<void> {
  if (!href || href.startsWith("#")) return;
  // 带协议的链接：仅支持 http(s)/mailto，其余协议（tel:/javascript:/data: 等）忽略
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (!/^(https?:|mailto:)/i.test(href)) return;
    try {
      if (isTauri) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(href);
      } else {
        windowOpenNewTab(href);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[NoteMark] open link failed:", err);
      alert(`无法打开链接：${msg}`);
    }
    return;
  }
  // 本地相对路径（./xxx.md、../xxx.md、xxx.md）：基于当前文档所在目录解析后打开
  if (isTauri) {
    const baseDir = currentPath.value
      ? currentPath.value.replace(/[\\/][^\\/]*$/, "")
      : null;
    if (!baseDir) {
      console.warn("[NoteMark] 当前文档未保存，无法解析相对链接:", href);
      return;
    }
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(resolveLocalPath(baseDir, href));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[NoteMark] open local link failed:", err);
      alert(`无法打开 ${href}：${msg}`);
    }
  } else {
    // 浏览器环境（vite dev）：交给浏览器按相对地址打开
    windowOpenNewTab(href);
  }
}

/** 在新标签页打开 URL；弹窗被拦截时兜底用临时 <a> 模拟点击（同一用户手势内有效） */
function windowOpenNewTab(url: string) {
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener,noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

/** 将相对路径解析为基于 baseDir 的绝对路径（处理 .、.. 与重复分隔符） */
function resolveLocalPath(baseDir: string, rel: string): string {
  const stack = baseDir.split(/[\\/]+/).filter(Boolean);
  const hasDrive = /^[a-zA-Z]:/.test(baseDir);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      // 不允许跳出盘符根目录
      if (stack.length > (hasDrive ? 1 : 0)) stack.pop();
    } else {
      stack.push(seg);
    }
  }
  const drive = hasDrive ? `${stack.shift()}\\` : "";
  return `${drive}${stack.join("\\")}`;
}

// 全局快捷键：Ctrl/Cmd + O / S / N / F / H / Shift+T（主题菜单）
function onKeydown(e: KeyboardEvent) {
  // Esc：关闭查找栏。三个自绘对话框的 Esc 由各自输入框 stop 掉，不会走到这里。
  if (e.key === "Escape") {
    if (
      findOpen.value &&
      !confirmState.value &&
      !confirmDialog.value &&
      !promptState.value
    ) {
      e.preventDefault();
      closeFindBar();
    }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (mod && e.shiftKey && key === "t") {
    // 打开主题菜单（浏览器默认的"恢复已关闭标签页"会被覆盖）
    e.preventDefault();
    toggleThemeMenu();
  } else if (key === "o") {
    e.preventDefault();
    handleOpen();
  } else if (key === "s") {
    e.preventDefault();
    handleSave();
  } else if (key === "n") {
    e.preventDefault();
    handleNew();
  } else if (key === "f") {
    // 查找（浏览器默认的 Ctrl+F 页面查找会被覆盖）
    e.preventDefault();
    // 已经展开替换行时保持展开，不要按一下 Ctrl+F 就收起来
    void openFindBar(findReplaceMode.value);
  } else if (key === "h") {
    // 查找并替换（浏览器默认是「历史记录」，必须拦截）
    e.preventDefault();
    void openFindBar(true);
  } else if (key === "/") {
    // 源码模式快捷键（Typora 风格 Ctrl+/）。
    // 焦点在 milkdown 编辑器内时交给 CodeMirror（代码块注释），不拦截。
    const inMilkdown = (e.target as HTMLElement).closest?.(".milkdown");
    if (!inMilkdown) {
      e.preventDefault();
      toggleSourceMode();
    }
  } else if (key === "b") {
    // 侧边栏开关（Ctrl/Cmd + B）。
    // 焦点在编辑器内时不拦截：Ctrl+B 是 ProseMirror 的加粗快捷键，优先级更高。
    const inMilkdown = (e.target as HTMLElement).closest?.(".milkdown");
    if (inMilkdown) return;
    e.preventDefault();
    toggleSidebar();
  }
}

/** 非 Tauri（浏览器）环境的关闭前确认：有未保存修改时触发原生提示 */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (isDirty.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}

onMounted(() => {
  try {
    if (!editorHost.value) return;

    editorInstance = createEditor(editorHost.value, INITIAL_CONTENT, onEditorChange);
    // 真正创建编辑器（视图在这里挂载）
    editorInstance.create().then(() => {
      // 初始内容不算"未保存修改"：create 完成后建立内容快照
      if (editorInstance) {
        savedContent.value = getMarkdown(editorInstance);
        isDirty.value = false;
        // 原文基线对齐初始内容（为空文档，无序列化差异问题）
        rawContent.value = INITIAL_CONTENT;
        visualEdited = false;
        // 必须初始化为 null：pendingApply 靠 !== null 判断，若初始化为
        // 初始内容（空串也算非 null），首次真实编辑会被误判成「应用草稿」，
        // 导致 rawContent 被重置为空、visualEdited 不置位，
        // 表现为「编辑后切到源码看到空白」
        pendingApply = null;
        // 初始文档也可能含标题（示例内容/上次加载），补一次大纲收集
        refreshHeadings();
        // 启动后把光标放进编辑区：否则打开应用还得先点一下才能打字。
        // 延后一帧执行——应用刚启动时窗口可能还没拿到系统焦点，
        // 此时立刻 focus 会被浏览器忽略。
        requestAnimationFrame(() => {
          if (editorInstance) focusEditorStart(editorInstance);
        });
      }
    });
  } catch (err) {
    // 临时诊断：把运行时错误显示在页面上，便于排查白屏
    const host = editorHost.value;
    if (host) {
      host.innerHTML = `<pre style="color:red;white-space:pre-wrap;padding:16px">[NoteMark init error]\n${
        err instanceof Error ? err.stack || err.message : String(err)
      }</pre>`;
    }
    console.error("[NoteMark] editor init failed:", err);
  }

  // 监听系统拖放（Rust 侧把「真实路径 + 落点坐标」转发成 file-drop 事件）。
  // 不走前端 HTML5 拖放：File 对象拿不到磁盘真实路径，拖入的 .md 无法打开。
  // 额外的 file-drag-over / file-drag-leave 用于画落点指示线：
  // dragDropEnabled=true 下前端收不到 HTML5 dragover，拖动过程中没有任何反馈，
  // 要靠原生 Over 的实时坐标来定位。
  if (isTauri) {
    import("@tauri-apps/api/event")
      .then(({ listen }) => {
        listen<{ paths: string[]; x: number; y: number }>("file-drag-over", (e) => {
          handleFileDragOver(e.payload);
        });
        listen<{ paths: string[]; x: number; y: number }>("file-drop", (e) => {
          hideDropFeedback();
          void handleFileDrop(e.payload);
        });
        listen("file-drag-leave", () => hideDropFeedback());
      })
      .catch((e) => console.warn("[NoteMark] listen file-drop failed:", e));
  }

  // 在 Tauri 环境下获取 webview 句柄：设置窗口标题 + 拦截关闭
  if (isTauri) {
    import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) => {
        webview = getCurrentWebviewWindow();
        webview.setTitle(`NoteMark - ${displayName.value}`);
        // 关闭窗口前：有未保存修改时先询问是否保存，而不是直接关掉。
        // 注意：未调用 preventDefault 时，@tauri-apps/api 会自动调用 destroy() 关闭窗口；
        // 调用 preventDefault 后则必须由我们显式 destroy() 完成关闭。
        webview.onCloseRequested(async (event) => {
          if (!isDirty.value) return; // 无未保存修改，不拦截，交由 Tauri 正常关闭
          event.preventDefault(); // 先拦截本次关闭
          try {
            const action = await askSaveConfirm("文档有未保存的修改，是否保存？");
            if (action === "cancel") return; // 取消关闭，留在当前窗口
            if (action === "save") {
              const saved = await handleSave();
              if (!saved) return; // 保存被取消/失败，留在当前窗口
            }
            webview?.destroy(); // 保存成功或选择不保存：真正关闭窗口
          } catch (err) {
            // 兜底：任何异常都不能让窗口卡死，强制关闭
            console.error("[NoteMark] close confirm failed:", err);
            webview?.destroy().catch(() => {});
          }
        });
      })
      .catch((e) => console.error("[NoteMark] webview init failed:", e));
  } else {
    // 浏览器环境兜底：beforeunload 原生提示
    window.addEventListener("beforeunload", onBeforeUnload);
  }

  window.addEventListener("keydown", onKeydown);
  document.addEventListener("click", onDocumentClick);
  // 应用启动时恢复最近打开的文件列表（供工具栏「打开」下拉使用）
  loadRecentFiles()
    .then((list) => (recentFiles.value = list))
    .catch((e) => console.warn("[NoteMark] load recent files failed:", e));
  // 应用启动时自动加载上次导入的自定义主题（非 Tauri / 无记录时内部静默跳过）
  loadCustomTheme().catch((e) =>
    console.warn("[NoteMark] auto-load theme failed:", e)
  );
  // 刷新固定主题目录下的已安装主题列表（供菜单展示）
  refreshThemeList().catch((e) =>
    console.warn("[NoteMark] refresh theme list failed:", e)
  );

  // 应用启动时恢复深色模式偏好（无记录时保持默认浅色）
  loadDarkModePreference()
    .then((dark) => {
      if (dark === null) return;
      isDark.value = dark;
      applyDarkMode(dark);
    })
    .catch((e) => console.warn("[NoteMark] load dark mode failed:", e));

  // 恢复侧边栏展开状态与上次浏览的工作目录（无记录则保持默认展开、目录为空）
  loadSidebarOpen()
    .then((open) => {
      if (open !== null) sidebarOpen.value = open;
    })
    .catch((e) => console.warn("[NoteMark] load sidebar state failed:", e));
  loadWorkspaceDir()
    .then(async (dir) => {
      if (!dir) return;
      await refreshWorkspace(dir);
      // 目录已失效（被删除/移动）：清掉持久化记录，避免下次启动仍尝试恢复
      if (!workspaceDir.value) await clearWorkspaceDir();
    })
    .catch((e) => console.warn("[NoteMark] load workspace dir failed:", e));
});


onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("click", onDocumentClick);
  window.removeEventListener("beforeunload", onBeforeUnload);
  // 清理大纲刷新节流定时器，避免卸载后仍触发回调
  if (headingTimer !== null) {
    clearTimeout(headingTimer);
    headingTimer = null;
  }
  editorInstance?.destroy();
  editorInstance = null;
});
</script>

<template>
  <!-- 满屏无干扰布局：模拟 Typora 沉浸式写作 -->
  <div class="notemark-app">
    <!-- 固定顶部极简工具栏（不随编辑区滚动） -->
    <header class="mt-toolbar">
      <div class="mt-toolbar__left">
        <button
          class="mt-btn mt-btn--icon"
          :class="{ 'mt-btn--icon-on': sidebarOpen }"
          :title="sidebarOpen ? '收起侧边栏' : '展开侧边栏'"
          :aria-expanded="sidebarOpen"
          aria-label="切换侧边栏"
          @click="toggleSidebar"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
      </div>
      <div class="mt-toolbar__center">
        <span class="mt-file-name">
          <span v-if="isDirty" class="mt-dirty-dot" aria-hidden="true"></span>{{ displayName }}
        </span>
      </div>
      <div class="mt-toolbar__right">
        <button
          class="mt-btn mt-btn--icon"
          title="新建"
          aria-label="新建"
          @click="handleNew"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
        <div ref="recentMenuWrap" class="mt-split">
          <button
            class="mt-btn mt-btn--icon mt-split__main"
            title="打开"
            aria-label="打开"
            @click="handleOpen"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
          </button>
          <button
            class="mt-btn mt-btn--icon mt-split__arrow"
            title="最近打开"
            aria-label="最近打开"
            :aria-expanded="recentMenuOpen"
            @click.stop="toggleRecentMenu"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <div v-if="recentMenuOpen" class="mt-theme-menu mt-theme-menu--recent" role="menu">
            <div class="mt-theme-menu__status" aria-hidden="true">最近打开</div>
            <template v-if="recentFiles.length">
              <button
                v-for="f in recentFiles"
                :key="f.path"
                class="mt-theme-menu__item mt-recent__item"
                role="menuitem"
                :title="f.path"
                @click="openRecentFile(f.path)"
              >
                <span class="mt-recent__name">{{ f.name }}</span>
                <span class="mt-recent__dir">{{ dirOfPath(f.path) }}</span>
              </button>
              <div class="mt-theme-menu__sep" role="separator"></div>
              <button
                class="mt-theme-menu__item mt-theme-menu__item--muted"
                role="menuitem"
                @click="clearRecent"
              >清空列表</button>
            </template>
            <div v-else class="mt-theme-menu__empty">（暂无记录）</div>
          </div>
        </div>
        <button
          class="mt-btn mt-btn--icon"
          title="保存"
          aria-label="保存"
          @click="handleSave"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
        </button>
        <div ref="exportMenuWrap" class="mt-theme-wrap">
          <button
            class="mt-btn mt-btn--icon"
            title="导出"
            aria-label="导出"
            @click.stop="toggleExportMenu"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </button>
          <div v-if="exportMenuOpen" class="mt-theme-menu" role="menu">
            <button
              class="mt-theme-menu__item"
              role="menuitem"
              @click="exportHtml"
            >HTML 网页（.html）</button>
            <button
              class="mt-theme-menu__item"
              role="menuitem"
              @click="exportPdf"
            >PDF 文档（.pdf）</button>
            <button
              class="mt-theme-menu__item"
              role="menuitem"
              @click="exportDocx"
            >Word 文档（.docx）</button>
            <div class="mt-theme-menu__sep" role="separator"></div>
            <button
              class="mt-theme-menu__item"
              role="menuitem"
              @click="exportTxt"
            >纯文本（.txt）</button>
          </div>
        </div>
        <div class="mt-toolbar__sep" role="separator"></div>
        <div ref="themeMenuWrap" class="mt-theme-wrap">
          <button
            class="mt-btn mt-btn--icon"
            title="主题"
            aria-label="主题"
            @click.stop="toggleThemeMenu"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" stroke="none" />
              <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" stroke="none" />
              <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" stroke="none" />
              <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" stroke="none" />
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
            </svg>
          </button>
          <div v-if="themeMenuOpen" class="mt-theme-menu" role="menu">
            <button
              class="mt-theme-menu__item"
              role="menuitem"
              @click="toggleDarkMode"
            >
              深色模式：{{ isDark ? "开" : "关" }}
            </button>

            <div class="mt-theme-menu__sep" role="separator"></div>

            <button
              class="mt-theme-menu__item"
              :class="{ 'mt-theme-menu__item--active': isDefaultThemeActive() }"
              role="menuitem"
              @click="useDefaultTheme"
            >
              内置主题（默认）
            </button>

            <template v-if="installedThemes.length">
              <button
                v-for="t in installedThemes"
                :key="t.filePath"
                class="mt-theme-menu__item"
                :class="{ 'mt-theme-menu__item--active': isThemeActive(t) }"
                role="menuitem"
                @click="switchTheme(t)"
              >
                {{ t.name }}
              </button>
            </template>

            <div class="mt-theme-menu__sep" role="separator"></div>

            <button
              class="mt-theme-menu__item"
              role="menuitem"
              @click="importTheme"
            >
              导入自定义主题...
            </button>
            <button
              v-if="isTauri"
              class="mt-theme-menu__item"
              role="menuitem"
              @click="openThemeFolder"
            >
              打开主题文件夹
            </button>
          </div>
        </div>
        <button
          class="mt-btn mt-btn--icon"
          :class="{ 'mt-btn--icon-on': sourceMode }"
          title="源码模式（Ctrl+/）"
          aria-label="源码模式"
          @click="toggleSourceMode"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </button>
      </div>
    </header>

    <!-- 查找 / 替换浮层（绝对定位在工具栏下方右侧，不占布局高度） -->
    <FindBar
      ref="findBarRef"
      :open="findOpen"
      :replace-mode="findReplaceMode"
      :query="findQuery"
      :replacement="findReplacement"
      :case-sensitive="findCaseSensitive"
      :whole-word="findWholeWord"
      :match-count="findCount"
      :match-index="findIndex"
      @update:query="onFindQuery"
      @update:replacement="findReplacement = $event"
      @toggle-case="toggleCaseSensitive"
      @toggle-word="toggleWholeWord"
      @prev="handleFindStep(-1)"
      @next="handleFindStep(1)"
      @replace="handleReplaceOne"
      @replace-all="handleReplaceAll"
      @close="closeFindBar"
    />

    <!-- 主体：侧边栏 + 编辑区（侧边栏收起时编辑区自动占满） -->
    <div class="mt-body">
      <Sidebar
        :open="sidebarOpen"
        :dir="workspaceDir"
        :dirs="workspaceDirs"
        :files="workspaceFiles"
        :current-path="currentPath"
        :headings="headings"
        :is-tauri="isTauri"
        @close="toggleSidebar"
        @pick-folder="handlePickFolder"
        @enter-dir="handleEnterDir"
        @go-parent="handleGoParent"
        @open-file="handleSidebarOpenFile"
        @goto-heading="handleGotoHeading"
        @file-action="handleFileAction"
        @dir-action="handleDirAction"
        @blank-action="handleBlankAction"
      />

      <!-- 编辑区：占据工具栏下方全部剩余高度 -->
      <main class="mt-editor-wrap">
        <div
          ref="editorHost"
          class="mt-editor"
          :class="{ 'mt-editor--hidden': sourceMode }"
        ></div>
        <!-- 源码模式：用 textarea 查看/编辑 Markdown 原文。
             v-show 而非 v-if，保证 editorHost 不被销毁、milkdown 视图常驻。 -->
        <textarea
          v-show="sourceMode"
          ref="sourceTextarea"
          class="mt-source"
          :value="sourceDraft"
          spellcheck="false"
          placeholder="Markdown 源码"
          @input="onSourceInput"
        ></textarea>
      </main>
    </div>

    <!-- 未保存修改确认对话框（保存 / 不保存 / 取消） -->
    <div v-if="confirmState" class="mt-modal-mask" @click.self="resolveConfirm('cancel')">
      <div class="mt-modal" role="dialog" aria-modal="true" aria-label="未保存的修改">
        <p class="mt-modal__message">{{ confirmState.message }}</p>
        <div class="mt-modal__actions">
          <button class="mt-btn mt-btn--danger" @click="resolveConfirm('discard')">不保存</button>
          <button class="mt-btn" @click="resolveConfirm('cancel')">取消</button>
          <button class="mt-btn mt-btn--primary" @click="resolveConfirm('save')">保存</button>
        </div>
      </div>
    </div>

    <!-- 通用确认对话框（删除文件等不可撤销操作） -->
    <div v-if="confirmDialog" class="mt-modal-mask" @click.self="resolveConfirmDialog(false)">
      <div class="mt-modal" role="dialog" aria-modal="true" :aria-label="confirmDialog.message">
        <p class="mt-modal__message">{{ confirmDialog.message }}</p>
        <div class="mt-modal__actions">
          <button class="mt-btn" @click="resolveConfirmDialog(false)">取消</button>
          <button
            class="mt-btn"
            :class="confirmDialog.danger ? 'mt-btn--danger-solid' : 'mt-btn--primary'"
            @click="resolveConfirmDialog(true)"
          >{{ confirmDialog.confirmText }}</button>
        </div>
      </div>
    </div>

    <!-- 输入对话框（重命名 / 新建文件） -->
    <div v-if="promptState" class="mt-modal-mask" @click.self="resolvePrompt(null)">
      <div class="mt-modal" role="dialog" aria-modal="true" :aria-label="promptState.title">
        <p class="mt-modal__message">{{ promptState.title }}</p>
        <input
          ref="promptInput"
          v-model="promptState.value"
          class="mt-input"
          type="text"
          spellcheck="false"
          @keydown.enter="resolvePrompt(promptState.value)"
          @keydown.esc.stop="resolvePrompt(null)"
        />
        <div class="mt-modal__actions">
          <button class="mt-btn" @click="resolvePrompt(null)">取消</button>
          <button class="mt-btn mt-btn--primary" @click="resolvePrompt(promptState.value)">
            {{ promptState.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notemark-app {
  position: fixed;
  inset: 0;
  margin: 0;
  padding: 0;
  border: none;
  outline: none;
  box-shadow: none;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--mt-bg, #ffffff);
}

/* 固定顶部工具栏：Typora 风格极简 */
.mt-toolbar {
  position: relative;
  flex: 0 0 auto;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 14px;
  border-bottom: 1px solid var(--mt-border, #eaeaea);
  background: var(--mt-toolbar-bg, #fafafa);
  font-size: 13px;
  color: var(--mt-fg, #333);
  user-select: none;
}

.mt-toolbar__left,
.mt-toolbar__right {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 按钮组不参与收缩、不换行：宁可让文件名省略，也不让按钮竖起来 */
  flex-shrink: 0;
  white-space: nowrap;
}

/* 文件名绝对居中于窗口：脱离 flex 流，不参与空间竞争。
   若采用「左右按内容定宽 + 中间占满剩余」，文件名只能在两侧按钮之间的空档里居中，
   而右侧按钮组（约 208px）远宽于左侧（约 28px），实测会偏左约 90px。
   --mt-side-safe 是单侧避让宽度，需覆盖「右半边所有占位」：
   右侧按钮组 230px（新建/保存/导出/源码/主题各 28 + 打开拆分 45
   + 5 处按钮间距 40 + 1 条分组分隔线 5px）
   + 工具栏右内边距 14px + 与按钮之间的呼吸间隙 8px ≈ 252px，
   向上取整 260px 留一点余量。
   按钮分组：文件操作（新建/打开/保存/导出）| 视图外观（源码/主题）。
   注意百分比基准是工具栏的 padding box（含左右 14px 内边距），不是内容区，
   漏算内边距会让长标题在窄窗口下压到按钮上。
   增减工具栏按钮时需同步调整该值。 */
.mt-toolbar__center {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  --mt-side-safe: 260px;
  max-width: calc(100% - 2 * var(--mt-side-safe));
  text-align: center;
  overflow: hidden;
}

.mt-file-name {
  color: var(--mt-muted, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 宽度由中间列（可收缩的 flex 项）决定，而不是固定的 40vw，
     否则长文件名会挤占按钮空间 */
  max-width: 100%;
  display: inline-block;
  vertical-align: middle;
}

/* 未保存修改的圆点标记 */
.mt-dirty-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--mt-dirty, #e74c3c);
  margin-right: 6px;
}

.mt-btn {
  background: transparent;
  border: 1px solid var(--mt-border, #e0e0e0);
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 13px;
  color: var(--mt-fg, #333);
  cursor: pointer;
  line-height: 1.4;
  /* 按钮文字始终单行、按钮自身不被压缩 */
  white-space: nowrap;
  flex-shrink: 0;
}

.mt-btn:hover {
  background: var(--mt-hover, #f0f0f0);
}

.mt-btn:active {
  background: var(--mt-active, #e6e6e6);
}

/* 图标按钮（工具栏全部按钮）：图标居中、固定宽高，含义由 title 悬停提示给出 */
.mt-btn--icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  padding: 0;
}

/* 常驻开关的统一激活态（侧边栏展开 / 源码模式开启）：浅灰底 + 常规图标色。
   不用主题色实底：这两个都是「随时可切回」的常驻开关，长时间停留在这种状态，
   实底主色会在极简工具栏里过于抢眼；且两者性质相同，激活反馈必须一致。
   （主色实底留给对话框里的「确定 / 保存」这类一次性的主要动作。） */
.mt-btn--icon-on {
  background: var(--mt-active, #e6e6e6);
  border-color: var(--mt-border, #e0e0e0);
  color: var(--mt-fg, #333);
}

/* 与 .mt-btn:hover 同特异性，靠定义顺序取胜：展开态悬停时略变浅 */
.mt-btn--icon-on:hover {
  background: var(--mt-hover, #f0f0f0);
  border-color: var(--mt-border, #e0e0e0);
  color: var(--mt-fg, #333);
}

/* 「打开」拆分按钮：左半是主操作（弹文件对话框），右半是最近打开列表。
   两个按钮各自可点，用 -1px 负边距共用中间那条边框，避免中间出现双线。 */
.mt-split {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

.mt-split__main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.mt-split__arrow {
  width: 18px;
  margin-left: -1px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

/* 工具栏分组分隔线：隔开「文件操作 / 视图 / 输出」三组。
   左右各 2px 边距与 flex gap 叠加后，组间约 21px、组内 8px，分组关系一眼可辨。 */
.mt-toolbar__sep {
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--mt-border, #e0e0e0);
  flex-shrink: 0;
}

/* 最近打开菜单：比主题菜单更宽，给完整路径留出空间 */
.mt-theme-menu--recent {
  min-width: 220px;
  max-width: 320px;
}

/* 列表项两行：文件名 + 所在目录，过长各自省略 */
.mt-recent__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  max-width: 100%;
}

.mt-recent__name,
.mt-recent__dir {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mt-recent__dir {
  font-size: 11px;
  color: var(--mt-muted, #888);
}

/* 次要动作（清空列表）：弱化存在感，不与文件项抢视线 */
.mt-theme-menu__item--muted {
  color: var(--mt-muted, #888);
}

.mt-btn--primary {
  background: var(--mt-accent, #2563eb);
  border-color: var(--mt-accent, #2563eb);
  color: #fff;
}

.mt-btn--primary:hover {
  background: var(--mt-accent-hover, #1d4ed8);
  border-color: var(--mt-accent-hover, #1d4ed8);
}

.mt-btn--danger {
  color: var(--mt-danger, #d33);
}

/* 主题下拉菜单 */
.mt-theme-wrap {
  position: relative;
}

.mt-theme-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 100;
  min-width: 180px;
  max-width: 260px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--mt-bg, #ffffff);
  border: 1px solid var(--mt-border, #e0e0e0);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.mt-theme-menu__status {
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--mt-muted, #888);
  border-bottom: 1px solid var(--mt-border, #e0e0e0);
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}

.mt-theme-menu__item {
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--mt-fg, #333);
  cursor: pointer;
  white-space: nowrap;
}

.mt-theme-menu__item:hover {
  background: var(--mt-hover, #f0f0f0);
}

/* 当前生效主题高亮 */
.mt-theme-menu__item--active {
  color: var(--mt-accent, #2563eb);
  font-weight: 600;
}

.mt-theme-menu__item--active::before {
  content: "✓ ";
}

/* 菜单分组分隔线 */
.mt-theme-menu__sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--mt-border, #e0e0e0);
}

/* 无已安装主题时的提示 */
.mt-theme-menu__empty {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--mt-muted, #888);
}

/* 未保存修改确认对话框 */
.mt-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
}

.mt-modal {
  min-width: 300px;
  max-width: 420px;
  background: var(--mt-bg, #ffffff);
  border-radius: 8px;
  padding: 18px 20px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
}

.mt-modal__message {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--mt-fg, #333);
  white-space: pre-wrap;
}

.mt-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 危险操作的实底按钮（删除确认），与 mt-btn--danger（仅文字变红）区分 */
.mt-btn--danger-solid {
  background: var(--mt-danger, #d33);
  border-color: var(--mt-danger, #d33);
  color: #fff;
}

.mt-btn--danger-solid:hover {
  background: var(--mt-danger-hover, #b52a2a);
  border-color: var(--mt-danger-hover, #b52a2a);
}

/* 输入对话框的输入框（重命名 / 新建文件） */
.mt-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  margin-bottom: 16px;
  font-family: inherit;
  font-size: 13px;
  color: var(--mt-fg, #333);
  background: var(--mt-bg, #ffffff);
  border: 1px solid var(--mt-border, #e0e0e0);
  border-radius: 4px;
  outline: none;
}

.mt-input:focus {
  border-color: var(--mt-accent, #2563eb);
}

/* 主体区：侧边栏 + 编辑区横向排列，占据工具栏下方全部剩余高度 */
.mt-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* 编辑区容器：占据剩余高度并允许内部滚动 */
.mt-editor-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* editorHost：实际可滚动区域，撑满可用高度。
   Milkdown 会在此容器内新建唯一的 .milkdown 根节点，
   主题样式由 theme/index.css 在该 .milkdown 上生效。 */
.mt-editor {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100%;
  overflow-y: auto;
  border: none;
  outline: none;
  box-shadow: none;
}

/* 源码模式下隐藏编辑器（display:none 而非销毁 DOM，保证 milkdown 视图常驻） */
.mt-editor--hidden {
  display: none;
}

/* 源码模式 textarea：等宽字体、跟随主题深浅色、软换行 */
.mt-source {
  width: 100%;
  height: 100%;
  display: block;
  box-sizing: border-box;
  padding: 24px 32px;
  border: none;
  outline: none;
  resize: none;
  background: var(--mt-bg, #ffffff);
  color: var(--mt-fg, #333);
  font-family: var(
    --mt-font-mono,
    "SFMono-Regular",
    "JetBrains Mono",
    Consolas,
    "Liberation Mono",
    Menlo,
    Courier,
    monospace
  );
  font-size: 14px;
  line-height: 1.7;
  tab-size: 4;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.mt-source::placeholder {
  color: var(--mt-muted, #888);
}

/* 窄窗口：压缩间距与内边距，让文件名尽量少被截断 */
@media (max-width: 680px) {
  .mt-toolbar {
    padding: 0 8px;
    gap: 4px;
  }
  .mt-toolbar__right,
  .mt-toolbar__left {
    gap: 4px;
  }
  .mt-btn {
    padding: 3px 7px;
  }
  .mt-btn--icon {
    width: 26px;
  }
}
</style>
