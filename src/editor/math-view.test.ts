import { Schema } from "@milkdown/prose/model";
import { history, undoDepth } from "@milkdown/prose/history";
import {
  EditorState,
  NodeSelection,
  TextSelection,
} from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it, vi } from "vitest";
import {
  createInlineMathTransaction,
  createMathInlineCursorPlugin,
  createMathInlineNodeView,
} from "./math-view";

vi.mock("./mathjax", () => ({
  renderMathJaxSvg: vi.fn(async (tex: string) => {
    const output = document.createElement("span");
    output.className = "mock-mathjax";
    output.textContent = tex;
    return output;
  }),
}));

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    math_inline: {
      group: "inline",
      content: "text*",
      inline: true,
      atom: true,
      toDOM: () => ["span", { "data-type": "math_inline" }, 0],
    },
    text: { group: "inline" },
  },
});

function stateWithText(
  text: string,
  from = 1,
  to = from
): EditorState {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, text ? schema.text(text) : undefined),
  ]);
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, from, to),
  });
}

describe("inline math source insertion", () => {
  it("converts selected text into an inline math node with the same source", () => {
    const text = "a^2+b^2";
    const state = stateWithText(text, 1, 1 + text.length);
    const insertion = createInlineMathTransaction(state)!;
    const next = state.applyTransaction(insertion.tr).state;
    const node = next.doc.firstChild!.firstChild!;

    expect(insertion.selected).toBe(true);
    expect(node.type.name).toBe("math_inline");
    expect(node.textContent).toBe(text);
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.firstChild!.childCount).toBe(1);
  });

  it("inserts an empty inline math node at an empty caret", () => {
    const state = stateWithText("正文", 3, 3);
    const insertion = createInlineMathTransaction(state)!;
    const next = state.applyTransaction(insertion.tr).state;

    expect(insertion.selected).toBe(false);
    expect(next.doc.firstChild!.child(1).type.name).toBe("math_inline");
    expect(next.doc.firstChild!.child(1).textContent).toBe("");
    expect(next.selection.from).toBe(5);
  });

  it("does not convert a selection spanning multiple text blocks", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("第一段")),
      schema.node("paragraph", null, schema.text("第二段")),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 7),
    });

    expect(createInlineMathTransaction(state)).toBeNull();
  });

  it.each([
    ["left", 1, 0, "ArrowLeft", 1],
    ["right", 4, 3, "ArrowRight", 4],
  ])(
    "opens inline math editing when keyboard enters from the %s",
    (
      _side,
      initialSelection,
      expectedCaret,
      exitKey,
      expectedEditorCaret
    ) => {
      const math = schema.nodes.math_inline.create(
        null,
        schema.text("x")
      );
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, math),
      ]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, initialSelection),
        plugins: [history(), createMathInlineCursorPlugin()],
        }),
        nodeViews: { math_inline: createMathInlineNodeView },
      });

      try {
      const docBefore = view.state.doc.toJSON();
      expect(undoDepth(view.state)).toBe(0);
        view.dispatch(
          view.state.tr.setSelection(
            NodeSelection.create(view.state.doc, 1)
          )
        );
        const input = view.dom.querySelector<HTMLInputElement>(
          ".milkdown-math-inline-input"
        )!;
        expect(input.style.display).toBe("");
        expect(input.value).toBe("$x$");
        expect(input.selectionStart).toBe(expectedCaret);
        expect(input.selectionEnd).toBe(expectedCaret);
      expect(view.state.doc.toJSON()).toEqual(docBefore);
      expect(undoDepth(view.state)).toBe(0);

        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: exitKey,
            bubbles: true,
            cancelable: true,
          })
        );
        expect(input.style.display).toBe("none");
        expect(view.state.selection.from).toBe(expectedEditorCaret);
      expect(view.state.doc.toJSON()).toEqual(docBefore);
      expect(undoDepth(view.state)).toBe(0);
      } finally {
        view.destroy();
        host.remove();
      }
    }
  );

  it.each([
    ["ArrowUp", "above"],
    ["ArrowDown", "below"],
  ])(
    "moves the editor cursor to the adjacent line on %s",
    (key, expectedLine) => {
      const math = schema.nodes.math_inline.create(
        null,
        schema.text("x")
      );
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, schema.text("above")),
        schema.node("paragraph", null, math),
        schema.node("paragraph", null, schema.text("below")),
      ]);
      const formulaStart = doc.child(0).nodeSize;
      const target =
        expectedLine === "above"
          ? 2
          : doc.child(0).nodeSize +
            doc.child(1).nodeSize +
            2;
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, formulaStart + 1),
          plugins: [history()],
        }),
        nodeViews: { math_inline: createMathInlineNodeView },
      });
      const posAtCoords = vi
        .spyOn(view, "posAtCoords")
        .mockReturnValue({ pos: target, inside: formulaStart });

      try {
        const docBefore = view.state.doc.toJSON();
        const mathDom = view.dom.querySelector<HTMLElement>(
          ".milkdown-math-inline"
        )!;
        const input = mathDom.querySelector<HTMLInputElement>(
          ".milkdown-math-inline-input"
        )!;
        mathDom.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(input.style.display).toBe("");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          })
        );

        expect(posAtCoords).toHaveBeenCalledOnce();
        expect(input.style.display).toBe("none");
        expect(view.state.selection.$from.parent.textContent).toBe(
          expectedLine
        );
        expect(view.state.doc.toJSON()).toEqual(docBefore);
        expect(undoDepth(view.state)).toBe(0);
      } finally {
        posAtCoords.mockRestore();
        view.destroy();
        host.remove();
      }
    }
  );

  it.each(["ArrowUp", "ArrowDown"])(
    "renders edited inline math before moving vertically on %s",
    async (key) => {
      const math = schema.nodes.math_inline.create(
        null,
        schema.text("x")
      );
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, math),
        schema.node("paragraph", null, schema.text("below")),
      ]);
      const formulaStart = 1;
      const target = doc.child(0).nodeSize + 2;
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, formulaStart + 1),
          plugins: [history()],
        }),
        nodeViews: { math_inline: createMathInlineNodeView },
      });
      const posAtCoords = vi
        .spyOn(view, "posAtCoords")
        .mockReturnValue({ pos: target, inside: 0 });

      try {
        const mathDom = view.dom.querySelector<HTMLElement>(
          ".milkdown-math-inline"
        )!;
        const input = mathDom.querySelector<HTMLInputElement>(
          ".milkdown-math-inline-input"
        )!;
        const display = mathDom.querySelector<HTMLElement>(
          ".milkdown-math-inline-display"
        )!;
        mathDom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        input.value = "$y^2$";
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          })
        );

        expect(input.style.display).toBe("none");
        expect(view.state.doc.firstChild!.firstChild!.textContent).toBe("y^2");
        await vi.waitFor(() => expect(display.textContent).toBe("y^2"));
      } finally {
        posAtCoords.mockRestore();
        view.destroy();
        host.remove();
      }
    }
  );

  it("edits the dollar markers as part of the inline source", () => {
    const math = schema.nodes.math_inline.create(
      null,
      schema.text("x^2")
    );
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, math),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 4),
      }),
      nodeViews: {
        math_inline: createMathInlineNodeView,
      },
    });

    try {
      const mathDom = view.dom.querySelector<HTMLElement>(
        ".milkdown-math-inline"
      )!;
      const input = mathDom.querySelector<HTMLInputElement>(
        ".milkdown-math-inline-input"
      )!;

      mathDom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(input.value).toBe("$x^2$");

      input.value = "$y^2$";
      input.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.firstChild!.firstChild!.textContent).toBe("y^2");
      expect(
        mathDom.querySelector(".milkdown-math-inline-display")?.textContent
      ).not.toContain("$");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("opens an empty source pair between the dollar markers", () => {
    const math = schema.nodes.math_inline.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, math),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 3),
      }),
      nodeViews: {
        math_inline: createMathInlineNodeView,
      },
    });

    try {
      const mathDom = view.dom.querySelector<HTMLElement>(
        ".milkdown-math-inline"
      )!;
      const input = mathDom.querySelector<HTMLInputElement>(
        ".milkdown-math-inline-input"
      )!;

      mathDom.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(input.value).toBe("$$");
      expect(input.style.width).toBe("");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it.each([1, 4])(
    "opens inline math when a click lands on its paragraph edge at %i",
    (edgePos) => {
      const math = schema.nodes.math_inline.create(
        null,
        schema.text("x")
      );
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, math),
      ]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 3),
          plugins: [createMathInlineCursorPlugin()],
        }),
        nodeViews: {
          math_inline: createMathInlineNodeView,
        },
      });

      try {
        const mathDom = view.dom.querySelector<HTMLElement>(
          ".milkdown-math-inline"
        )!;
        const input = mathDom.querySelector<HTMLInputElement>(
          ".milkdown-math-inline-input"
        )!;
        const clicked = view.someProp("handleClick", (handler) =>
          handler(view, edgePos, {
            button: 0,
            target: view.dom.querySelector("p"),
            preventDefault() {},
          } as MouseEvent)
        );

        expect(clicked).toBe(true);
        expect(input.style.display).not.toBe("none");
        expect(mathDom.ownerDocument.activeElement).toBe(input);
      } finally {
        view.destroy();
        host.remove();
      }
    }
  );

  it("removes an inline math node when editing ends without content", () => {
    const math = schema.nodes.math_inline.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, math),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 3),
      }),
      nodeViews: {
        math_inline: createMathInlineNodeView,
      },
    });

    try {
      const mathDom = view.dom.querySelector<HTMLElement>(
        ".milkdown-math-inline"
      )!;
      const input = mathDom.querySelector<HTMLInputElement>(
        ".milkdown-math-inline-input"
      )!;

      mathDom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.firstChild!.childCount).toBe(0);
      expect(view.state.doc.textContent).toBe("");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("turns deleted dollar markers back into ordinary text", () => {
    const math = schema.nodes.math_inline.create(
      null,
      schema.text("x")
    );
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, math),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 3),
      }),
      nodeViews: {
        math_inline: createMathInlineNodeView,
      },
    });

    try {
      const mathDom = view.dom.querySelector<HTMLElement>(
        ".milkdown-math-inline"
      )!;
      const input = mathDom.querySelector<HTMLInputElement>(
        ".milkdown-math-inline-input"
      )!;
      mathDom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      input.value = "普通文本";
      input.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.textContent).toBe("普通文本");
      expect(view.state.doc.firstChild?.firstChild?.type.name).toBe("text");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
