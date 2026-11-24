import { $prose } from "@milkdown/utils";
import {
  Plugin,
  type EditorState,
  type Transaction,
} from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

// Typora's visual mode prefixes paragraph indentation with U+200B so a leading
// tab is not parsed as an indented Markdown code block on the next load.
const VISUAL_TAB = "\u200B\t";
const VISUAL_OUTDENT_SPACES = 4;

interface TextblockRange {
  from: number;
  text: string;
}

function textblockAtSelection(state: EditorState): TextblockRange | null {
  const { selection } = state;
  const blocks: TextblockRange[] = [];
  state.doc.nodesBetween(
    selection.from,
    selection.to,
    (node, pos) => {
      if (!node.isTextblock) return true;
      blocks.push({ from: pos + 1, text: node.textContent });
      return false;
    }
  );
  if (blocks.length > 0) return blocks[0];

  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (!$from.node(depth).isTextblock) continue;
    return {
      from: $from.start(depth),
      text: $from.node(depth).textContent,
    };
  }
  return null;
}

function selectedTextblocks(state: EditorState): TextblockRange[] {
  const { selection } = state;
  if (selection.empty) {
    const block = textblockAtSelection(state);
    return block ? [block] : [];
  }
  const blocks: TextblockRange[] = [];
  state.doc.nodesBetween(
    selection.from,
    selection.to,
    (node, pos) => {
      if (!node.isTextblock) return true;
      blocks.push({ from: pos + 1, text: node.textContent });
      return false;
    }
  );
  return blocks;
}

function leadingIndentWidth(text: string): number {
  if (text.startsWith(VISUAL_TAB)) return VISUAL_TAB.length;
  let spaces = 0;
  while (
    spaces < VISUAL_OUTDENT_SPACES &&
    text[spaces] === " "
  ) {
    spaces += 1;
  }
  return spaces;
}

/**
 * Typora-style visual-editor indentation for ordinary textblocks.
 * List items and tables are handled by their structural keymaps first.
 */
export function applyVisualTab(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  outdent: boolean
): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === "list_item" || name === "table") return false;
  }

  const blocks = selectedTextblocks(state);
  if (blocks.length === 0) return false;
  if (dispatch) {
    let tr = state.tr;
    if (!outdent && state.selection.empty) {
      tr = tr.insertText(VISUAL_TAB, state.selection.from);
    } else {
      for (const block of [...blocks].reverse()) {
        if (outdent) {
          const width = leadingIndentWidth(block.text);
          if (width > 0) {
            tr = tr.delete(block.from, block.from + width);
          }
        } else {
          tr = tr.insertText(VISUAL_TAB, block.from);
        }
      }
    }
    if (tr.docChanged) dispatch(tr.scrollIntoView());
  }
  return true;
}

export const visualTabPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view: EditorView, event: KeyboardEvent) {
          if (
            event.key !== "Tab" ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey
          ) {
            return false;
          }
          return applyVisualTab(
            view.state,
            view.dispatch.bind(view),
            event.shiftKey
          );
        },
      },
    })
);
