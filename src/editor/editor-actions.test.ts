import { Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it, vi } from "vitest";
import { runEditorCommand } from "./editor-actions";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    hr: {
      group: "block",
      atom: true,
      selectable: false,
      toDOM: () => ["hr"],
    },
    code_block: {
      group: "block",
      content: "text*",
      marks: "",
      toDOM: () => ["pre", 0],
    },
    math_block: {
      group: "block",
      content: "text*",
      atom: true,
      attrs: { value: { default: "" } },
      toDOM: () => ["div", { class: "milkdown-math-block" }],
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

function mount(
  doc: ReturnType<typeof schema.node>,
  from: number,
  to = from
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, from, to),
    }),
  });
  return { host, view };
}

describe("editor block actions", () => {
  it("inserts horizontal rules above or below without extra blank paragraphs", () => {
    const startDoc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("body")),
    ]);
    const start = mount(startDoc, 1);

    try {
      expect(runEditorCommand(start.view, "hr")).toBe(true);
      expect(start.view.state.doc.childCount).toBe(2);
      expect(start.view.state.doc.child(0).type.name).toBe("hr");
      expect(start.view.state.doc.child(1).textContent).toBe("body");
    } finally {
      start.view.destroy();
      start.host.remove();
    }

    const end = mount(startDoc, 5);
    try {
      expect(runEditorCommand(end.view, "hr")).toBe(true);
      expect(end.view.state.doc.childCount).toBe(2);
      expect(end.view.state.doc.child(0).textContent).toBe("body");
      expect(end.view.state.doc.child(1).type.name).toBe("hr");
    } finally {
      end.view.destroy();
      end.host.remove();
    }
  });

  it("wraps only selected text in a code block", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("before selected after")),
    ]);
    const from = 1 + "before ".length;
    const to = from + "selected".length;
    const mounted = mount(doc, from, to);

    try {
      expect(runEditorCommand(mounted.view, "code")).toBe(true);
      const next = mounted.view.state.doc;
      expect(next.childCount).toBe(3);
      expect(next.child(0).textContent).toBe("before ");
      expect(next.child(1).type.name).toBe("code_block");
      expect(next.child(1).textContent).toBe("selected");
      expect(next.child(2).textContent).toBe(" after");
    } finally {
      mounted.view.destroy();
      mounted.host.remove();
    }
  });

  it("inserts code blocks before or after a collapsed paragraph caret", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("body")),
    ]);
    const start = mount(doc, 1);
    try {
      expect(runEditorCommand(start.view, "code")).toBe(true);
      expect(start.view.state.doc.childCount).toBe(2);
      expect(start.view.state.doc.child(0).type.name).toBe("code_block");
      expect(start.view.state.doc.child(1).textContent).toBe("body");
    } finally {
      start.view.destroy();
      start.host.remove();
    }

    const end = mount(doc, 5);
    try {
      expect(runEditorCommand(end.view, "code")).toBe(true);
      expect(end.view.state.doc.childCount).toBe(2);
      expect(end.view.state.doc.child(0).textContent).toBe("body");
      expect(end.view.state.doc.child(1).type.name).toBe("code_block");
    } finally {
      end.view.destroy();
      end.host.remove();
    }
  });

  it("deletes only selected text when inserting a math block", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("before selected after")),
    ]);
    const from = 1 + "before ".length;
    const to = from + "selected".length;
    const mounted = mount(doc, from, to);

    try {
      expect(runEditorCommand(mounted.view, "math")).toBe(true);
      const next = mounted.view.state.doc;
      expect(next.childCount).toBe(3);
      expect(next.child(0).textContent).toBe("before ");
      expect(next.child(1).type.name).toBe("math_block");
      expect(next.child(1).textContent).toBe("");
      expect(next.child(2).textContent).toBe(" after");
    } finally {
      mounted.view.destroy();
      mounted.host.remove();
    }
  });

  it("inserts math blocks above or below without consuming the paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("body")),
    ]);
    const start = mount(doc, 1);
    try {
      expect(runEditorCommand(start.view, "math")).toBe(true);
      expect(start.view.state.doc.childCount).toBe(2);
      expect(start.view.state.doc.child(0).type.name).toBe("math_block");
      expect(start.view.state.doc.child(1).textContent).toBe("body");
    } finally {
      start.view.destroy();
      start.host.remove();
    }

    const end = mount(doc, 5);
    try {
      expect(runEditorCommand(end.view, "math")).toBe(true);
      expect(end.view.state.doc.childCount).toBe(2);
      expect(end.view.state.doc.child(0).textContent).toBe("body");
      expect(end.view.state.doc.child(1).type.name).toBe("math_block");
    } finally {
      end.view.destroy();
      end.host.remove();
    }
  });

  it("inserts a TOC at the empty first paragraph without a blank line above", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 1),
      }),
    });

    try {
      expect(runEditorCommand(view, "toc")).toBe(true);
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.child(0).type.name).toBe("toc");
      expect(view.state.doc.child(1).type.name).toBe("paragraph");
      expect(view.state.selection.from).toBe(2);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("places and focuses the table size dialog over the insertion point", async () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("body")),
    ]);
    const mounted = mount(doc, 3);
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });

    try {
      vi.spyOn(mounted.view, "coordsAtPos").mockReturnValue({
        left: 120,
        right: 121,
        top: 80,
        bottom: 100,
      });
      expect(runEditorCommand(mounted.view, "table")).toBe(true);
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          ".mt-slash-linkbox__input"
        )
      );
      expect(inputs).toHaveLength(2);
      expect(document.activeElement).toBe(inputs[0]);
      const box = inputs[0].closest<HTMLElement>(".mt-slash-linkbox")!;
      expect(box.style.left).toBe("120px");
      expect(box.style.top).toBe("80px");

      mounted.view.focus();
      await Promise.resolve();
      expect(document.activeElement).toBe(inputs[0]);

      mounted.view.focus();
      frameCallbacks.forEach((callback) => callback(0));
      expect(document.activeElement).toBe(inputs[0]);

      inputs[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } finally {
      document
        .querySelector<HTMLInputElement>(".mt-slash-linkbox__input")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
      mounted.view.destroy();
      mounted.host.remove();
      vi.unstubAllGlobals();
    }
  });
});
