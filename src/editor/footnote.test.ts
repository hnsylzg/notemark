import { Schema } from "@milkdown/prose/model";
import { undoDepth } from "@milkdown/prose/history";
import { EditorState } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it } from "vitest";
import {
  createFootnoteClickPlugin,
  createFootnoteDefinitionView,
  createFootnoteReferenceView,
} from "./footnote";

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
      expect(dt.textContent).toBe("[^1]:");
      expect(dt.dataset.mtSource).toBe("true");
      expect(dt.contentEditable).toBe("plaintext-only");

      dt.textContent = "[^2]:";
      dt.dispatchEvent(
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
      expect(referenceDom.textContent).toBe("[^1]");
      expect(referenceDom.contentEditable).toBe("plaintext-only");

      referenceDom.textContent = "[^3]";
      referenceDom.dispatchEvent(
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
      expect(referenceDom.textContent).toBe("[^1]");
      referenceDom.dispatchEvent(new FocusEvent("focusout"));
      expect(referenceDom.textContent).toBe("1");

      const dt = view.dom.querySelector<HTMLElement>("dt")!;
      dt.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      expect(dt.textContent).toBe("[^1]:");
      const dd = view.dom.querySelector<HTMLElement>("dd")!;
      dd.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: false, cancelable: true })
      );
      expect(dt.textContent).toBe("1");

      dt.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      expect(dt.textContent).toBe("[^1]:");
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
      expect(dt.textContent).toBe("1");

      dt.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
      expect(dt.textContent).toBe("[^1]:");
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
