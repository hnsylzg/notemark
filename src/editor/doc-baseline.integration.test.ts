import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { describe, expect, it } from "vitest";
import { createEditor, docEqualsBaseline, setMarkdown } from "./index";

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

describe("document baseline", () => {
  it("ignores generated heading IDs but detects content edits", async () => {
    const markdown = "# 标题\n\n正文";
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, markdown);
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;

      expect(view.state.doc.firstChild?.attrs.id).toBe("标题");
      expect(docEqualsBaseline(editor, markdown)).toBe(true);

      view.dispatch(view.state.tr.insertText("改", 1));
      expect(docEqualsBaseline(editor, markdown)).toBe(false);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
