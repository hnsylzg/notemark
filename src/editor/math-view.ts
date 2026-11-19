/*
 * math-view.ts — 行内与块级公式 NodeView。
 *
 * MathJax 4.1.0 是唯一公式引擎：schema 只保存 TeX 数据，NodeView 异步生成
 * MathJax SVG；复制和 Word 导出也复用同一个 MathJax TeX 输入树。
 * NodeView 内部固定一个 content 子容器，避免重渲染时重复追加。
 */
import { $node, $view, $inputRule, $prose } from "@milkdown/utils";
import { InputRule } from "@milkdown/prose/inputrules";
import {
  NodeSelection,
  Plugin,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/prose/state";
import type { EditorView, NodeViewConstructor } from "@milkdown/prose/view";
import { mathInlineSchema } from "./math-schema";
import { renderMathJaxSvg } from "./mathjax";
import { deleteEmptyEditableBlock, exitToNextLine } from "./block-exit";

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
  // toDOM 只输出数据容器，显示由 MathJax NodeView 接管。
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

    let renderVersion = 0;
    const renderFormula = async (value: string) => {
      const version = ++renderVersion;
      dom.dataset.value = value;
      content.className = "milkdown-math-content milkdown-mathjax";
      content.replaceChildren();
      if (value && value.trim()) {
        try {
          const container = await renderMathJaxSvg(value, true);
          if (version !== renderVersion || editing) return;
          content.replaceChildren(container);
        } catch {
          if (version === renderVersion && !editing) content.textContent = value;
        }
      } else {
        content.className = "milkdown-math-content math-empty";
        content.textContent = "空公式（点击输入）";
      }
    };

    const startEdit = () => {
      if (editing) return;
      editing = true;
      renderVersion += 1;
      dom.classList.add("is-editing");
      const textarea = document.createElement("textarea");
      textarea.className = "math-block-editor";
      textarea.value = (node.attrs.value as string) ?? "";
      textarea.spellcheck = false;
      textarea.rows = 1;
      const source = document.createElement("div");
      source.className = "mt-block-source mt-block-source--math";
      const open = document.createElement("span");
      open.className = "mt-block-source-marker";
      open.textContent = "$$";
      open.setAttribute("aria-hidden", "true");
      const close = open.cloneNode(true) as HTMLSpanElement;
      source.append(open, textarea, close);
      content.replaceChildren(source);

      textarea.focus();
      const len = textarea.value.length;
      textarea.setSelectionRange(len, len);

      const finish = (commit: boolean, focusEditor = false): boolean => {
        if (!editing) return false;
        editing = false;
        dom.classList.remove("is-editing");
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
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                value: next,
              }),
            );
            if (focusEditor) view.focus();
            return false;
          }
        }
        void renderFormula(next);
        if (focusEditor) view.focus();
        return false;
      };

      textarea.addEventListener("mousedown", (e) => e.stopPropagation());
      textarea.addEventListener("keydown", (e) => {
        e.stopPropagation();
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

    dom.addEventListener("mousedown", (e) => e.stopPropagation());
    dom.addEventListener("click", startEdit);
    dom.addEventListener("dblclick", startEdit);
    void renderFormula((node.attrs.value as string) ?? "");

    return {
      dom,
      contentDOM: undefined,
      update: (updatedNode) => {
        if (updatedNode.type !== node.type) return false;
        if (updatedNode.attrs.value !== node.attrs.value) {
          node = updatedNode;
          if (!editing) void renderFormula(node.attrs.value as string);
        }
        return true;
      },
      ignoreMutation: () => true,
      destroy: () => {
        renderVersion += 1;
      },
    };
  };
  return nodeView;
});

/*
 * mathInlineView — 接管 plugin-math 的行内公式（math_inline）编辑。
 *
 * math_inline 是 atom + content:"text*"；schema 只负责保存 TeX 源码，
 * 这里补一个与 mathBlockView 一致的「点击进入编辑」NodeView：
 *   - 默认显示 MathJax SVG（行内融入文本）；
 *   - 点击进入输入框（input，源码即 LaTeX 文本），Esc 取消 / Enter 提交；
 *   - 提交时把输入写回节点的文本内容（行内公式源码存于 text 而非 attrs）。
 */
