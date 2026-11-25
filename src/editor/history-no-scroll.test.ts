import { history } from "@milkdown/prose/history";
import { Schema } from "@milkdown/prose/model";
import {
  EditorState,
  TextSelection,
  type Transaction,
} from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it, vi } from "vitest";
import { createHistoryNoScrollPlugin } from "./history-no-scroll";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
});

describe("history without forced scrolling", () => {
  it("undoes and redoes without requesting a selection scroll", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("body")),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 5),
        plugins: [createHistoryNoScrollPlugin(), history()],
      }),
    });

    try {
      view.dispatch(view.state.tr.insertText("x", 5));
      const dispatch = vi.spyOn(view, "dispatch");

      const undoEvent = new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      view.dom.dispatchEvent(undoEvent);

      expect(undoEvent.defaultPrevented).toBe(true);
      expect(view.state.doc.textContent).toBe("body");
      const undoTx = dispatch.mock.calls.at(-1)?.[0] as Transaction;
      expect(undoTx.getMeta("scrollIntoView")).toBe(false);

      dispatch.mockClear();
      const redoEvent = new KeyboardEvent("keydown", {
        key: "y",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      view.dom.dispatchEvent(redoEvent);

      expect(redoEvent.defaultPrevented).toBe(true);
      expect(view.state.doc.textContent).toBe("bodyx");
      const redoTx = dispatch.mock.calls.at(-1)?.[0] as Transaction;
      expect(redoTx.getMeta("scrollIntoView")).toBe(false);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
