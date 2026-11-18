import { Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { describe, expect, it } from "vitest";
import { exitQuoteContainerAtStart } from "./blockquote-backspace";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    blockquote: {
      group: "block",
      content: "block+",
      toDOM: () => ["blockquote", 0],
    },
    alert: {
      group: "block",
      content: "block+",
      defining: true,
      attrs: {
        alertType: { default: "note" },
        title: { default: "" },
      },
      toDOM: () => ["blockquote", { "data-alert": "note" }, 0],
    },
    text: { group: "inline" },
  },
});

function stateAtQuoteStart(prefix: boolean): EditorState {
  const quote = schema.node("blockquote", null, [
    schema.node("paragraph", null, schema.text("quote")),
  ]);
  const doc = schema.node(
    "doc",
    null,
    prefix
      ? [schema.node("paragraph", null, schema.text("before")), quote]
      : [quote]
  );
  const quoteStart = prefix ? doc.firstChild!.nodeSize : 0;
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, quoteStart + 2),
  });
}

describe("blockquote Backspace", () => {
  it("lifts the first quote block and keeps the caret at its text start", () => {
    const state = stateAtQuoteStart(true);
    let next: EditorState | undefined;
    const handled = exitQuoteContainerAtStart(state, (tr) => {
      next = state.apply(tr);
    });

    expect(handled).toBe(true);
    expect(next).toBeDefined();
    expect(next!.doc.child(1).type.name).toBe("paragraph");
    expect(next!.doc.child(1).textContent).toBe("quote");
    expect(next!.selection.empty).toBe(true);
    expect(next!.selection.$from.parent.textContent).toBe("quote");
    expect(next!.selection.$from.parentOffset).toBe(0);
  });

  it("does not move the caret out of a later quote paragraph", () => {
    const quote = schema.node("blockquote", null, [
      schema.node("paragraph", null, schema.text("first")),
      schema.node("paragraph", null, schema.text("second")),
    ]);
    const doc = schema.node("doc", null, [quote]);
    const firstSize = quote.firstChild!.nodeSize;
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1 + firstSize + 1),
    });

    expect(exitQuoteContainerAtStart(state, () => {})).toBe(false);
  });

  it("lifts alert body text and keeps the caret at its start", () => {
    const alert = schema.node(
      "alert",
      { alertType: "note", title: "提示" },
      schema.node("paragraph", null, schema.text("alert body"))
    );
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("before")),
      alert,
    ]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, doc.firstChild!.nodeSize + 2),
    });
    let next: EditorState | undefined;

    const handled = exitQuoteContainerAtStart(state, (tr) => {
      next = state.apply(tr);
    });

    expect(handled).toBe(true);
    expect(next!.doc.childCount).toBe(3);
    expect(next!.doc.child(1).textContent).toBe("提示");
    expect(next!.doc.child(2).type.name).toBe("paragraph");
    expect(next!.doc.child(2).textContent).toBe("alert body");
    expect(next!.selection.$from.parent.textContent).toBe("alert body");
    expect(next!.selection.$from.parentOffset).toBe(0);
  });

  it("removes a multi-paragraph alert as one unit without splitting it", () => {
    const alert = schema.node(
      "alert",
      { alertType: "warning", title: "" },
      [
        schema.node("paragraph", null, schema.text("first")),
        schema.node("paragraph", null, schema.text("second")),
      ]
    );
    const doc = schema.node("doc", null, [alert]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2),
    });
    let next: EditorState | undefined;

    const handled = exitQuoteContainerAtStart(state, (tr) => {
      next = state.apply(tr);
    });

    expect(handled).toBe(true);
    expect(next!.doc.childCount).toBe(2);
    expect(next!.doc.child(0).textContent).toBe("first");
    expect(next!.doc.child(1).textContent).toBe("second");
    expect(next!.selection.$from.parent.textContent).toBe("first");
    expect(next!.selection.$from.parentOffset).toBe(0);
  });
});
