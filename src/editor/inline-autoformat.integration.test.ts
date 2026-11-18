import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { describe, expect, it } from "vitest";
import { createEditor } from "./index";

describe("inline markdown autoformat integration", () => {
  it("formats a complete emphasis marker entered as plain text", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const editorView = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      for (const character of "*ddd*") {
        const caret = editorView.state.selection.from;
        editorView.dispatch(
          editorView.state.tr.insertText(character, caret, caret)
        );
      }
      expect(
        editorView.dom.querySelector(
          ".mt-inline-source-preview--emphasis"
        )?.textContent
      ).toBe("ddd");
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );

      expect(editorView.state.doc.textContent).toBe("ddd");
      expect(
        editorView.state.doc.firstChild?.firstChild?.marks[0].type.name
      ).toBe("emphasis");
      expect(editorView.dom.querySelector("em")?.textContent).toBe(
        "ddd"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("commits italic formatting when ordinary text follows the marker", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const editorView = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      for (const character of "*ddd*") {
        const caret = editorView.state.selection.from;
        editorView.dispatch(
          editorView.state.tr.insertText(character, caret, caret)
        );
      }
      expect(
        editorView.dom.querySelector(
          ".mt-inline-source-preview--emphasis"
        )?.textContent
      ).toBe("ddd");

      const caret = editorView.state.selection.from;
      editorView.someProp("handleTextInput", (handler) =>
        handler(editorView, caret, caret, "x", () =>
          editorView.state.tr
        )
      );
      editorView.dispatch(
        editorView.state.tr.insertText("x", caret, caret)
      );
      await Promise.resolve();

      expect(editorView.state.doc.textContent).toBe("dddx");
      expect(editorView.dom.querySelector("em")?.textContent).toBe("ddd");
      expect(
        editorView.dom.querySelector(".mt-inline-source-preview")
      ).toBeNull();
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("formats after typing the closing stars, moving to the start, and repairing the opening star", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      expect(view).toBeInstanceOf(Object);
      const editorView = view as EditorView;
      for (const character of "*ddd**") {
        const caret = editorView.state.selection.from;
        editorView.dispatch(
          editorView.state.tr.insertText(character, caret, caret)
        );
      }
      expect(
        editorView.dom.querySelector(".mt-inline-source-preview")
      ).toBeNull();
      const start = 1;
      editorView.dispatch(
        editorView.state.tr.setSelection(
          TextSelection.create(editorView.state.doc, start)
        )
      );
      editorView.dispatch(
        editorView.state.tr.insertText("*", start, start)
      );
      expect(
        editorView.dom.querySelector(
          ".mt-inline-source-preview--strong"
        )?.textContent
      ).toBe("ddd");
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );

      expect(editorView.state.doc.textContent).toBe("ddd");
      expect(
        editorView.state.doc.firstChild?.firstChild?.marks[0].type.name
      ).toBe("strong");
      expect(editorView.dom.querySelector("strong")?.textContent).toBe(
        "ddd"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("upgrades rendered emphasis to strong after re-entering its source", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const editorView = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      for (const character of "*ddd*") {
        const caret = editorView.state.selection.from;
        editorView.dispatch(
          editorView.state.tr.insertText(character, caret, caret)
        );
      }
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(editorView.state.doc.textContent).toBe("ddd");

      const afterText = 4;
      editorView.dispatch(
        editorView.state.tr.setSelection(
          TextSelection.create(editorView.state.doc, afterText)
        )
      );
      expect(editorView.state.doc.textContent).toBe("*ddd*");

      editorView.dispatch(
        editorView.state.tr.insertText("*", 1, 1)
      );
      const sourceEnd = 6;
      editorView.someProp("handleTextInput", (handler) =>
        handler(editorView, sourceEnd, sourceEnd, "*", () =>
          editorView.state.tr
        )
      );
      editorView.dispatch(
        editorView.state.tr.insertText("*", sourceEnd, sourceEnd)
      );
      expect(editorView.state.doc.textContent).toBe("**ddd**");
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );

      expect(editorView.state.doc.textContent).toBe("ddd");
      expect(
        editorView.state.doc.firstChild?.firstChild?.marks.map(
          (mark) => mark.type.name
        )
      ).toEqual(["strong"]);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("renders the repaired format when clicking another line's syntax", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const editorView = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const schema = editorView.state.schema;
      const emphasis = schema.marks.emphasis.create();
      const strong = schema.marks.strong.create();
      const doc = schema.nodes.doc.create(null, [
        schema.nodes.paragraph.create(
          null,
          schema.text("ddd", [emphasis])
        ),
        schema.nodes.paragraph.create(
          null,
          schema.text("eee", [strong])
        ),
      ]);
      editorView.dispatch(
        editorView.state.tr.replaceWith(
          0,
          editorView.state.doc.content.size,
          doc.content
        )
      );
      editorView.dispatch(
        editorView.state.tr.setSelection(
          TextSelection.create(editorView.state.doc, 2)
        )
      );
      expect(editorView.state.doc.firstChild?.textContent).toBe(
        "*ddd*"
      );

      editorView.dispatch(
        editorView.state.tr.insertText("*", 1, 1)
      );
      editorView.dispatch(
        editorView.state.tr.insertText("*", 6, 6)
      );
      expect(editorView.state.doc.firstChild?.textContent).toBe(
        "**ddd**"
      );

      const otherLineSyntax =
        editorView.dom.querySelector("strong")!;
      otherLineSyntax.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: false })
      );
      const secondTextPos =
        editorView.state.doc.child(0).nodeSize + 1;
      editorView.dispatch(
        editorView.state.tr
          .setSelection(
            TextSelection.create(
              editorView.state.doc,
              secondTextPos
            )
          )
          .setMeta("pointer", true)
      );
      otherLineSyntax.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(editorView.state.doc.firstChild?.textContent).toBe("ddd");
      expect(
        editorView.state.doc.firstChild?.firstChild?.marks.map(
          (mark) => mark.type.name
        )
      ).toEqual(["strong"]);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
