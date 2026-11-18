/*
 * blockquote-backspace.ts — 引用块 / 提示块第一段开头按一次 Backspace 时退出容器。
 *
 * ProseMirror 默认 Backspace 已经能正确把当前段落 lift 出 blockquote，
 * 事务中的 TextSelection 也仍在新段落开头；但引用 DOM 被替换后，浏览器原生
 * Range 没有立即重建，视觉光标会短暂（甚至持续）停在上一段末尾。
 *
 * 因此这里在结构事务派发前清除旧 DOM Range，事务完成后再 focus 编辑器，
 * 强制 ProseMirror 按新状态重建光标。默认行为仍由标准 lift 命令完成。
 */
import { lift } from "@milkdown/prose/commands";
import { TextSelection, type Command, type EditorState } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";

const QUOTE_CONTAINERS = new Set(["blockquote", "alert"]);

/** 光标在引用/提示容器第一段（或第一个标题）文字开头时，返回容器深度。 */
function firstQuoteContainerDepth(state: EditorState): number | null {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $from = selection.$from;
  if ($from.parentOffset !== 0 || !$from.parent.isTextblock) return null;

  for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
    if (!QUOTE_CONTAINERS.has($from.node(depth).type.name)) continue;
    return depth === $from.depth - 1 && $from.index(depth) === 0 ? depth : null;
  }
  return null;
}

/**
 * 普通 blockquote 使用标准 lift；alert 则整体拆成普通段落。
 *
 * alert 的 `[!NOTE]` 和自定义标题不是正文节点；如果直接 lift 第一段，
 * 单段提示块会连标题一起消失，多段提示块却只拆第一段。这里统一为：
 * 整块退出、所有正文保留，自定义标题转成普通首段，光标落回原正文开头。
 */
export const exitQuoteContainerAtStart: Command = (state, dispatch) => {
  const depth = firstQuoteContainerDepth(state);
  if (depth == null) return false;
  const container = state.selection.$from.node(depth);
  if (container.type.name === "blockquote") return lift(state, dispatch);
  if (container.type.name !== "alert") return false;

  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) return false;
  const title = String(container.attrs.title ?? "").trim();
  const titleParagraph = title
    ? paragraphType.create(null, state.schema.text(title))
    : null;
  const replacement = [
    ...(titleParagraph ? [titleParagraph] : []),
    ...Array.from({ length: container.childCount }, (_, index) =>
      container.child(index)
    ),
  ];
  if (replacement.length === 0) return false;

  const start = state.selection.$from.before(depth);
  const firstBody = container.firstChild;
  if (!firstBody) return false;
  const firstBodyStart =
    start + (titleParagraph?.nodeSize ?? 0) + 1;

  if (dispatch) {
    const tr = state.tr.replaceWith(start, start + container.nodeSize, replacement);
    tr.setSelection(TextSelection.create(tr.doc, firstBodyStart));
    dispatch(tr);
  }
  return true;
};

export const blockquoteBackspacePlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (event.key !== "Backspace" || event.ctrlKey || event.metaKey || event.altKey) {
            return false;
          }

          let transaction: Parameters<typeof view.dispatch>[0] | undefined;
          const handled = exitQuoteContainerAtStart(view.state, (tr) => {
            transaction = tr;
          });
          if (!handled || !transaction) return false;

          // 拆引用会替换当前 DOM 节点；先丢掉可能指向旧 blockquote 的原生 Range。
          view.dom.ownerDocument.getSelection()?.removeAllRanges();
          view.dispatch(transaction.scrollIntoView());
          requestAnimationFrame(() => {
            if (!view.isDestroyed) view.focus();
          });
          return true;
        },
      },
    })
);
