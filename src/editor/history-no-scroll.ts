import {
  redoNoScroll,
  undoNoScroll,
} from "@milkdown/prose/history";
import {
  Plugin,
  type Command,
  type Transaction,
} from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";

function runWithoutScroll(
  view: EditorView,
  event: KeyboardEvent,
  command: Command
): boolean {
  let transaction: Transaction | null = null;
  if (!command(view.state, (tr) => (transaction = tr))) {
    return false;
  }
  const tr = transaction as Transaction | null;
  if (!tr) return false;
  event.preventDefault();
  view.dispatch(tr.setMeta("scrollIntoView", false));
  return true;
}

export function createHistoryNoScrollPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        const mod = event.ctrlKey || event.metaKey;
        if (!mod || event.altKey) return false;
        const key = event.key.toLowerCase();
        if (key === "y" || (key === "z" && event.shiftKey)) {
          return runWithoutScroll(view, event, redoNoScroll);
        }
        if (key === "z") {
          return runWithoutScroll(view, event, undoNoScroll);
        }
        return false;
      },
    },
  });
}

export const historyNoScrollPlugin = $prose(
  createHistoryNoScrollPlugin
);
