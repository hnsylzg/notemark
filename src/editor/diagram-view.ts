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
import { diagramSchema } from "@milkdown/plugin-diagram";
import type { NodeViewConstructor } from "@milkdown/prose/view";

type MermaidLike = {
  initialize(config: unknown): void;
  render(id: string, text: string): Promise<{ svg: string }>;
};

const isDarkTheme = () =>
  document.documentElement.dataset.theme === "dark";

/**
 * 读取主题 CSS 中声明的 mermaid 配置（CSS 变量形式，用法同 Typora 主题）。
 * 变量可声明在 .milkdown .editor .diagram 或其任意祖先上，例如：
 *   --mermaid-theme: neutral;                  // 固定 mermaid 主题名
 *   --mermaid-font-family: ...;                // 图表字体
 *   --mermaid-flowchart-curve: basis;          // 连线曲线（linear/basis）
 *   --mermaid-flowchart-html-labels: true;     // 标签是否用 HTML 渲染
 *   --mermaid-flowchart-node-spacing: 60;      // 同层节点间距
 *   --mermaid-flowchart-rank-spacing: 90;      // 相邻层级间距
 * 未声明的变量不参与覆盖（保持内置默认 / 自动跟随明暗）。
 */
function readMermaidCssConfig(): Record<string, unknown> {
  const el = document.querySelector<HTMLElement>(".milkdown .diagram");
  if (!el) return {};
  const style = getComputedStyle(el);
  const pick = (name: string) => style.getPropertyValue(name).trim();

  const cfg: Record<string, unknown> = {};
  const theme = pick("--mermaid-theme");
  if (theme) cfg.theme = theme;

  const fontFamily = pick("--mermaid-font-family");
  if (fontFamily) cfg.fontFamily = fontFamily;

  const flowchart: Record<string, unknown> = {};
  const curve = pick("--mermaid-flowchart-curve");
  if (curve) flowchart.curve = curve;
  const htmlLabels = pick("--mermaid-flowchart-html-labels");
  if (htmlLabels) flowchart.htmlLabels = htmlLabels === "true";
  const nodeSpacing = pick("--mermaid-flowchart-node-spacing");
  if (nodeSpacing) flowchart.nodeSpacing = Number(nodeSpacing);
  const rankSpacing = pick("--mermaid-flowchart-rank-spacing");
  if (rankSpacing) flowchart.rankSpacing = Number(rankSpacing);
  if (Object.keys(flowchart).length > 0) cfg.flowchart = flowchart;

  return cfg;
}

/** 组装当前主题对应的 mermaid 配置：内置默认 + 主题 CSS 变量覆盖 */
function getMermaidConfig(): Record<string, unknown> {
  const base: Record<string, unknown> = {
    startOnLoad: false,
    theme: isDarkTheme() ? "dark" : "default",
    // 流程图标签用纯 SVG <text> 渲染（而非 foreignObject）：
    // mermaid 10 的 foreignObject 高度按初始化时的字体度量计算，字体就绪后
    // 实际行高会超出，导致标签文字底部被裁剪（英文更明显）。
    // htmlLabels: false 从源头规避该问题，且不依赖任何主题样式。
    flowchart: { htmlLabels: false },
  };
  // 主题 CSS 的 --mermaid-* 变量覆盖内置默认；flowchart 深合并，
  // 避免只声明 curve 等单项时把默认 htmlLabels: false 一起冲掉。
  const overrides = readMermaidCssConfig();
  if (overrides.flowchart) {
    overrides.flowchart = {
      ...(base.flowchart as Record<string, unknown>),
      ...(overrides.flowchart as Record<string, unknown>),
    };
  }
  return { ...base, ...overrides };
}

let mermaidPromise: Promise<MermaidLike> | null = null;
function getMermaid(): Promise<MermaidLike> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(
      (mod) => (mod.default ?? mod) as MermaidLike
    );
  }
  return mermaidPromise;
}

/** 所有存活 diagram 的重渲染回调（主题切换时全部刷新） */
const renderers = new Set<() => void>();
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

export const diagramView = $view(diagramSchema.node, () => {
  const nodeView: NodeViewConstructor = (node, view, getPos) => {
    const dom = document.createElement("div");
    dom.className = "diagram";

    let token = 0;
    let editing = false;

    const render = () => {
      if (editing) return; // 编辑态下保持 textarea，不重渲染
      const current = ++token;
      const value = node.attrs.value as string;
      if (!value) {
        dom.replaceChildren();
        return;
      }
      void getMermaid()
        .then(async (mermaid) => {
          if (current !== token) return;
          try {
            mermaid.initialize(getMermaidConfig());
            const id = `diagram-${String(node.attrs.identity)}-${current}`;
            const { svg } = await mermaid.render(id, value);
            if (current !== token) return;
            dom.innerHTML = svg;
          } catch (error) {
            if (current !== token) return;
            const pre = document.createElement("pre");
            pre.className = "error";
            pre.textContent =
              error instanceof Error ? error.message : String(error);
            dom.replaceChildren(pre);
          }
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
      dom.replaceChildren(textarea);
      // 实时自适应高度：每次输入都按当前行数调整（CSS min-height 兜底，过长时滚动）
      const fitHeight = () => {
        const n = textarea.value.split("\n").length;
        textarea.style.height = `${Math.min(Math.max(n + 1, 8), 32) * 1.6}em`;
      };
      fitHeight();
      textarea.addEventListener("input", fitHeight);
      textarea.focus();
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);

      const finish = (commit: boolean) => {
        if (!editing) return;
        editing = false;
        const next = commit ? textarea.value : (node.attrs.value as string);
        if (next !== node.attrs.value) {
          const pos = getPos();
          if (typeof pos === "number") {
            // setNodeMarkup 会整体替换 attrs，需合并原 attrs（保留 identity 等字段）
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                value: next,
              })
            );
            return; // update() 会触发重渲染
          }
        }
        render();
      };

      // 隔离 ProseMirror：textarea 的键盘/鼠标事件若冒泡到 PM，
      // 会被 PM 的 keymap/编辑指令处理，导致 textarea 与文档互相干扰。
      textarea.addEventListener("mousedown", (e) => e.stopPropagation());
      textarea.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(true);
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
