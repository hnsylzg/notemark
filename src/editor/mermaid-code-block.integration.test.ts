import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { describe, expect, it, vi } from "vitest";
import { createEditor, getMarkdown, setMarkdown } from "./index";

vi.mock("./mathjax", () => ({
  loadMathJax: vi.fn(async () => ({})),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><text>diagram</text></svg>',
    })),
  },
}));

class ImmediateObserver {
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    queueMicrotask(() => {
      this.callback(
        [
          {
            isIntersecting: true,
            target,
          } as IntersectionObserverEntry,
        ],
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

class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
const globals = globalThis as unknown as Record<string, unknown>;
globals.IntersectionObserver = ImmediateObserver;
if (!globals.ResizeObserver) globals.ResizeObserver = StubObserver;

describe("Mermaid code blocks", () => {
  it("keeps mermaid fences as code blocks with a language attribute", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);
    const markdown = "```mermaid\nflowchart LR\nA --> B\n```";

    try {
      await editor.create();
      setMarkdown(editor, markdown);
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const codeBlock = view.state.doc.firstChild;

      expect(codeBlock?.type.name).toBe("code_block");
      expect(codeBlock?.attrs.language).toBe("mermaid");
      expect(getMarkdown(editor).trim()).toBe(markdown);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("renders the diagram preview for a mermaid code block", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "```mermaid\nflowchart LR\nA --> B\n```");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;

      await vi.waitFor(() => {
        expect(
          root.querySelector(".milkdown-code-block .mermaid-preview svg")
        ).not.toBeNull();
      });
      expect(
        root.querySelector(".milkdown-code-block .codemirror-host.hidden")
      ).not.toBeNull();
      expect(
        root.querySelector(".milkdown-code-block.mermaid-code-block")
      ).not.toBeNull();
      expect(
        root.querySelector(".preview-toggle-button")?.textContent?.trim()
      ).toBe("");

      root.querySelector<HTMLElement>(".mermaid-preview")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      await vi.waitFor(() => {
        expect(
          root.querySelector(
            ".milkdown-code-block.is-editing-mermaid-source"
          )
        ).not.toBeNull();
        expect(
          root.querySelector(".milkdown-code-block .codemirror-host.hidden")
        ).toBeNull();
      });

      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true })
      );
      await vi.waitFor(() => {
        expect(
          root.querySelector(
            ".milkdown-code-block.is-editing-mermaid-source"
          )
        ).toBeNull();
        expect(
          root.querySelector(".milkdown-code-block .codemirror-host.hidden")
        ).not.toBeNull();
      });

      view.dispatch(
        view.state.tr.setNodeAttribute(0, "language", "javascript")
      );
      await vi.waitFor(() => {
        expect(root.querySelector(".mermaid-preview")).toBeNull();
        expect(
          root.querySelector(".milkdown-code-block .codemirror-host.hidden")
        ).toBeNull();
        expect(
          root.querySelector(".milkdown-code-block.mermaid-code-block")
        ).toBeNull();
      });
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("selects mermaid by typing it in the language picker", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "```javascript\nflowchart LR\nA --> B\n```");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;

      await vi.waitFor(() => {
        expect(
          root.querySelector(".language-button")?.textContent
        ).toContain("javascript");
      });
      root
        .querySelector<HTMLButtonElement>(".language-button")!
        .click();
      await vi.waitFor(() => {
        expect(
          root.querySelector(".language-picker .search-input")
        ).not.toBeNull();
      });
      const search = root.querySelector<HTMLInputElement>(
        ".language-picker .search-input"
      )!;
      search.value = "mer";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.waitFor(() => {
        const mermaid = root.querySelector<HTMLElement>(
          '.language-list-item[data-language="mermaid"]'
        );
        const javascript = root.querySelector<HTMLElement>(
          '.language-list-item[data-language="JavaScript"]'
        );
        expect(mermaid?.hidden).toBe(false);
        expect(mermaid?.classList.contains("is-keyboard-active")).toBe(true);
        expect(javascript?.hidden).toBe(true);
      });
      search.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );

      await vi.waitFor(() => {
        expect(view.state.doc.firstChild?.attrs.language).toBe("mermaid");
        expect(root.querySelector(".mermaid-preview svg")).not.toBeNull();
      });
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("navigates language results with the arrow keys", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "```javascript\nconst value = 1;\n```");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;

      await vi.waitFor(() => {
        expect(root.querySelector(".language-button")).not.toBeNull();
      });
      root
        .querySelector<HTMLButtonElement>(".language-button")!
        .click();
      await vi.waitFor(() => {
        expect(
          root.querySelector(".language-picker .search-input")
        ).not.toBeNull();
      });
      const search = root.querySelector<HTMLInputElement>(
        ".language-picker .search-input"
      )!;
      search.value = "java";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.waitFor(() => {
        expect(
          root.querySelector(
            '.language-list-item[data-language="Java"]'
          )
        ).not.toBeNull();
      });
      search.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        })
      );
      expect(
        root
          .querySelector(".language-list-item.is-keyboard-active")
          ?.getAttribute("data-language")
      ).toBe("Java");
      search.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );

      await vi.waitFor(() => {
        expect(view.state.doc.firstChild?.attrs.language).toBe("Java");
      });
    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