export const createMathInlineNodeView: NodeViewConstructor = (
  node,
  view,
  getPos
) => {
    const dom = document.createElement("span");
    dom.className = "milkdown-math-inline";
    dom.dataset.type = "math_inline";
    dom.title = "行内公式";

    const display = document.createElement("span");
    display.className = "milkdown-math-inline-display";

    const input = document.createElement("input");
    input.className = "milkdown-math-inline-input";
    input.type = "text";
    input.spellcheck = false;
    input.removeAttribute("placeholder");
    input.style.display = "none";

    dom.append(display, input);

    let editing = false;

    type VerticalTarget = {
      position: number;
      bias: -1 | 1;
    };

    let renderVersion = 0;
    const render = async (value: string) => {
      const version = ++renderVersion;
      dom.dataset.value = value;
      display.className = "milkdown-math-inline-display milkdown-mathjax";
      display.replaceChildren();
      if (value && value.trim()) {
        try {
          const container = await renderMathJaxSvg(value, false);
          if (version !== renderVersion || editing) return;
          display.replaceChildren(container);
        } catch {
          if (version === renderVersion && !editing) display.textContent = value;
        }
      } else {
        display.classList.add("math-inline-empty");
        display.textContent = "";
      }
    };
    void render(node.textContent);

    const setEditing = (
      on: boolean,
      selectAll = false,
      keyboardEntry = false,
      fromLeft = true
    ) => {
      editing = on;
      if (on) renderVersion += 1;
      dom.classList.toggle("is-editing", on);
      if (on) {
        input.value = `$${node.textContent}$`;
        display.style.display = "none";
        input.style.display = "";
        input.focus();
        const start = selectAll
          ? 0
          : keyboardEntry
            ? fromLeft
              ? 0
              : input.value.length
            : 1;
        const end = selectAll
          ? input.value.length
          : keyboardEntry
            ? start
            : Math.max(1, input.value.length - 1);
        input.setSelectionRange(start, end);
      } else {
        input.style.display = "none";
        display.style.display = "";
      }
    };

    const finish = (
      commit: boolean,
      focusPosition: false | "before" | "after" = false
    ): Transaction | null => {
      if (!editing) return null;
      const source = commit ? input.value : `$${node.textContent}$`;
      const match = /^\$([\s\S]*)\$$/.exec(source);
      const next = match ? match[1] : source;
      const pos = getPos();
      editing = false;
      setEditing(false);
      if (typeof pos !== "number") {
        render(node.textContent);
        return null;
      }

      let finalBefore = pos;
      let finalAfter = pos + node.nodeSize;
      let tr: Transaction | null = null;
      if (
        commit &&
        (!next || !match || next !== node.textContent)
      ) {
        tr = view.state.tr;
        if (next) {
          if (match) {
            const innerStart = pos + 1;
            const innerEnd = pos + node.nodeSize - 1;
            tr.replaceWith(innerStart, innerEnd, view.state.schema.text(next));
            finalAfter = tr.mapping.map(pos) + 2 + next.length;
          } else {
            tr.replaceWith(
              pos,
              pos + node.nodeSize,
              view.state.schema.text(next)
            );
            finalAfter = tr.mapping.map(pos) + next.length;
          }
        } else {
          tr.delete(pos, pos + node.nodeSize);
          finalBefore = finalAfter = tr.mapping.map(pos);
        }
        finalBefore = tr.mapping.map(pos);
      }

      if (focusPosition) {
        const target =
          focusPosition === "before" ? finalBefore : finalAfter;
        tr = (tr ?? view.state.tr).setSelection(
          TextSelection.near(
            (tr?.doc ?? view.state.doc).resolve(
              Math.max(0, Math.min(target, tr?.doc.content.size ?? view.state.doc.content.size))
            )
          )
        );
      }

      if (tr) {
        view.dispatch(tr);
      } else {
        render(node.textContent);
      }
      if (focusPosition) view.focus();
      return tr;
    };

    const verticalTargetAt = (
      direction: -1 | 1
    ): VerticalTarget | undefined => {
      const rect = dom.getBoundingClientRect();
      const style = dom.ownerDocument.defaultView?.getComputedStyle(dom);
      const parsedLineHeight = style
        ? Number.parseFloat(style.lineHeight)
        : Number.NaN;
      const lineHeight =
        Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
          ? parsedLineHeight
          : rect.height;
      const verticalOffset = lineHeight > 0 ? lineHeight / 2 : 0;
      const valueLength = input.value.length;
      const caretRatio =
        valueLength > 0
          ? Math.max(
              0,
              Math.min(1, (input.selectionStart ?? valueLength) / valueLength)
            )
          : 0.5;
      const hit = view.posAtCoords({
        left: rect.left + rect.width * caretRatio,
        top:
          direction < 0
            ? rect.top - verticalOffset
            : rect.bottom + verticalOffset,
      });
      if (!hit) return undefined;
      return { position: hit.pos, bias: direction };
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
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false, "after");
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish(true, "after");
      } else if (
        e.key === "ArrowLeft" &&
        input.selectionStart === 0 &&
        input.selectionEnd === 0
      ) {
        e.preventDefault();
        finish(true, "before");
      } else if (
        e.key === "ArrowRight" &&
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length
      ) {
        e.preventDefault();
        finish(true, "after");
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const direction = e.key === "ArrowUp" ? -1 : 1;
        const target = verticalTargetAt(direction);
        const tr = finish(
          true,
          target ? false : direction < 0 ? "before" : "after"
        );
        if (target) {
          const mapped = Math.max(
            0,
            Math.min(
              tr?.mapping.map(target.position, target.bias) ??
                target.position,
              view.state.doc.content.size
            )
          );
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.near(
                view.state.doc.resolve(mapped),
                target.bias
              )
            )
          );
          view.focus();
        }
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
    dom.addEventListener("mt-inline-math-edit", (event) => {
      const selectAll =
        event instanceof CustomEvent && event.detail?.selectAll === true;
      const keyboardEntry =
        event instanceof CustomEvent && event.detail?.keyboardEntry === true;
      const fromLeft =
        event instanceof CustomEvent && event.detail?.fromLeft !== false;
      setEditing(true, selectAll, keyboardEntry, fromLeft);
    });
    dom.addEventListener("click", () => {
      if (!editing) setEditing(true);
    });

    return {
      dom,
      ignoreMutation: () => true,
      update: (updatedNode) => {
        if (updatedNode.type !== node.type) return false;
        node = updatedNode;
        if (!editing) void render(node.textContent);
        return true;
      },
      destroy: () => {
        renderVersion += 1;
      },
    };
};

