import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { describe, expect, it } from "vitest";
import { createEditor, setMarkdown } from "./index";

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

describe("code syntax highlighting", () => {
  it("creates highlighted token spans for a fenced code block", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "```python\ndef hello():\n    return 1\n```\n");
      const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;

      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        if (view.dom.querySelector(".cm-content span.tok-keyword")) break;
      }

      const content = view.dom.querySelector(".cm-content");
      expect(content).not.toBeNull();
      expect(content?.querySelector(".tok-keyword")?.textContent).toBe("def");
      expect(content?.querySelector(".tok-function")?.textContent).toContain(
        "hello"
      );
      const runtimeCss = Array.from(document.head.querySelectorAll("style"))
        .map((style) => style.textContent ?? "")
        .join("\n");
      expect(runtimeCss).not.toContain("var(--mt-token-keyword)");

    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
