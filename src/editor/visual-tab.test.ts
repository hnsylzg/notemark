import { Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { describe, expect, it } from "vitest";
import { applyVisualTab } from "./visual-tab";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    bullet_list: {
      group: "block",
      content: "list_item+",
      toDOM: () => ["ul", 0],
    },
    list_item: {
      content: "paragraph block*",
      toDOM: () => ["li", 0],
    },
    text: { group: "inline" },
  },
});

describe("visual editor Tab", () => {
  it("inserts a tab in an ordinary paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("alpha")),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 3),
    });
    let next = state;

    expect(
      applyVisualTab(state, (tr) => {
        next = state.apply(tr);
      }, false)
    ).toBe(true);
    expect(next.doc.textContent).toBe("al\u200B\tpha");
  });

  it("indents every selected paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("alpha")),
      schema.node("paragraph", null, schema.text("beta")),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, doc.content.size - 1),
    });
    let next = state;

    applyVisualTab(state, (tr) => {
      next = state.apply(tr);
    }, false);

    expect(next.doc.textContent).toBe(
      "\u200B\talpha\u200B\tbeta"
    );
  });

  it("outdents tabs and four-space indentation", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("\u200B\talpha")),
      schema.node("paragraph", null, schema.text("    beta")),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, doc.content.size - 1),
    });
    let next = state;

    applyVisualTab(state, (tr) => {
      next = state.apply(tr);
    }, true);

    expect(next.doc.textContent).toBe("alphabeta");
  });

  it("leaves list indentation to the list keymap", () => {
    const doc = schema.node("doc", null, [
      schema.node("bullet_list", null, [
        schema.node("list_item", null, [
          schema.node("paragraph", null, schema.text("item")),
        ]),
      ]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 4),
    });

    expect(applyVisualTab(state, undefined, false)).toBe(false);
  });
});
