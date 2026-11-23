import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, setMarkdown } from "./index";
import { getExportHtml } from "./exporter";

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

const MARKMAP_MARKDOWN = [
  "```markmap",
  "# Linux",
  "",
  "## init",
  "- Systemd",
  "- OpenRC",
  "```",
].join("\n");

describe("Markmap code blocks", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("renders a Markmap preview and toggles its source editor", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, MARKMAP_MARKDOWN);
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      expect(view.state.doc.firstChild?.attrs.language).toBe("markmap");

      await vi.waitFor(
        () => {
          expect(
            root.querySelector(".milkdown-code-block .markmap-preview svg")
          ).not.toBeNull();
        },
        { timeout: 5000 }
      );
      expect(
        root.querySelector(".milkdown-code-block.markmap-code-block")
      ).not.toBeNull();
      expect(
        root.querySelector(".milkdown-code-block .codemirror-host.hidden")
      ).not.toBeNull();
      expect(
        root.querySelector(".preview-toggle-button")?.textContent?.trim()
      ).toBe("");

      root.querySelector<HTMLElement>(".markmap-preview")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      await vi.waitFor(() => {
        expect(
          root.querySelector(
            ".milkdown-code-block.is-editing-markmap-source"
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
            ".milkdown-code-block.is-editing-markmap-source"
          )
        ).toBeNull();
        expect(
          root.querySelector(".milkdown-code-block .codemirror-host.hidden")
        ).not.toBeNull();
      });
    } finally {
      await editor.destroy();
      root.remove();
    }
  }, 10000);

  it("re-renders the Markmap preview when the editor theme changes", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, MARKMAP_MARKDOWN);
      await vi.waitFor(() => {
        expect(root.querySelector(".markmap-preview svg style")).not.toBeNull();
      });
      const style = root.querySelector<SVGStyleElement>(
        ".markmap-preview svg style"
      )!;
      const lightLength = style.textContent?.length ?? 0;

      document.documentElement.dataset.theme = "dark";
      await vi.waitFor(() => {
        const current = root.querySelector<SVGStyleElement>(
          ".markmap-preview svg style"
        );
        expect(current?.textContent?.length ?? 0).toBeGreaterThan(lightLength);
      });
    } finally {
      await editor.destroy();
      root.remove();
    }
  }, 10000);

  it("replaces Mermaid and Markmap blocks with SVG in export snapshots", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(
        editor,
        [
          "```mermaid",
          "flowchart LR",
          "A --> B",
          "```",
          "",
          MARKMAP_MARKDOWN,
        ].join("\n")
      );

      const html = await getExportHtml(editor);
      const parsed = new DOMParser().parseFromString(html, "text/html");
      expect(parsed.querySelectorAll(".mermaid-preview svg")).toHaveLength(1);
      expect(parsed.querySelectorAll(".markmap-preview svg")).toHaveLength(1);
      expect(
        parsed.querySelector(
          '.markmap-preview svg > rect[style*="var(--mm-bg)"]'
        )
      ).toBeNull();
      expect(parsed.querySelector(".milkdown-code-block")).toBeNull();
    } finally {
      await editor.destroy();
      root.remove();
    }
  }, 10000);

  it("selects markmap from the language picker", async () => {
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
      root.querySelector<HTMLButtonElement>(".language-button")!.click();
      await vi.waitFor(() => {
        expect(
          root.querySelector(".language-picker .search-input")
        ).not.toBeNull();
      });
      const search = root.querySelector<HTMLInputElement>(
        ".language-picker .search-input"
      )!;
      search.value = "markmap";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.waitFor(() => {
        const markmap = root.querySelector<HTMLElement>(
          '.language-list-item[data-language="markmap"]'
        );
        expect(markmap?.hidden).toBe(false);
        expect(markmap?.classList.contains("is-keyboard-active")).toBe(true);
      });
      search.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );

      await vi.waitFor(() => {
        expect(view.state.doc.firstChild?.attrs.language).toBe("markmap");
        expect(root.querySelector(".markmap-preview svg")).not.toBeNull();
      });
    } finally {
      await editor.destroy();
      root.remove();
    }
  }, 10000);
});
