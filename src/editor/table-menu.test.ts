import { Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import {
  CellSelection,
  TableMap,
  tableEditing,
  tableNodes,
} from "@milkdown/prose/tables";
import { EditorView } from "@milkdown/prose/view";
import { getAllCellsInTable } from "@milkdown/kit/preset/gfm";
import { describe, expect, it } from "vitest";
import {
  createTableSelectAllPlugin,
  selectCurrentTable,
  setColumnAlignment,
} from "./table-commands";

const cellAttrs = {
  alignment: { default: "left" },
};

const tableSpecs = tableNodes({
  tableGroup: "block",
  cellContent: "paragraph",
  cellAttributes: cellAttrs,
});

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    ...tableSpecs,
  },
});

function cell(type: "table_header" | "table_cell", text: string) {
  return schema.node(
    type,
    { alignment: "left" },
    schema.node("paragraph", null, schema.text(text))
  );
}

describe("table column alignment", () => {
  it("updates the header and body cells when invoked from a body cell", () => {
    const table = schema.node("table", null, [
      schema.node("table_row", null, [
        cell("table_header", "A"),
        cell("table_header", "B"),
      ]),
      schema.node("table_row", null, [
        cell("table_cell", "A1"),
        cell("table_cell", "B1"),
      ]),
    ]);
    const doc = schema.node("doc", null, [table]);
    const map = TableMap.get(table);
    const bodyCellOffset = map.map[map.width + 1];
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, bodyCellOffset + 3),
    });

    let next: EditorState | undefined;
    const changed = setColumnAlignment("center")(
      state,
      (transaction) => {
        next = state.apply(transaction);
      }
    );

    expect(changed).toBe(true);
    expect(next).toBeDefined();
    const nextTable = next!.doc.firstChild!;
    expect(nextTable.child(0).child(0).attrs.alignment).toBe("left");
    expect(nextTable.child(0).child(1).attrs.alignment).toBe("center");
    expect(nextTable.child(1).child(0).attrs.alignment).toBe("left");
    expect(nextTable.child(1).child(1).attrs.alignment).toBe("center");
  });
});

describe("table selection", () => {
  it("selects every cell when Ctrl+A is dispatched to the editor", () => {
    const table = schema.node("table", null, [
      schema.node("table_row", null, [
        cell("table_header", "A"),
        cell("table_header", "B"),
      ]),
      schema.node("table_row", null, [
        cell("table_cell", "A1"),
        cell("table_cell", "B1"),
      ]),
    ]);
    const doc = schema.node("doc", null, [table]);
    const map = TableMap.get(table);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, map.map[map.width + 1] + 3),
        plugins: [
          tableEditing({ allowTableNodeSelection: true }),
          createTableSelectAllPlugin(),
        ],
      }),
    });

    try {
      const event = new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      view.dom.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(view.state.selection).toBeInstanceOf(CellSelection);
      const selection = view.state.selection as CellSelection;
      expect(selection.isRowSelection()).toBe(true);
      expect(selection.isColSelection()).toBe(true);
      const selectedCells: string[] = [];
      selection.forEachCell((node) => selectedCells.push(node.textContent));
      expect(selectedCells).toEqual(["A", "B", "A1", "B1"]);
      const highlightedText = Array.from(
        view.dom.querySelectorAll(".mt-table-selected-text")
      ).map((element) => element.textContent);
      expect(highlightedText).toEqual(["A", "B", "A1", "B1"]);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("selects every cell on the first select-all command", () => {
    const table = schema.node("table", null, [
      schema.node("table_row", null, [
        cell("table_header", "A"),
        cell("table_header", "B"),
      ]),
      schema.node("table_row", null, [
        cell("table_cell", "A1"),
        cell("table_cell", "B1"),
      ]),
    ]);
    const doc = schema.node("doc", null, [table]);
    const map = TableMap.get(table);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, map.map[map.width + 1] + 3),
    });

    let next: EditorState | undefined;
    const selected = selectCurrentTable(state, (transaction) => {
      next = state.apply(transaction);
    });

    expect(selected).toBe(true);
    expect(next?.selection).toBeInstanceOf(CellSelection);
    const selection = next!.selection as CellSelection;
    expect(selection.isRowSelection()).toBe(true);
    expect(selection.isColSelection()).toBe(true);
  });

  it("leaves the second select-all command to document selection", () => {
    const table = schema.node("table", null, [
      schema.node("table_row", null, [
        cell("table_header", "A"),
        cell("table_header", "B"),
      ]),
    ]);
    const doc = schema.node("doc", null, [table]);
    const map = TableMap.get(table);
    const seed = TextSelection.create(doc, map.map[0] + 3);
    const cells = getAllCellsInTable(seed)!;

    const state = EditorState.create({
      doc,
      selection: CellSelection.create(
        doc,
        cells[0].pos,
        cells[cells.length - 1].pos
      ),
    });

    expect(selectCurrentTable(state)).toBe(false);
  });
});