function selectedInlineMathRange(
  state: EditorState
): { from: number; to: number } | null {
  const selection = state.selection;
  if (
    selection instanceof NodeSelection &&
    selection.node.type.name === "math_inline"
  ) {
    return { from: selection.from, to: selection.to };
  }
  if (!selection.empty) return null;
  const $pos = state.doc.resolve(selection.from);
  if ($pos.nodeAfter?.type.name === "math_inline") {
    return {
      from: $pos.pos,
      to: $pos.pos + $pos.nodeAfter.nodeSize,
    };
  }
  if ($pos.nodeBefore?.type.name === "math_inline") {
    return {
      from: $pos.pos - $pos.nodeBefore.nodeSize,
      to: $pos.pos,
    };
  }
  return null;
}

/**
 * Keyboard navigation is handled by ProseMirror outside the NodeView. When a
 * keyboard selection enters math_inline, forward that state to the existing
 * input editor without changing the document.
 */
export function createMathInlineCursorPlugin(): Plugin {
  let pendingEntry:
    | { from: number; to: number; fromLeft: boolean }
    | null = null;
  return new Plugin({
    appendTransaction(transactions, oldState, newState) {
      const selectionMoved = transactions.some(
        (tr) =>
          tr.selectionSet &&
          !tr.docChanged &&
          !tr.getMeta("pointer")
      );
      if (!selectionMoved) return null;
      const range = selectedInlineMathRange(newState);
      if (!range) return null;
      pendingEntry = {
        ...range,
        fromLeft: oldState.selection.from <= range.from,
      };
      return null;
    },
    view(view) {
      return {
        update() {
          const entry = pendingEntry;
          pendingEntry = null;
          if (!entry) return;
          const dom = view.nodeDOM(entry.from);
          if (!(dom instanceof HTMLElement)) return;
          dom.dispatchEvent(
            new CustomEvent("mt-inline-math-edit", {
              detail: {
                selectAll: false,
                keyboardEntry: true,
                fromLeft: entry.fromLeft,
              },
            })
          );
        },
      };
    },
  });
}

