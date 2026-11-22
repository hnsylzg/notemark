import { editorViewCtx } from "@milkdown/kit/core";
import { Schema } from "@milkdown/prose/model";
import { undoDepth } from "@milkdown/prose/history";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it, vi } from "vitest";
import {
  createFootnoteClickPlugin,
  createFootnoteDefinitionView,
  createFootnoteReferenceView,
} from "./footnote";
import { createEditor, setMarkdown } from "./index";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    footnote_reference: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { label: { default: "" } },
      toDOM: (node) => [
        "sup",
        { "data-type": "footnote_reference" },
        String(node.attrs.label),
      ],
    },
    footnote_definition: {
      group: "block",
      content: "block+",
      attrs: { label: { default: "" } },
      toDOM: (node) => [
        "dl",
        {
          "data-type": "footnote_definition",
          "data-label": String(node.attrs.label),
        },
        ["dt", String(node.attrs.label)],
        ["dd", 0],
      ],
    },
    text: { group: "inline" },
  },
});

describe("footnote definition source label", () => {
  it("enters the footnote reference from the actual editor keyboard flow", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(
        editor,
        "正文[^1]\n\n[^1]: 脚注内容\n"
      );
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const referenceDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_reference"]'
      )!;
      const referencePos = view.posAtDOM(referenceDom, 0);
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, referencePos)
        )
      );

      expect(
        view.someProp("handleKeyDown", (handler) =>
          handler(
            view,
            new KeyboardEvent("keydown", {
              key: "ArrowRight",
              bubbles: true,
              cancelable: true,
            })
          )
        )
      ).toBe(true);
      const input = referenceDom.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(input.value).toBe("[^1]");
      expect(referenceDom.ownerDocument.activeElement).toBe(input);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("enters the definition number before moving to the previous block", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "前文\n\n[^1]: 脚注内容\n");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      let definitionPos = -1;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === "footnote_definition") {
          definitionPos = pos;
          return false;
        }
        return true;
      });
      expect(definitionPos).toBeGreaterThan(0);
      const firstBodyPos = definitionPos + 2;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, firstBodyPos)
        )
      );

      expect(
        view.someProp("handleKeyDown", (handler) =>
          handler(
            view,
            new KeyboardEvent("keydown", {
              key: "ArrowLeft",
              bubbles: true,
              cancelable: true,
            })
          )
        )
      ).toBe(true);
      const dt = view.dom.querySelector<HTMLElement>("dt")!;
      const source = dt.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      expect(dt.ownerDocument.activeElement).toBe(source);
      expect(source.selectionStart).toBe(source.value.length);
      expect(view.state.selection.from).toBe(firstBodyPos);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("enters the definition from the end of the previous block", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "前文\n\n[^1]: 脚注内容\n");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      let previousEnd = -1;
      let definitionPos = -1;
      view.state.doc.descendants((node, pos) => {
        if (
          node.type.name === "paragraph" &&
          node.textContent === "前文"
        ) {
          previousEnd = pos + 1 + node.content.size;
        }
        if (node.type.name === "footnote_definition") {
          definitionPos = pos;
          return false;
        }
        return true;
      });
      expect(previousEnd).toBeGreaterThan(0);
      expect(definitionPos).toBeGreaterThan(previousEnd);
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, previousEnd)
        )
      );

      expect(
        view.someProp("handleKeyDown", (handler) =>
          handler(
            view,
            new KeyboardEvent("keydown", {
              key: "ArrowRight",
              bubbles: true,
              cancelable: true,
            })
          )
        )
      ).toBe(true);
      const source = view.dom.querySelector<HTMLInputElement>(
        "dt input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      expect(source.selectionStart).toBe(0);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("enters the definition number before leaving the footnote", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const before = schema.node("paragraph");
    const body = schema.node(
      "paragraph",
      null,
      [schema.text("body"), reference]
    );
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [before, body, definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const definitionPos = before.nodeSize + body.nodeSize;
    const firstBodyPos = definitionPos + 2;
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, firstBodyPos),
        plugins: [createFootnoteClickPlugin()],
      }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const enter = new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      });
      expect(
        view.someProp("handleKeyDown", (handler) =>
          handler(view, enter)
        )
      ).toBe(true);
      const dt = view.dom.querySelector<HTMLElement>("dt")!;
      const source = dt.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      expect(dt.ownerDocument.activeElement).toBe(source);
      expect(source.selectionStart).toBe(source.value.length);

      source.setSelectionRange(0, 0);

      source.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        })
      );

      expect(dt.textContent).toBe("1");
      expect(view.state.selection.$from.parent.type.name).toBe(
        "paragraph"
      );
      expect(view.state.selection.from).toBeLessThan(definitionPos);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("enters the reference number from the keyboard", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const body = schema.node(
      "paragraph",
      null,
      [schema.text("body"), reference]
    );
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [body, definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 5),
        plugins: [createFootnoteClickPlugin()],
      }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const referenceDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_reference"]'
      )!;
      expect(
        view.someProp("handleKeyDown", (handler) =>
          handler(
            view,
            new KeyboardEvent("keydown", {
              key: "ArrowRight",
              bubbles: true,
              cancelable: true,
            })
          )
        )
      ).toBe(true);

      const source = referenceDom.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]");
      expect(referenceDom.ownerDocument.activeElement).toBe(source);
      expect(source.selectionStart).toBe(0);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("opens the reference from a mouse edge position", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const body = schema.node(
      "paragraph",
      null,
      [schema.text("body"), reference]
    );
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [body, definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 5),
        plugins: [createFootnoteClickPlugin()],
      }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const referenceDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_reference"]'
      )!;
      expect(
        view.someProp("handleClick", (handler) =>
          handler(view, 5, {
            button: 0,
            target: view.dom.querySelector("p"),
            preventDefault() {},
          } as unknown as MouseEvent)
        )
      ).toBe(true);
      const source = referenceDom.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]");
      expect(referenceDom.ownerDocument.activeElement).toBe(source);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("does not let the click fallback open the definition NodeView", () => {
    const before = schema.node(
      "paragraph",
      null,
      schema.text("before")
    );
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [before, definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const definitionPos = before.nodeSize;
    const firstBodyPos = definitionPos + 2;
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, firstBodyPos),
        plugins: [createFootnoteClickPlugin()],
      }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const definitionDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_definition"]'
      )!;
      expect(
        view.someProp("handleClick", (handler) =>
          handler(view, firstBodyPos, {
            button: 0,
            target: definitionDom,
            preventDefault() {},
          } as unknown as MouseEvent)
        )
      ).toBeFalsy();
      expect(
        definitionDom.querySelector(
          "input.mt-footnote-label-source"
        )
      ).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it.each(["definition", "number", "explanation"])(
    "does not start number editing from a secondary click on the %s",
    (targetKind) => {
      const definition = schema.nodes.footnote_definition.create(
        { label: "1" },
        schema.node("paragraph", null, schema.text("note"))
      );
      const doc = schema.node("doc", null, [definition]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({ schema, doc }),
        nodeViews: {
          footnote_definition: createFootnoteDefinitionView,
          footnote_reference: createFootnoteReferenceView,
        },
      });

      try {
        const definitionDom = view.dom.querySelector<HTMLElement>(
          '[data-type="footnote_definition"]'
        )!;
        const dt = definitionDom.querySelector<HTMLElement>("dt")!;
        const dd = definitionDom.querySelector<HTMLElement>("dd")!;
        const target =
          targetKind === "number"
            ? dt
            : targetKind === "explanation"
              ? dd
              : definitionDom;
        vi.spyOn(view, "posAtCoords").mockReturnValue({
          pos: 1,
          inside: -1,
        });

        for (const [type, button] of [
          ["mousedown", 2],
          ["contextmenu", 2],
          ["click", 0],
        ] as const) {
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button,
            })
          );
        }

        expect(dt.querySelector("input.mt-footnote-label-source")).toBeNull();
      } finally {
        view.destroy();
        host.remove();
      }
    }
  );

  it("opens at the start from the container's left mouse edge", () => {
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFootnoteClickPlugin()],
      }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const container = view.dom.querySelector<HTMLElement>(
        'dl[data-type="footnote_definition"]'
      )!;
      const dt = container.querySelector<HTMLElement>("dt")!;
      vi.spyOn(dt, "getBoundingClientRect").mockReturnValue({
        left: 20,
        right: 40,
        top: 0,
        bottom: 20,
        width: 20,
        height: 20,
        x: 20,
        y: 0,
        toJSON() {},
      });

      container.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 19,
        })
      );

      const source = dt.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      expect(source.selectionStart).toBe(0);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("does not open from the blank area above the number", () => {
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const definitionDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_definition"]'
      )!;
      const labelText = definitionDom.querySelector<HTMLElement>(
        ".mt-footnote-label-text"
      )!;
      const dt = definitionDom.querySelector<HTMLElement>("dt")!;
      vi.spyOn(labelText, "getBoundingClientRect").mockReturnValue({
        left: 20,
        right: 30,
        top: 20,
        bottom: 40,
        width: 10,
        height: 20,
        x: 20,
        y: 20,
        toJSON() {},
      });
      vi.spyOn(dt, "getBoundingClientRect").mockReturnValue({
        left: 20,
        right: 40,
        top: 20,
        bottom: 40,
        width: 20,
        height: 20,
        x: 20,
        y: 20,
        toJSON() {},
      });
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 1,
        inside: -1,
      });

      definitionDom.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 19,
          clientY: 10,
        })
      );

      expect(
        definitionDom.querySelector("input.mt-footnote-label-source")
      ).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("ignores the click synthesized after a secondary-button gesture", () => {
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const definitionDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_definition"]'
      )!;
      const dt = definitionDom.querySelector<HTMLElement>("dt")!;
      const dd = definitionDom.querySelector<HTMLElement>("dd")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 1,
        inside: -1,
      });

      for (const target of [definitionDom, dt, dd]) {
        for (const [type, button] of [
          ["mousedown", 2],
          ["contextmenu", 2],
          ["click", 0],
        ] as const) {
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button,
            })
          );
        }
        expect(
          dt.querySelector("input.mt-footnote-label-source")
        ).toBeNull();
      }
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("selects the number when clicking inside its label", () => {
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const dt = view.dom.querySelector<HTMLElement>("dt")!;
      vi.spyOn(dt, "getBoundingClientRect").mockReturnValue({
        left: 20,
        right: 40,
        top: 0,
        bottom: 20,
        width: 20,
        height: 20,
        x: 20,
        y: 0,
        toJSON() {},
      });

      dt.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 25,
        })
      );

      const source = dt.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.selectionStart).toBe(2);
      expect(source.selectionEnd).toBe(3);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("opens at the end when clicking between the colon and the explanation", async () => {
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("this"))
    );
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const dt = view.dom.querySelector<HTMLElement>("dt")!;
      const labelText = dt.querySelector<HTMLElement>(
        ".mt-footnote-label-text"
      )!;
      vi.spyOn(labelText, "getBoundingClientRect").mockReturnValue({
        left: 20,
        right: 30,
        top: 0,
        bottom: 20,
        width: 10,
        height: 20,
        x: 20,
        y: 0,
        toJSON() {},
      });
      const note = view.dom.querySelector(
        '[data-type="footnote_definition"] dd p'
      )!;
      const noteStart = view.posAtDOM(note, 0, 1);
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: noteStart,
        inside: noteStart - 1,
      });

      dt.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 35,
        })
      );
      dt.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 35,
        })
      );

      const source = dt.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      expect(source.selectionStart).toBe(source.value.length);
      expect(source.selectionEnd).toBe(source.value.length);
      document.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 35,
        })
      );
      source.setSelectionRange(1, 1);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      expect(source.selectionStart).toBe(source.value.length);
      expect(source.selectionEnd).toBe(source.value.length);
      dt.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 35,
        })
      );
      source.setSelectionRange(1, 1);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      expect(source.selectionStart).toBe(source.value.length);
      expect(source.selectionEnd).toBe(source.value.length);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("opens at the end when clicking the blank gap after the number", () => {
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("this"))
    );
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const definitionDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_definition"]'
      )!;
      const labelText = definitionDom.querySelector<HTMLElement>(
        ".mt-footnote-label-text"
      )!;
      vi.spyOn(labelText, "getBoundingClientRect").mockReturnValue({
        left: 20,
        right: 30,
        top: 0,
        bottom: 20,
        width: 10,
        height: 20,
        x: 20,
        y: 0,
        toJSON() {},
      });

      definitionDom.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 35,
        })
      );

      const source = definitionDom.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      expect(source.selectionStart).toBe(source.value.length);
      expect(source.selectionEnd).toBe(source.value.length);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("opens at the end when the gap target belongs to the explanation container", () => {
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("this"))
    );
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const definitionDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_definition"]'
      )!;
      const labelText = definitionDom.querySelector<HTMLElement>(
        ".mt-footnote-label-text"
      )!;
      const content = definitionDom.querySelector<HTMLElement>("dd p")!;
      const explanation = definitionDom.querySelector<HTMLElement>("dd")!;
      vi.spyOn(labelText, "getBoundingClientRect").mockReturnValue({
        left: 20,
        right: 30,
        top: 0,
        bottom: 20,
        width: 10,
        height: 20,
        x: 20,
        y: 0,
        toJSON() {},
      });
      vi.spyOn(content, "getBoundingClientRect").mockReturnValue({
        left: 40,
        right: 80,
        top: 0,
        bottom: 20,
        width: 40,
        height: 20,
        x: 40,
        y: 0,
        toJSON() {},
      });

      explanation.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 35,
        })
      );

      const source = definitionDom.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      expect(source.selectionStart).toBe(source.value.length);
      expect(source.selectionEnd).toBe(source.value.length);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("does not open the number editor when clicking explanation text", () => {
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("this"))
    );
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const definitionDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_definition"]'
      )!;
      const labelText = definitionDom.querySelector<HTMLElement>(
        ".mt-footnote-label-text"
      )!;
      const content = definitionDom.querySelector<HTMLElement>("dd p")!;
      const explanation = definitionDom.querySelector<HTMLElement>("dd")!;
      vi.spyOn(labelText, "getBoundingClientRect").mockReturnValue({
        left: 20,
        right: 30,
        top: 0,
        bottom: 20,
        width: 10,
        height: 20,
        x: 20,
        y: 0,
        toJSON() {},
      });
      vi.spyOn(content, "getBoundingClientRect").mockReturnValue({
        left: 40,
        right: 80,
        top: 0,
        bottom: 20,
        width: 40,
        height: 20,
        x: 40,
        y: 0,
        toJSON() {},
      });
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 3,
        inside: 1,
      });

      explanation.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 45,
        })
      );

      expect(
        definitionDom.querySelector("input.mt-footnote-label-source")
      ).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("selects the number when entering the inline reference by mouse", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("body"), reference]),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const referenceDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_reference"]'
      )!;
      referenceDom.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        })
      );
      const source = referenceDom.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]");
      expect(source.selectionStart).toBe(2);
      expect(source.selectionEnd).toBe(3);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it.each(["ArrowUp", "ArrowDown"])(
    "leaves the definition editor vertically on %s",
    (key) => {
      const above = schema.node(
        "paragraph",
        null,
        schema.text("above")
      );
      const definition = schema.nodes.footnote_definition.create(
        { label: "1" },
        schema.node("paragraph", null, schema.text("note"))
      );
      const below = schema.node(
        "paragraph",
        null,
        schema.text("below")
      );
      const doc = schema.node("doc", null, [
        above,
        definition,
        below,
      ]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({ schema, doc }),
        nodeViews: {
          footnote_definition: createFootnoteDefinitionView,
          footnote_reference: createFootnoteReferenceView,
        },
      });

      try {
        const dt = view.dom.querySelector<HTMLElement>("dt")!;
        dt.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
          })
        );
        const source = dt.querySelector<HTMLInputElement>(
          "input.mt-footnote-label-source"
        )!;
        vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
          left: 20,
          right: 60,
          top: 20,
          bottom: 40,
          width: 40,
          height: 20,
          x: 20,
          y: 20,
          toJSON() {},
        });
        const target =
          key === "ArrowUp"
            ? 2
            : above.nodeSize + definition.nodeSize + 1;
        vi.spyOn(view, "posAtCoords").mockReturnValue({
          pos: target,
          inside: -1,
        });

        source.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          })
        );

        expect(dt.querySelector("input")).toBeNull();
        expect(view.state.selection.$from.parent.textContent).toBe(
          key === "ArrowUp" ? "above" : "below"
        );
      } finally {
        view.destroy();
        host.remove();
      }
    }
  );

  it("moves an inline reference down to the next visual line", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const body = schema.node(
      "paragraph",
      null,
      [schema.text("body"), reference]
    );
    const below = schema.node(
      "paragraph",
      null,
      schema.text("below")
    );
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [body, below, definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const referenceDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_reference"]'
      )!;
      referenceDom.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
        })
      );
      const source = referenceDom.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
        left: 90,
        right: 110,
        top: 0,
        bottom: 10,
        width: 20,
        height: 10,
        x: 90,
        y: 0,
        toJSON() {},
      });
      vi.spyOn(
        view.dom.querySelector("p")!,
        "getClientRects"
      ).mockReturnValue([
        {
          left: 90,
          right: 120,
          top: 30,
          bottom: 50,
          width: 30,
          height: 20,
          x: 90,
          y: 30,
          toJSON() {},
        },
        {
          left: 20,
          right: 60,
          top: 30,
          bottom: 50,
          width: 40,
          height: 20,
          x: 20,
          y: 30,
          toJSON() {},
        },
      ] as unknown as DOMRectList);
      vi.spyOn(
        view.dom.querySelectorAll("p")[1],
        "getClientRects"
      ).mockReturnValue([
        {
          left: 20,
          right: 60,
          top: 50,
          bottom: 70,
          width: 40,
          height: 20,
          x: 20,
          y: 50,
          toJSON() {},
        },
      ] as unknown as DOMRectList);
      const target = body.nodeSize + 1;
      const posAtCoords = vi
        .spyOn(view, "posAtCoords")
        .mockImplementation(({ left, top }) => ({
          pos:
            top >= 50 && top <= 70 && left <= 60
              ? target
              : body.nodeSize - 2,
          inside: -1,
        }));

      source.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        })
      );

      expect(posAtCoords).toHaveBeenCalledWith(
        expect.objectContaining({ top: expect.any(Number) })
      );
      expect(posAtCoords.mock.calls[0][0].top).toBeGreaterThan(50);
      expect(posAtCoords.mock.calls[0][0].top).toBeLessThan(70);
      expect(posAtCoords.mock.calls[0][0].left).toBeLessThanOrEqual(60);
      expect(view.state.selection.$from.parent.textContent).toBe(
        "below"
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("activates definition and reference editing without changing the document or history", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("body"), reference]),
      definition,
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const before = view.state.doc.toJSON();
      const depthBefore = undoDepth(view.state);
      const referenceDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_reference"]'
      )!;
      referenceDom.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      const dt = view.dom.querySelector<HTMLElement>("dt")!;
      dt.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );

      expect(view.state.doc.toJSON()).toEqual(before);
      expect(undoDepth(view.state)).toBe(depthBefore);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("edits and synchronizes both footnote labels", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("body"), reference]),
      definition,
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFootnoteClickPlugin()],
      }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const dt = view.dom.querySelector<HTMLElement>("dt")!;
      dt.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      const source = dt.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      expect(dt.dataset.mtSource).toBe("true");

      source.value = "[^2]:";
      source.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
      expect(dt.textContent).toBe("2");
      expect(dt.dataset.mtSource).toBeUndefined();
      expect(view.state.doc.firstChild?.lastChild?.attrs.label).toBe("2");
      expect(view.state.doc.lastChild?.attrs.label).toBe("2");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("edits the inline reference marker and updates its definition", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("body"), reference]),
      definition,
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const referenceDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_reference"]'
      )!;
      referenceDom.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      const source = referenceDom.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]");

      source.value = "[^3]";
      source.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
      expect(referenceDom.textContent).toBe("3");
      const firstParagraph = view.state.doc.firstChild!;
      expect(firstParagraph.lastChild?.attrs.label).toBe("3");
      expect(view.state.doc.lastChild?.attrs.label).toBe("3");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("restores rendered footnote numbers on focusout and outside clicks", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const definition = schema.nodes.footnote_definition.create(
      { label: "1" },
      schema.node("paragraph", null, schema.text("note"))
    );
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("body"), reference]),
      definition,
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: {
        footnote_definition: createFootnoteDefinitionView,
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      const referenceDom = view.dom.querySelector<HTMLElement>(
        '[data-type="footnote_reference"]'
      )!;
      referenceDom.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      const referenceSource =
        referenceDom.querySelector<HTMLInputElement>(
          "input.mt-footnote-label-source"
        )!;
      expect(referenceSource.value).toBe("[^1]");
      referenceSource.dispatchEvent(new FocusEvent("blur"));
      expect(referenceDom.textContent).toBe("1");

      const dt = view.dom.querySelector<HTMLElement>("dt")!;
      dt.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      let source = dt.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      const dd = view.dom.querySelector<HTMLElement>("dd")!;
      dd.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: false, cancelable: true })
      );
      expect(dt.textContent).toBe("1");

      dt.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      source = dt.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
      expect(dt.textContent).toBe("1");

      dt.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      source = dt.querySelector<HTMLInputElement>(
        "input.mt-footnote-label-source"
      )!;
      expect(source.value).toBe("[^1]:");
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: false })
      );
      expect(dt.textContent).toBe("1");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
