import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { describe, expect, it } from "vitest";
import { createEditor, getMarkdown, setMarkdown } from "./index";

class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
const globals = globalThis as unknown as Record<string, unknown>;
if (!globals.IntersectionObserver) globals.IntersectionObserver = StubObserver;
if (!globals.ResizeObserver) globals.ResizeObserver = StubObserver;

function typePlainText(view: EditorView, text: string): void {
  for (const character of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, from, to, character, () => view.state.tr)
    );
    if (!handled) {
      view.dispatch(view.state.tr.insertText(character, from, to));
    }
  }
}

describe("headings as the first block of a list item", () => {
  it.each([
    ["- ### 无序标题", 3],
    ["1. ### 有序标题", 3],
  ])("round-trips %s without inserting an empty paragraph", async (source, level) => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, source);
      const listItem = editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        return view.state.doc.firstChild?.firstChild;
      });

      expect(listItem?.firstChild?.type.name).toBe("heading");
      expect(listItem?.firstChild?.attrs.level).toBe(level);
      expect(getMarkdown(editor).trim()).toBe(source);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it.each(["- ### 无序标题", "1. ### 有序标题"])(
    "creates a heading while typing %s",
    async (source) => {
      const root = document.createElement("div");
      root.className = "milkdown";
      document.body.appendChild(root);
      const editor = createEditor(root);

      try {
        await editor.create();
        const view = editor.action((ctx) =>
          ctx.get(editorViewCtx)
        ) as EditorView;
        typePlainText(view, source);

        expect(
          view.state.doc.firstChild?.firstChild?.firstChild?.type.name
        ).toBe("heading");
        expect(getMarkdown(editor).trim()).toBe(source);
      } finally {
        await editor.destroy();
        root.remove();
      }
    }
  );

  it("keeps GFM task-list state after changing the list item content model", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "- [x] 已完成");
      const listItem = editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        return view.state.doc.firstChild?.firstChild;
      });

      expect(listItem?.attrs.checked).toBe(true);
      expect(getMarkdown(editor).trim()).toBe("- [x] 已完成");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
