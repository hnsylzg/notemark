/*
 * diagram-view.ts — 为 diagram 节点（```mermaid 代码块）挂载 NodeView 渲染器
 *
 * @milkdown/plugin-diagram 只负责数据层：把 ```mermaid 代码块解析成
 * ProseMirror 的 diagram 节点（attrs: { identity, value }），但它的
 * toDOM 只是生成一个含代码文本的 <div data-type="diagram">，并不会调用
 * mermaid 渲染出 SVG。因此这里用 @milkdown/utils 的 $view 为 diagram
 * 节点挂一个 NodeView：
 *   - 动态 import mermaid（code-split，首次渲染图表才加载）
 *   - 按 html[data-theme] 切换 mermaid 主题（dark / default，使用默认配色）
 *   - 容器类名 .diagram，与主题中的 Mermaid 图表样式对应（无外框）
 *   - 渲染失败时展示 .error 信息
 */
import { $view } from "@milkdown/utils";
import { loadMathJax } from "./mathjax";
import { diagramSchema } from "@milkdown/plugin-diagram";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import { deleteEmptyEditableBlock, exitToNextLine } from "./block-exit";
import { handleSourceKeydown } from "./source-tab";
import { preserveMermaidVennTitleInSvg } from "./mermaid-export";

type MermaidLike = {
  initialize(config: unknown): void;
  render(id: string, text: string): Promise<{ svg: string }>;
};

const isDarkTheme = () =>
  document.documentElement.dataset.theme === "dark";

/**
 * Mermaid 的 SVG 几何由字体度量参与计算。固定为内置主题使用的字体栈，
 * 可保证所有主题的框、文字基线和导出结果一致；主题只负责配色。
 */
export const MERMAID_FONT_FAMILY =
  '"Open Sans", "Clear Sans", "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", "Segoe UI Emoji", sans-serif';

function readMermaidTheme(): string | null {
  const el = document.querySelector<HTMLElement>(".milkdown .diagram");
  if (!el) return null;
  const style = getComputedStyle(el);
  return style.getPropertyValue("--mermaid-theme").trim() || null;
}

/** 组装 Mermaid 配置：主题只覆盖配色，字体和图形几何保持全局一致。 */
export function getMermaidConfig(): Record<string, unknown> {
  return {
    startOnLoad: false,
    theme: readMermaidTheme() ?? (isDarkTheme() ? "dark" : "redux"),
    look: "classic",
    layout: "dagre",
    fontFamily: MERMAID_FONT_FAMILY,
    // 用纯 SVG <text> 渲染标签，避免 foreignObject 导致 Word/PDF 文字裁切。
    htmlLabels: false,
    flowchart: { look: "classic" },
  };
}

let mermaidPromise: Promise<MermaidLike> | null = null;
const MERMAID_SVG_CACHE_LIMIT = 100;
const mermaidSvgCache = new Map<string, Promise<string>>();

function getMermaid(): Promise<MermaidLike> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(
      (mod) => (mod.default ?? mod) as MermaidLike
    );
  }
  return mermaidPromise;
}

function cacheMermaidSvg(
  key: string,
  promise: Promise<string>
): Promise<string> {
  if (mermaidSvgCache.size >= MERMAID_SVG_CACHE_LIMIT) {
    const oldest = mermaidSvgCache.keys().next().value;
    if (oldest) mermaidSvgCache.delete(oldest);
  }
  mermaidSvgCache.set(key, promise);
  void promise.catch(() => {
    if (mermaidSvgCache.get(key) === promise) mermaidSvgCache.delete(key);
  });
  return promise;
}

function mermaidUsesMathJax(source: string): boolean {
  return /\$\$[\s\S]*\$\$/.test(source);
}

/** Render a Mermaid source string with the editor's active theme settings. */
export async function renderMermaidSvg(
  value: string,
  identity: string,
  revision: number
): Promise<string> {
  const config = getMermaidConfig();
  const cacheKey = `${JSON.stringify(config)}\u0000${value}`;
  const cached = mermaidSvgCache.get(cacheKey);
  if (cached) return cached;

  const renderPromise = (async () => {
    // Only Mermaid labels using $$...$$ need MathJax. Waiting for it for every
    // diagram kept ordinary flowcharts stuck on the loading preview.
    if (mermaidUsesMathJax(value)) await loadMathJax();
    const mermaid = await getMermaid();
    mermaid.initialize(config);
    const safeIdentity = identity.replace(/[^a-zA-Z0-9_-]/g, "-");
    const { svg } = await mermaid.render(
      `diagram-${safeIdentity}-${revision}`,
      value
    );
    return svg;
  })();
  return cacheMermaidSvg(cacheKey, renderPromise);
}

/** 所有存活 diagram 的重渲染回调（主题切换时全部刷新） */
const renderers = new Set<() => void>();

/** Register a preview renderer that must refresh when the Mermaid theme changes. */
export function subscribeMermaidTheme(renderer: () => void): () => void {
  renderers.add(renderer);
  return () => renderers.delete(renderer);
}

