/*
 * math-view.ts — 完全接管 math_block 节点（自带的 schema + NodeView）
 *
 * 为什么不复用 @milkdown/plugin-math 的 block 节点：
 *   plugin-math 的 math_block schema.toDOM 内部会调 KaTeX 渲染一次，
 *   再加上我们自己的 NodeView 又渲染一次 → 双重 KaTeX（用户看到的“下面那行公式”）。
 * 因此这里自己定义 math_block（无 KaTeX 的 toDOM），只保留 plugin-math 的
 * inline 数学部分，彻底消除 schema 侧的 KaTeX。
 *
 * NodeView 内部固定一个 content 子容器，渲染时只替换其内容，绝不在 dom
 * 上重复 append，保证公式永远只有一个 KaTeX 实例。点击进入原地编辑。
 */
import { $node, $view, $inputRule } from "@milkdown/utils";
import { InputRule } from "@milkdown/prose/inputrules";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import katex from "katex";
import "katex/dist/katex.min.css";

const BLOCK_NAME = "math_block";

export const mathBlockSchema = $node(BLOCK_NAME, () => ({
  content: "text*",
  group: "block",
  marks: "",
  defining: true,
  atom: true,
  isolating: true,
  attrs: { value: { default: "" } },
  parseDOM: [
    {
      tag: `div[data-type="${BLOCK_NAME}"]`,
      preserveWhitespace: "full" as const,
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).dataset.value ?? "",
      }),
    },
  ],
  // 关键：toDOM 只输出空容器，不调 KaTeX（避免双重渲染）
  toDOM: () => ["div", { "data-type": BLOCK_NAME, class: "milkdown-math-block" }],
  parseMarkdown: {
    match: ({ type }) => type === "math",
    runner: (state, node, type) => {
      state.addNode(type, { value: (node as unknown as { value: string }).value });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === BLOCK_NAME,
    runner: (state, node) => {
      state.addNode("math", undefined, (node.attrs.value as string) ?? "");
    },
  },
}));

export const mathBlockInputRule = $inputRule((ctx) => {
  const type = mathBlockSchema.type(ctx);
  return new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
    const $pos = state.doc.resolve(start);
    if (
      !$pos
        .node(-1)
        .canReplaceWith($pos.index(-1), $pos.indexAfter(-1), type)
    ) {
      return null;
    }
    return state.tr.delete(start, end).setBlockType(start, start, type);
  });
});

export const mathBlockView = $view(mathBlockSchema, () => {
  const nodeView: NodeViewConstructor = (node, view, getPos) => {
    const dom = document.createElement("div");
    dom.className = "milkdown-math-block";
    dom.dataset.type = BLOCK_NAME;

    const content = document.createElement("div");
    content.className = "milkdown-math-content";
    dom.appendChild(content);

    let editing = false;

    const renderKatex = (value: string) => {
      content.replaceChildren();
      if (value && value.trim()) {
        try {
          const container = document.createElement("div");
          container.className = "katex-display";
          katex.render(value, container, {
            displayMode: true,
            throwOnError: false,
            trust: true,
          });
          content.appendChild(container);
        } catch {
          content.textContent = value;
        }
      } else {
        content.className = "milkdown-math-content math-empty";
        content.textContent = "空公式（点击输入）";
      }
    };

    const startEdit = () => {
      if (editing) return;
      editing = true;
      const textarea = document.createElement("textarea");
      textarea.className = "math-block-editor";
      textarea.value = (node.attrs.value as string) ?? "";
      textarea.spellcheck = false;
      content.replaceChildren(textarea);

      const fitHeight = () => {
        const n = textarea.value.split("\n").length;
        textarea.style.height = `${Math.min(Math.max(n + 1, 4), 18) * 1.6}em`;
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
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                value: next,
              }),
            );
            return; // update() 会触发重渲染
          }
        }
        renderKatex(next);
      };

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

    dom.addEventListener("mousedown", (e) => e.stopPropagation());
    dom.addEventListener("click", startEdit);
    dom.addEventListener("dblclick", startEdit);
    renderKatex((node.attrs.value as string) ?? "");

    return {
      dom,
      contentDOM: undefined,
      update: (updatedNode) => {
        if (updatedNode.type !== node.type) return false;
        if (updatedNode.attrs.value !== node.attrs.value) {
          node = updatedNode;
          if (!editing) renderKatex(node.attrs.value as string);
        }
        return true;
      },
      ignoreMutation: () => true,
      destroy: () => {},
    };
  };
  return nodeView;
});

export const mathBlockPlugins = [
  mathBlockSchema,
  mathBlockInputRule,
  mathBlockView,
];
