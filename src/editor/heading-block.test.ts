import { Schema } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it } from "vitest";
import {
  createHeadingTransaction,
  resolveTextblockTarget,
} from "./heading-block";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { level: { default: 1 } },
      parseDOM: [{ tag: "h1" }],
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    text: { group: "inline" },
  },
});

function stateWith(nodes: ReturnType<typeof schema.node>[]): EditorState {
  return EditorState.create({
    schema,
    doc: schema.node("doc", null, nodes),
  });
}

function applyHeading(
  state: EditorState,
  position: number,
  level: 1 | 2 | 3 | 4 | 5 | 6
) {
  const target = resolveTextblockTarget(state.doc, position);
  expect(target).not.toBeNull();
  const tr = createHeadingTransaction(state, target!, level);
  expect(tr).not.toBeNull();
  return state.apply(tr!);
}

describe("right-click heading target", () => {
  it("turns the empty first paragraph into a heading without a prior caret click", () => {
    const state = stateWith([schema.node("paragraph")]);

    for (const position of [0, 1, state.doc.content.size]) {
      expect(resolveTextblockTarget(state.doc, position)?.blockPos).toBe(0);
      const target = resolveTextblockTarget(state.doc, position)!;
      expect(target.contentStart + target.caretOffset).toBe(1);
    }

    const next = applyHeading(state, 0, 1);
    expect(next.doc.toJSON()).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
        },
        {
          type: "paragraph",
        },
      ],
    });
    expect(next.selection.from).toBe(1);
    expect(next.selection.$from.parent.type.name).toBe("heading");
  });

  it("maps the empty first line's DOM paragraph to blockPos 0 before any click", () => {
    const state = stateWith([schema.node("paragraph")]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, { state });

    try {
      const paragraph = view.dom.querySelector("p");
      expect(paragraph).not.toBeNull();
      const target = resolveTextblockTarget(
        view.state.doc,
        view.posAtDOM(paragraph!, 0, 1)
      );
      expect(target?.blockPos).toBe(0);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("converts the textblock under the pointer while preserving other blocks", () => {
    const first = schema.node("paragraph", null, schema.text("正文"));
    const state = stateWith([first, schema.node("paragraph")]);

    const next = applyHeading(state, first.nodeSize, 1);
    expect(next.doc.child(0).type.name).toBe("paragraph");
    expect(next.doc.child(0).textContent).toBe("正文");
    expect(next.doc.child(1).type.name).toBe("heading");
    expect(next.doc.child(1).attrs.level).toBe(1);
  });

  it("normalizes document-end hit testing to the last paragraph's text caret", () => {
    const paragraph = schema.node(
      "paragraph",
      null,
      schema.text("行尾")
    );
    const state = stateWith([paragraph]);
    const target = resolveTextblockTarget(
      state.doc,
      state.doc.content.size
    )!;

    expect(target.blockPos).toBe(0);
    expect(target.contentStart + target.caretOffset).toBe(3);
  });

  it("changes an existing heading level in place without adding another block", () => {
    const heading = schema.node(
      "heading",
      { level: 2 },
      schema.text("已有标题")
    );
    const state = stateWith([heading]);

    const next = applyHeading(state, 1, 1);
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.child(0).type.name).toBe("heading");
    expect(next.doc.child(0).attrs.level).toBe(1);
    expect(next.doc.child(0).textContent).toBe("已有标题");
  });

  it("converts the whole paragraph even when only part of its text is selected", () => {
    const paragraph = schema.node(
      "paragraph",
      null,
      schema.text("部分选中")
    );
    const state = stateWith([paragraph]);
    const target = resolveTextblockTarget(state.doc, 3)!;
    target.selection = { from: 2, to: 4 };

    const tr = createHeadingTransaction(state, target, 2)!;
    const next = state.apply(tr);
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.child(0).type.name).toBe("heading");
    expect(next.doc.child(0).attrs.level).toBe(2);
    expect(next.doc.child(0).textContent).toBe("部分选中");
    expect(next.selection.from).toBe(2);
    expect(next.selection.to).toBe(4);
  });
});
