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
import { TextSelection } from "@milkdown/prose/state";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import katex from "katex";
import "katex/dist/katex.min.css";
import { mathInlineSchema } from "@milkdown/plugin-math";
import { exitToNextLine } from "./block-exit";

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
          // 与表格 / 代码块一致：保存后光标跳到块后的下一行
          const curPos = getPos();
          if (typeof curPos === "number") {
            exitToNextLine(view, curPos, node.nodeSize);
          }
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

/*
 * mathInlineView — 接管 plugin-math 的行内公式（math_inline）编辑。
 *
 * 该版本 @milkdown/plugin-math 的 math_inline 是 atom + content:"text*"，
 * 仅由 schema.toDOM 渲染 KaTeX、无编辑 UI（无法点击进入编辑），故这里补一个
 * 与 mathBlockView 一致的「点击进入编辑」NodeView：
 *   - 默认显示 KaTeX 渲染结果（行内融入文本）；
 *   - 点击进入输入框（input，源码即 LaTeX 文本），Esc 取消 / Enter 提交；
 *   - 提交时把输入写回节点的文本内容（行内公式源码存于 text 而非 attrs）。
 */
export const mathInlineView = $view(mathInlineSchema.node, () => {
  const nodeView: NodeViewConstructor = (node, view, getPos) => {
    const dom = document.createElement("span");
    dom.className = "milkdown-math-inline";
    dom.dataset.type = "math_inline";
    dom.title = "行内公式：点击编辑，Enter 提交 / Esc 取消";

    const display = document.createElement("span");
    display.className = "milkdown-math-inline-display";

    const input = document.createElement("input");
    input.className = "milkdown-math-inline-input";
    input.type = "text";
    input.spellcheck = false;
    input.placeholder = "输入公式，如 a^2+b^2";
    input.style.display = "none";

    dom.append(display, input);

    let editing = false;

    // 输入窗口随内容自适应宽度（LaTeX 为等宽字体，按字符数估算），并保留
    // 一个舒适的最小宽度，避免空公式时编辑框过窄、难以输入。
    const fitWidth = () => {
      input.style.width = `${Math.max(input.value.length + 1, 12)}ch`;
    };

    const render = (value: string) => {
      display.replaceChildren();
      if (value && value.trim()) {
        try {
          katex.render(value, display, { throwOnError: false, trust: true });
        } catch {
          display.textContent = value;
        }
      } else {
        display.className = "milkdown-math-inline-display math-inline-empty";
        display.textContent = "点击输入公式";
      }
    };
    render(node.textContent);

    const setEditing = (on: boolean) => {
      editing = on;
      if (on) {
        input.value = node.textContent;
        fitWidth();
        display.style.display = "none";
        input.style.display = "";
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      } else {
        input.style.display = "none";
        display.style.display = "";
      }
    };

    const finish = (commit: boolean) => {
      if (!editing) return;
      const next = commit ? input.value : node.textContent;
      if (commit && next !== node.textContent) {
        const pos = getPos();
        if (typeof pos === "number") {
          editing = false;
          input.style.display = "none";
          display.style.display = "";
          const innerStart = pos + 1;
          const innerEnd = pos + node.nodeSize - 1;
          const tr = view.state.tr;
          if (next) {
            tr.replaceWith(innerStart, innerEnd, view.state.schema.text(next));
          } else {
            tr.delete(innerStart, innerEnd);
          }
          const mapped = tr.mapping.map(pos);
          tr.setSelection(
            TextSelection.create(tr.doc, mapped + 2 + (next ? next.length : 0)),
          );
          view.dispatch(tr);
          return; // update() 会触发重渲染
        }
      }
      setEditing(false);
      render(node.textContent);
    };

    const stop = (e: Event) => e.stopPropagation();
    input.addEventListener("mousedown", stop);
    input.addEventListener("touchstart", stop, { passive: true });
    input.addEventListener("dragstart", stop);
    // 粘贴 / 复制 / 剪切 / 拖放 / 右键菜单都不要冒泡到 PM，交给 input 自身处理
    input.addEventListener("paste", stop);
    input.addEventListener("copy", stop);
    input.addEventListener("cut", stop);
    input.addEventListener("drop", stop);
    input.addEventListener("contextmenu", stop);
    input.addEventListener("input", fitWidth);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
    });
    input.addEventListener("blur", () => finish(true));

    dom.addEventListener("mousedown", stop);
    dom.addEventListener("touchstart", stop, { passive: true });
    dom.addEventListener("dragstart", stop);
    dom.addEventListener("paste", stop);
    dom.addEventListener("copy", stop);
    dom.addEventListener("cut", stop);
    dom.addEventListener("drop", stop);
    dom.addEventListener("contextmenu", stop);
    dom.addEventListener("click", () => {
      if (!editing) setEditing(true);
    });

    return {
      dom,
      ignoreMutation: () => true,
      update: (updatedNode) => {
        if (updatedNode.type !== node.type) return false;
        node = updatedNode;
        if (!editing) render(node.textContent);
        return true;
      },
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