export const mathInlineCursorPlugin = $prose(
  createMathInlineCursorPlugin
);

export const mathInlineView = $view(
  mathInlineSchema.node,
  () => createMathInlineNodeView
);

/**
 * 在光标处插入一个空行内公式（math_inline），插完立即进入编辑。
 *
 * 入口在右键菜单（format-menu.ts）——行内公式要落在正文光标处，而斜杠菜单
 * 只在段落开头触发，句末想插公式根本弹不出菜单，所以不放斜杠菜单。
 *
 * 插完自动进编辑，与「元数据 / HTML 块」的处理一致：空公式只是个
 * "点击输入公式"的占位，不自动进编辑就得让用户再点一下。
 * 拿不到节点 DOM（视图刚更新、位置已失效）时静默跳过，手动点一下同样能编辑。
 */
export function createInlineMathTransaction(
  state: EditorState
): { tr: Transaction; nodePos: number; selected: boolean } | null {
  const type = state.schema.nodes["math_inline"];
  if (!type) {
    console.warn("[math-view] schema 中找不到 math_inline 节点");
    return null;
  }

  const { selection } = state;
  if (!selection.empty) {
    const { $from, $to } = selection;
    if (!$from.sameParent($to) || !$from.parent.inlineContent) return null;
    const source = state.doc.textBetween(selection.from, selection.to, "\n");
    const node = type.create(
      null,
      source ? state.schema.text(source) : undefined
    );
    const tr = state.tr.replaceWith(selection.from, selection.to, node);
    tr.setSelection(
      TextSelection.create(tr.doc, selection.from + node.nodeSize)
    ).scrollIntoView();
    return { tr, nodePos: selection.from, selected: true };
  }

  const at = selection.from;
  const $at = state.doc.resolve(at);
  if (!$at.parent.canReplaceWith($at.index(), $at.index(), type)) return null;
  const node = type.create(null);
  const tr = state.tr.insert(at, node);
  tr.setSelection(TextSelection.create(tr.doc, at + node.nodeSize))
    .scrollIntoView();
  return { tr, nodePos: at, selected: false };
}

export function insertInlineMath(view: EditorView): boolean {
  const insertion = createInlineMathTransaction(view.state);
  if (!insertion) return false;
  view.dispatch(insertion.tr);
  view.focus();

  requestAnimationFrame(() => {
    try {
      const dom = view.nodeDOM(insertion.nodePos) as HTMLElement | null;
      dom?.dispatchEvent(
        new CustomEvent("mt-inline-math-edit", {
          detail: { selectAll: insertion.selected },
        })
      );
    } catch {
      /* 视图已销毁或位置失效：手动点击公式仍可编辑 */
    }
  });
  return true;
}

export const mathBlockPlugins = [
  mathBlockSchema,
  mathBlockInputRule,
  mathBlockView,
];
