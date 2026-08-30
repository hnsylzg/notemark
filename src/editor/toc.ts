/*
 * toc.ts — 活的目录（[toc]）
 *
 * 语法：单独一行写 [toc]（前后空行或文档边界）即渲染为自动目录。
 *
 * 实现：
 * - $nodeSchema('toc')：atom 块级节点，DOM 为 <div class="mt-toc" data-type="toc">；
 * - $remark：解析阶段把独立成行的 [toc] 文本段落改写成自定义 mdast 节点 toc；
 * - $view：NodeView 只读渲染，实时扫描文档内所有 heading 生成可点击目录；
 *   每次 ProseMirror 状态更新时重渲染，标题增删/改名会自动同步。
 * - $inputRule：输入 [toc] 后即时插入 toc 节点；
 * - 序列化：toc 节点输出回 "[toc]"，外部编辑器（Typora/Obsidian）兼容；
 * - 目录点击跳转走 view.nodeDOM(pos) + scrollIntoView，不依赖 heading 的 id 锚点
 *   （编辑期绝不改写 heading DOM，避免惊动 ProseMirror 的 DOM 观察器造成死循环卡死）。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { MarkdownNode, RemarkPluginRaw } from "@milkdown/transformer";
import { $nodeSchema, $remark, $view, $inputRule } from "@milkdown/kit/utils";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { TextSelection } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

const TOC_NAME = "toc";

/** 给 heading 生成 slug（与 remark-slug 规则一致：小写、空格转 -、去除标点） */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    // 去除 md 语法符号与标点
    .replace(/[`*_~#]/g, "")
    .replace(/[^\w\s一-龥-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** remark：独立成行的 [toc] 段落 → toc 节点 */
const tocRemarkTransform: RemarkPluginRaw<never[]> = () => (tree) => {
  const visit = (node: MarkdownNode): void => {
    if (!Array.isArray(node.children)) return;
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i];
      if (
        child.type === "paragraph" &&
        Array.isArray(child.children) &&
        child.children.length === 1
      ) {
        const c0 = child.children[0];
        if (
          c0.type === "text" &&
          typeof c0.value === "string" &&
          c0.value.trim() === "[toc]"
        ) {
          node.children[i] = {
            type: "toc",
            data: {
              hName: "div",
              hProperties: { "data-type": TOC_NAME, class: "mt-toc" },
            },
            children: [],
          } as unknown as MarkdownNode;
          continue;
        }
      }
      visit(child);
    }
  };
  visit(tree as unknown as MarkdownNode);
};

export const tocRemark = $remark("notemark-toc", () => tocRemarkTransform);

export const tocSchema = $nodeSchema(TOC_NAME, () => ({
  group: "block",
  atom: true,
  selectable: false,
  draggable: false,
  isolating: true,
  attrs: {},
  parseDOM: [{ tag: `div[data-type="${TOC_NAME}"]` }],
  toDOM: () => ["div", { "data-type": TOC_NAME, class: "mt-toc" }],
  parseMarkdown: {
    match: (node) => node.type === "toc",
    runner: (state, _node, type) => {
      state.openNode(type).closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === TOC_NAME,
    runner: (state) => {
      // 注意：SerializerState.addNode(type, children, value, props)。
      // paragraph 的正文在 children 里，不能把字符串当 value 传（paragraph 无 value 字段，
      // 会导致 [toc] 被序列化成空段落，保存后目录丢失）。
      state.addNode("paragraph", [{ type: "text", value: "[toc]" }]);
    },
  },
}));

/** 输入 [toc] 即时插入 toc 节点 */
export const tocInputRule = $inputRule((ctx) => {
  const tocNodeType = tocSchema.type(ctx);
  return new InputRule(/^\[toc\]$/, (state, _match, start, end) => {
    const tr = state.tr.delete(start, end).replaceWith(
      start,
      start,
      tocNodeType.create(),
    );
    return tr;
  });
});

/** 收集文档所有 heading：{ level, text, pos } */
function collectHeadings(view: import("@milkdown/kit/prose/view").EditorView) {
  const headings: { level: number; text: string; pos: number }[] = [];
  let counter = 0;
  const usedSlugs = new Map<string, number>();
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const text = node.textContent;
    let slug = slugify(text) || `heading-${counter}`;
    const seen = usedSlugs.get(slug) ?? 0;
    usedSlugs.set(slug, seen + 1);
    if (seen > 0) slug = `${slug}-${seen}`;
    counter += 1;
    // 注意：编辑期不要改写 heading 的 DOM（不再注入 id）。
    // 一旦 [toc] 存在，任何内容变化都会刷新目录；若在此处 setAttribute 改写
    // heading DOM，会惊动 ProseMirror 的 DOM 观察器 → 派发事务 → 又刷新目录 →
    // 无限循环、主线程阻塞、界面卡死（输入 / 等任意文档改动都会触发）。
    // 点击跳转改用 view.nodeDOM(pos) + scrollIntoView，无需 id。
    headings.push({ level: node.attrs.level, text, pos: pos + 1 });
    return false;
  });
  return headings;
}

// 重入保护：渲染期间若再次被触发（如目录刷新又惊动 DOM 观察器），直接跳过，
// 杜绝任何形式的目录刷新递归，作为 id 改写移除后的第二道防线。
let tocRendering = false;

/** 渲染目录到指定 div */
function renderToc(
  dom: HTMLElement,
  view: import("@milkdown/kit/prose/view").EditorView,
) {
  if (tocRendering) return;
  tocRendering = true;
  try {
  const headings = collectHeadings(view);
  dom.innerHTML = "";

  const title = document.createElement("div");
  title.className = "mt-toc-title";
  title.textContent = "目录";
  dom.appendChild(title);

  if (!headings.length) {
    const empty = document.createElement("div");
    empty.className = "mt-toc-empty";
    empty.textContent = "（暂无标题）";
    dom.appendChild(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "mt-toc-list";
  for (const h of headings) {
    const li = document.createElement("li");
    li.className = `mt-toc-item mt-toc-level-${h.level}`;
    const a = document.createElement("a");
    a.href = "javascript:void(0)";
    a.textContent = h.text || "(无标题)";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = view.state.doc.resolve(h.pos);
      const tr = view.state.tr.setSelection(
        TextSelection.near(target),
      );
      view.dispatch(tr);
      const headingDom = view.nodeDOM(h.pos - 1) as HTMLElement | null;
      headingDom?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    li.appendChild(a);
    list.appendChild(li);
  }
  dom.appendChild(list);
  } finally {
    tocRendering = false;
  }
}

export const tocView = $view(tocSchema.node, () => {
  const nodeView: NodeViewConstructor = (_node, view) => {
    const dom = document.createElement("div");
    dom.className = "mt-toc";
    dom.dataset.type = TOC_NAME;

    const render = () => {
      const container = view.dom.querySelector(
        `div[data-type="${TOC_NAME}"]`,
      ) as HTMLElement | null;
      if (container) renderToc(container, view);
    };
    // 首次渲染（DOM 已就绪）
    setTimeout(render, 0);

    // 文档变化（含标题增删/改名）后刷新目录：
    // $view 不提供全局 update 钩子，统一由下面的 $prose 插件（tocPlugin）监听刷新
    return {
      dom,
      ignoreMutation: () => true,
      destroy: () => {},
      // 借助 ProseMirror 的 update 钩子：当本节点之外的内容变化时刷新
      // 但 $view 不提供全局 update，故额外用 $prose 插件监听（见 tocPlugin）。
    } as unknown as ReturnType<NodeViewConstructor>;
  };
  return nodeView;
});

/**
 * 全局插件：监听文档更新，刷新所有 [toc] 目录。
 * （NodeView 自身无法监听文档其他部分变化，因此用 $prose 插件统一处理。）
 */
export const tocPlugin = $prose(() =>
  new Plugin({
    key: new PluginKey("notemark-toc"),
    view: (editorView) => {
      const refresh = () => {
        const containers = editorView.dom.querySelectorAll(
          `div[data-type="${TOC_NAME}"]`,
        );
        containers.forEach((c) =>
          renderToc(c as HTMLElement, editorView),
        );
      };
      setTimeout(refresh, 0);
      return {
        update: (view) => {
          const containers = view.dom.querySelectorAll(
            `div[data-type="${TOC_NAME}"]`,
          );
          containers.forEach((c) =>
            renderToc(c as HTMLElement, view),
          );
        },
      };
    },
  }),
);

/** 注册给 getEditorPlugins() 的插件集合 */
export const tocPlugins: MilkdownPlugin[] = [
  ...tocSchema,
  ...tocRemark,
  tocInputRule,
  tocView,
  tocPlugin,
];
