import type { Node as ProseMirrorNode } from "@milkdown/prose/model";
import type { EditorState, Transaction } from "@milkdown/prose/state";
import { TextSelection } from "@milkdown/prose/state";

export interface TextblockTarget {
  /** Position immediately before the textblock node. */
  blockPos: number;
  /** First valid text position inside the textblock. */
  contentStart: number;
  contentSize: number;
  /** Caret offset relative to contentStart at the time the menu was opened. */
  caretOffset: number;
  /** A selection that was wholly inside this textblock when it was captured. */
  selection: { from: number; to: number } | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function targetAt(
  doc: ProseMirrorNode,
  blockPos: number,
  caretPosition: number
): TextblockTarget | null {
  const node = doc.nodeAt(blockPos);
  if (!node?.isTextblock) return null;

  const contentStart = blockPos + 1;
  const contentSize = node.content.size;
  return {
    blockPos,
    contentStart,
    contentSize,
    caretOffset: clamp(
      caretPosition - contentStart,
      0,
      contentSize
    ),
    selection: null,
  };
}

/**
 * Resolve the textblock at or immediately next to a document position.
 *
 * Positions at the start/end of a block are legal ProseMirror positions but
 * resolve to the parent. Handling them explicitly makes the first right-click
 * in an empty document deterministic.
 */
export function resolveTextblockTarget(
  doc: ProseMirrorNode,
  position: number
): TextblockTarget | null {
  const safePosition = clamp(position, 0, doc.content.size);
  const $position = doc.resolve(safePosition);
  let depth = $position.depth;
  while (depth > 0 && !$position.node(depth).isTextblock) depth -= 1;

  if (depth > 0) {
    return targetAt(doc, $position.before(depth), safePosition);
  }

  const after = $position.nodeAfter;
  if (after?.isTextblock) {
    return targetAt(doc, safePosition, safePosition);
  }

  const before = $position.nodeBefore;
  if (before?.isTextblock) {
    return targetAt(doc, safePosition - before.nodeSize, safePosition);
  }

  return null;
}

/**
 * Build a node-type-only transaction for a captured textblock.
 *
 * The menu must call this with the target captured during contextmenu. It
 * intentionally never consults the live selection or mouse coordinates: those
 * can change while the menu is open, especially during the first right-click
 * after the native window receives focus.
 */
export function createHeadingTransaction(
  state: EditorState,
  target: TextblockTarget,
  level: 1 | 2 | 3 | 4 | 5 | 6
): Transaction | null {
  const node = state.doc.nodeAt(target.blockPos);
  const heading = state.schema.nodes.heading;
  const paragraph = state.schema.nodes.paragraph;
  if (!node?.isTextblock || !heading) return null;

  const $block = state.doc.resolve(target.blockPos);
  if (
    !$block.parent.canReplaceWith(
      $block.index(),
      $block.index() + 1,
      heading
    )
  ) {
    return null;
  }

  let tr = state.tr.setNodeMarkup(target.blockPos, heading, { level });
  const converted = tr.doc.nodeAt(target.blockPos);
  if (!converted) return null;

  if (converted.content.size === 0) {
    const afterPos = target.blockPos + converted.nodeSize;
    if (afterPos === tr.doc.content.size && paragraph) {
      tr = tr.insert(afterPos, paragraph.create());
    }
    tr = tr.setSelection(
      TextSelection.create(tr.doc, target.contentStart)
    );
    return tr.scrollIntoView();
  }

  const selection = target.selection;
  if (
    selection &&
    selection.from >= target.contentStart &&
    selection.to <= target.contentStart + target.contentSize &&
    selection.from < selection.to
  ) {
    tr = tr.setSelection(
      TextSelection.create(tr.doc, selection.from, selection.to)
    );
  } else {
    const caret = clamp(
      target.contentStart + target.caretOffset,
      target.contentStart,
      target.contentStart + target.contentSize
    );
    tr = tr.setSelection(TextSelection.create(tr.doc, caret));
  }
  return tr.scrollIntoView();
}