let themeObserver: MutationObserver | null = null;
function watchThemeSwitch(): void {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => {
    for (const render of renderers) render();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}
watchThemeSwitch();

/**
 * 监听自定义主题 <style id="custom-theme"> 的注入与内容变化：
 * 主题管理器（themeManager）通过原地替换该 style 的 textContent 应用主题，
 * 不会触发 data-theme 的 MutationObserver，因此 mermaid 图表（其配置在渲染时
 * 从 CSS 变量读取）不会自动重渲染。这里补一个对 custom-theme 的监听，
 * 让切换 / 重新导入主题后图表立即按新配置刷新；主题被移除时回退到内置默认配置。
 */
function watchCustomTheme(): void {
  const rerenderAll = () => {
    for (const render of renderers) render();
  };
  const styleObserver = new MutationObserver(rerenderAll);
  const observed = new WeakSet<Element>();
  let lastHadStyle: boolean | null = null;

  const sync = () => {
    const style = document.getElementById("custom-theme");
    const has = !!style;
    if (style && !observed.has(style)) {
      styleObserver.observe(style, { childList: true, subtree: true });
      observed.add(style);
      rerenderAll();
    }
    if (has !== lastHadStyle) {
      lastHadStyle = has;
      if (!has) rerenderAll(); // 主题移除：回退默认 mermaid 配置
    }
  };

  sync();
  // 捕捉 custom-theme 的创建 / 移除（重新导入相同主题时只改内容，由 styleObserver 处理）
  new MutationObserver(sync).observe(document.head, { childList: true });
}
watchCustomTheme();

export const diagramView = $view(diagramSchema.node, () => {
  const nodeView: NodeViewConstructor = (node, view, getPos) => {
    const dom = document.createElement("div");
    dom.className = "diagram";
    // 导出定位用：docx 导出据此复用本节点已渲染好的 SVG（与屏幕/PDF 所见一致）
    dom.dataset.diagramId = String(node.attrs.identity ?? "");

    let token = 0;
    let editing = false;

    const render = () => {
      if (editing) return; // 编辑态下保持 textarea，不重渲染
      const current = ++token;
      const value = node.attrs.value as string;
      dom.className = "diagram";
      dom.dataset.diagramId = String(node.attrs.identity ?? "");
      if (!value) {
        dom.textContent = "空流程图（点击输入）";
        dom.classList.add("diagram-empty");
        return;
      }
      void renderMermaidSvg(
        value,
        String(node.attrs.identity),
        current
      )
        .then((svg) => {
          if (current !== token) return;
          // 渲染期间用户可能已点进编辑态（textarea 已替换 dom 子节点），
          // 此时不要把 SVG 写回去，否则 textarea（及其光标）会被吞掉。
          if (editing) return;
          dom.innerHTML = preserveMermaidVennTitleInSvg(svg);
        })
        .catch((error) => {
          if (current !== token) return;
          // 同上：编辑态下不覆盖 textarea
          if (editing) return;
          const pre = document.createElement("pre");
          pre.className = "error";
          pre.textContent =
            error instanceof Error ? error.message : String(error);
          dom.replaceChildren(pre);
        });
    };

    // 单击图表进入源码编辑；Esc 取消，Ctrl/Cmd+Enter 或失焦保存。
    // stopEvent 拦截的是传给 ProseMirror 的事件，不影响挂在本 DOM 上的监听器。
    const startEdit = () => {
      if (editing) return;
      editing = true;
      const textarea = document.createElement("textarea");
      textarea.className = "diagram-editor";
      textarea.value = node.attrs.value as string;
      textarea.spellcheck = false;
      textarea.rows = 1;
      const source = document.createElement("div");
      source.className = "mt-block-source mt-block-source--diagram";
      const open = document.createElement("span");
      open.className = "mt-block-source-marker";
      open.textContent = "```mermaid";
      open.setAttribute("aria-hidden", "true");
      const close = open.cloneNode(true) as HTMLSpanElement;
      close.textContent = "```";
      source.append(open, textarea, close);
      dom.replaceChildren(source);
      textarea.focus();
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);

      const finish = (commit: boolean, focusEditor = false): boolean => {
        if (!editing) return false;
        editing = false;
        const next = commit ? textarea.value : (node.attrs.value as string);
        const pos = getPos();
        if (typeof pos === "number") {
          if (!next.trim()) {
            deleteEmptyEditableBlock(
              view,
              pos,
              node.nodeSize,
              focusEditor
            );
            return true;
          }
          if (next !== node.attrs.value) {
            // setNodeMarkup 会整体替换 attrs，需合并原 attrs（保留 identity 等字段）
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                value: next,
              })
            );
            if (focusEditor) view.focus();
            return false;
          }
        }
        render();
        if (focusEditor) view.focus();
        return false;
      };

      // 隔离 ProseMirror：textarea 的键盘/鼠标事件若冒泡到 PM，
      // 会被 PM 的 keymap/编辑指令处理，导致 textarea 与文档互相干扰。
      textarea.addEventListener("mousedown", (e) => e.stopPropagation());
      textarea.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (handleSourceKeydown(e, textarea)) return;
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false, true);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (finish(true, true)) return;
          // 与表格 / 代码块一致：保存后光标跳到块后的下一行
          const curPos = getPos();
          if (typeof curPos === "number") {
            exitToNextLine(view, curPos, node.nodeSize);
          }
        }
      });
      textarea.addEventListener("blur", () => finish(true));
    };

    dom.addEventListener("click", startEdit);
    render();
    renderers.add(render);

    return {
      dom,
      update: (updatedNode) => {
        if (updatedNode.type !== node.type) return false;
        if (
          updatedNode.attrs.value !== node.attrs.value ||
          updatedNode.attrs.identity !== node.attrs.identity
        ) {
          node = updatedNode;
          render();
        }
        return true;
      },
      // 图表区域不参与 ProseMirror 编辑交互（双击编辑由上方 DOM 监听器处理）
      stopEvent: () => true,
      // mermaid 注入的 SVG 变化不应触发 ProseMirror 重绘
      ignoreMutation: () => true,
      destroy: () => {
        renderers.delete(render);
      },
    };
  };
  return nodeView;
});
