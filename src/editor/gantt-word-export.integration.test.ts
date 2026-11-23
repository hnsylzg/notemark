import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { buildDocx } from "./docxExporter";
import { createEditor, setMarkdown } from "./index";
import { getWordExportSource } from "./exporter";

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
    return { x: 0, y: 0, width: 120, height: 20 };
  },
});

describe("Gantt Word export", () => {
  it("normalizes real Mermaid HSL colors while preserving text", async () => {
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
          "gantt",
          "    title 项目时间线",
          "    dateFormat  YYYY-MM-DD",
          "    section 项目阶段",
          "       需求分析 :done, des1, 2024-12-01, 2024-12-07",
          "       设计阶段 :active, des2, after des1, 7d",
          "       开发阶段 :des3, after des2, 14d",
          "```",
        ].join("\n")
      );

      await vi.waitFor(
        () => {
          expect(root.querySelector(".mermaid-preview svg")).not.toBeNull();
        },
        { timeout: 10000 }
      );

      vi.stubGlobal(
        "Image",
        class {
          naturalWidth = 200;
          naturalHeight = 100;
          onload: (() => void) | null = null;
          onerror: (() => void) | null = null;

          set src(_value: string) {
            queueMicrotask(() => this.onload?.());
          }
        }
      );
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:gantt");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(
        () => undefined
      );
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: vi.fn(() => ({ drawImage: vi.fn() })),
      });
      Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
        configurable: true,
        value: vi.fn((callback: BlobCallback) => {
          callback(
            new Blob([new Uint8Array([1, 2, 3])], {
              type: "image/png",
            })
          );
        }),
      });

      try {
        const bytes = await buildDocx(getWordExportSource(editor));
        const zip = await JSZip.loadAsync(bytes);
        const svgName = Object.keys(zip.files).find(
          (name) =>
            name.startsWith("word/media/") && name.endsWith(".svg")
        );
        expect(svgName).toBeDefined();
        const embedded = await zip.file(svgName!)!.async("string");
        const embeddedDoc = new DOMParser().parseFromString(
          embedded,
          "image/svg+xml"
        );

        expect(embedded).not.toContain("hsl(");
        expect(embedded).not.toContain("hsla(");
        const gridLines = embeddedDoc.querySelectorAll("g.grid line");
        expect(gridLines.length).toBeGreaterThan(0);
        expect(
          Array.from(gridLines).every(
            (line) =>
              (line.getAttribute("stroke") ?? "").toLowerCase() !==
              "currentcolor"
          )
        ).toBe(true);
        expect(
          Array.from(gridLines).every((line) =>
            Boolean(line.getAttribute("stroke")?.trim())
          )
        ).toBe(true);
        expect(
          Array.from(gridLines).every(
            (line) =>
              line.hasAttribute("x1") &&
              line.hasAttribute("y1") &&
              line.hasAttribute("x2") &&
              line.hasAttribute("stroke-width")
          )
        ).toBe(true);
        expect(embeddedDoc.documentElement.textContent).toContain(
          "项目时间线"
        );
      } finally {
        Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
          configurable: true,
          value: originalGetContext,
        });
        Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
          configurable: true,
          value: originalToBlob,
        });
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    } finally {
      await editor.destroy();
      root.remove();
    }
  }, 15000);
});
