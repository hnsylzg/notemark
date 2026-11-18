import { Schema } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it } from "vitest";
import { deleteEmptyEditableBlock } from "./block-exit";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    math_block: {
      group: "block",
      atom: true,
      toDOM: () => ["div", { "data-type": "math_block" }],
    },
    text: { group: "inline" },
  },
});

function createView(nodes: ReturnType<typeof schema.node>[]) {
  const doc = schema.node("doc", null, nodes);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({ schema, doc }),
  });
  return { view, host };
}

describe("empty editable block cleanup", () => {
  it("replaces the only child with a valid empty paragraph", () => {
    const block = schema.node("math_block");
    const { view, host } = createView([block]);

    try {
      expect(
        deleteEmptyEditableBlock(view, 0, block.nodeSize, true)
      ).toBe(true);
      expect(view.state.doc.childCount).toBe(1);
      expect(view.state.doc.firstChild!.type.name).toBe("paragraph");
      expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("deletes an empty block when a sibling paragraph remains", () => {
    const block = schema.node("math_block");
    const { view, host } = createView([
      block,
      schema.node("paragraph"),
    ]);

    try {
      expect(
        deleteEmptyEditableBlock(view, 0, block.nodeSize, false)
      ).toBe(true);
      expect(view.state.doc.childCount).toBe(1);
      expect(view.state.doc.firstChild!.type.name).toBe("paragraph");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
