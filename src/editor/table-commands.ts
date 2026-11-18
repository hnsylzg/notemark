import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "@milkdown/prose/state";
import { CellSelection, isInTable, selectedRect } from "@milkdown/prose/tables";
import { selectTable } from "@milkdown/kit/preset/gfm";
import { $prose } from "@milkdown/utils";
import { Decoration, DecorationSet } from "@milkdown/prose/view";

type Cmd = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void
) => boolean;

/**
 * 表格内第一次 Ctrl/Cmd+A 选中整张表格；已经整表选中时返回 false，
 * 让默认 keymap 的下一次 Ctrl/Cmd+A 选中整篇文档。
 */
export const selectCurrentTable: Cmd = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const selection = state.selection;
  if (
    selection instanceof CellSelection &&
    selection.isRowSelection() &&
    selection.isColSelection()
  ) {
    return false;
  }
  dispatch?.(selectTable(state.tr));
  return true;
};

export function createTableSelectAllPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("notemark-table-select-all"),
    props: {
      decorations(state) {
        const selection = state.selection;
        if (!(selection instanceof CellSelection)) return null;

        const decorations: Decoration[] = [];
        selection.forEachCell((cell, pos) => {
          cell.descendants((node, offset) => {
            if (!node.isTextblock || node.content.size === 0) return false;
            const from = pos + offset + 2;
            const to = pos + offset + node.nodeSize;
            if (from < to) {
              decorations.push(
                Decoration.inline(from, to, {
                  class: "mt-table-selected-text",
                })
              );
            }
            return false;
          });
        });
        return DecorationSet.create(state.doc, decorations);
      },
      handleKeyDown(view, event) {
        if (
          event.key.toLowerCase() !== "a" ||
          event.altKey ||
          !(event.ctrlKey || event.metaKey)
        ) {
          return false;
        }
        return selectCurrentTable(view.state, (tr) => view.dispatch(tr));
      },
    },
  });
}

export const tableSelectAllPlugin = $prose(createTableSelectAllPlugin);

/** 修改当前列的对齐，并同步 GFM 表头与所有正文单元格。 */
export function setColumnAlignment(
  alignment: "left" | "center" | "right"
): Cmd {
  return (state, dispatch) => {
    const rect = selectedRect(state);
    const positions = new Set<number>();
    for (let row = 0; row < rect.map.height; row += 1) {
      for (let col = rect.left; col < rect.right; col += 1) {
        const offset = rect.map.map[row * rect.map.width + col];
        if (offset != null) positions.add(offset);
      }
    }

    const tr = state.tr;
    let changed = false;
    for (const offset of positions) {
      const cell = rect.table.nodeAt(offset);
      if (!cell || cell.attrs.alignment === alignment) continue;
      tr.setNodeMarkup(rect.tableStart + offset, undefined, {
        ...cell.attrs,
        alignment,
      });
      changed = true;
    }
    if (!changed) return false;
    dispatch?.(tr);
    return true;
  };
}
