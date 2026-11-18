import { Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { describe, expect, it } from "vitest";
import {
  createTocInputTransaction,
  findSelectionAfterToc,
} from "./toc";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    toc: {
      group: "block",
      atom: true,
      selectable: true,
      toDOM: () => ["div", { "data-type": "toc" }],
    },
    text: { group: "inline" },
  },
});

describe("TOC input rule", () => {
  it("replaces the whole source paragraph without leaving a blank line above TOC", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("[toc]")),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 6),
    });
    const tr = createTocInputTransaction(state, 1)!;
    const next = state.applyTransaction(tr).state;

    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).type.name).toBe("toc");
    expect(next.doc.child(1).type.name).toBe("paragraph");
    expect(next.selection.from).toBe(2);
  });

  it("does not invent a paragraph when there is no editable block after TOC", () => {
    const toc = schema.nodes.toc.create();
    const doc = schema.node("doc", null, [toc]);
    const state = EditorState.create({ schema, doc });

    expect(findSelectionAfterToc(state, 0, toc.nodeSize)).toBeNull();
    expect(state.doc.childCount).toBe(1);
  });

  it("moves to the existing paragraph after TOC", () => {
    const toc = schema.nodes.toc.create();
    const doc = schema.node("doc", null, [toc, schema.node("paragraph")]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
    });
    const selection = findSelectionAfterToc(state, 0, toc.nodeSize);

    expect(selection).not.toBeNull();
    expect(selection!.$from.parent.type.name).toBe("paragraph");
  });
});
