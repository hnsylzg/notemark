import { Schema } from "@milkdown/prose/model";
import {
  EditorState,
  Selection,
  TextSelection,
} from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it } from "vitest";
import {
  runEditorCommand,
  setEditorActionHandler,
} from "./editor-actions";

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
    diagram: {
      group: "block",
      atom: true,
      attrs: {
        value: { default: "" },
        identity: { default: "" },
      },
      toDOM: () => ["div", { "data-type": "diagram" }],
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

describe("editor block actions", () => {
  it("leaves a normal editable paragraph after an inserted horizontal rule", () => {
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
      setEditorActionHandler((action, currentView, pos) => {
        expect(action).toBe("horizontalRule");
        const paragraph = schema.nodes.paragraph.create();
        const hr = schema.nodes.hr.create();
        const tr = currentView.state.tr
          .replaceSelectionWith(hr)
          .insert(pos, paragraph);
        const selection = Selection.findFrom(tr.doc.resolve(pos), 1, true);
        if (selection) currentView.dispatch(tr.setSelection(selection));
      });
      expect(runEditorCommand(view, "hr")).toBe(true);
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.child(0).type.name).toBe("hr");
      expect(view.state.doc.child(1).type.name).toBe("paragraph");
      expect(view.state.selection.empty).toBe(true);
      expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(view.state.selection.from).toBe(2);
    } finally {
      setEditorActionHandler(null);
      view.destroy();
      host.remove();
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
});
