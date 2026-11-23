import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { describe, expect, it, vi } from "vitest";
import { createEditor, setMarkdown } from "./index";

class ImmediateObserver {
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    queueMicrotask(() => {
      this.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
    });
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.IntersectionObserver = ImmediateObserver;
if (!globals.ResizeObserver) globals.ResizeObserver = ImmediateObserver;

Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
  configurable: true,
  value() {
    return (this.textContent ?? "").length * 8;
  },
});
Object.defineProperty(SVGElement.prototype, "getBBox", {
  configurable: true,
  value() {
    return { x: 0, y: 0, width: 120, height: 40 };
  },
});

describe("real Mermaid code block preview", () => {
  it("renders every Mermaid code block instead of leaving loading states", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const diagrams = Array.from(
        { length: 3 },
        (_, index) =>
          `\`\`\`mermaid\nflowchart LR\nA${index + 1} --> B${index + 1}\n\`\`\``
      );
      setMarkdown(editor, diagrams.join("\n\n"));
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      expect(view.state.doc.firstChild?.attrs.language).toBe("mermaid");
      expect(
        root.querySelectorAll(".milkdown-code-block.mermaid-code-block")
      ).toHaveLength(3);

      await vi.waitFor(
        () => {
          expect(root.querySelectorAll(".mermaid-preview svg")).toHaveLength(3);
        },
        { timeout: 5000 }
      );
      expect(root.textContent).not.toContain("正在渲染图表");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
