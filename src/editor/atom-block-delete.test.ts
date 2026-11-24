import { Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { describe, expect, it } from "vitest";
import { deleteAdjacentAtomBlock } from "./atom-block-delete";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    code_block: {
      group: "block",
      content: "text*",
      toDOM: () => ["pre", 0],
    },
    hr: {
      group: "block",
      atom: true,
      toDOM: () => ["hr"],
    },
    text: { group: "inline" },
  },
});

describe("atomic block Delete behavior", () => {
  it("removes an empty paragraph without deleting the following horizontal rule", () => {
    const doc = schema.node("doc", null, [
      schema.node("code_block", null, schema.text("code")),
      schema.node("paragraph"),
      schema.node("hr"),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 7),
    });
    let next = state;

    expect(
      deleteAdjacentAtomBlock("forward")(state, (tr) => {
        next = state.apply(tr);
      })
    ).toBe(true);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).type.name).toBe("code_block");
    expect(next.doc.child(1).type.name).toBe("hr");
  });

  it("still deletes an adjacent horizontal rule from a non-empty paragraph end", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("text")),
      schema.node("hr"),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 5),
    });
    let next = state;

    expect(
      deleteAdjacentAtomBlock("forward")(state, (tr) => {
        next = state.apply(tr);
      })
    ).toBe(true);
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.child(0).type.name).toBe("paragraph");
  });
});
