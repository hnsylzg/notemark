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

const PIE_SOURCE = [
  "```mermaid",
  "pie title 市场份额",
  '    "Chrome" : 60',
  '    "Firefox" : 20',
  '    "Safari" : 10',
  '    "Edge" : 5',
  '    "Others" : 5',
  "```",
].join("\n");

function normalizeColor(value: string | null | undefined): string {
  const probe = document.createElement("span");
  probe.style.color = value ?? "";
  return probe.style.color;
}

function rectFill(rect: SVGRectElement): string | null {
  const style = rect.getAttribute("style") ?? "";
  return (
    rect.getAttribute("fill") ||
    /(?:^|;)fill:([^;]+)/.exec(style)?.[1]?.trim() ||
    null
  );
}

describe("Mermaid pie colors", () => {
  it("uses Redux colors and normalizes them for Word", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, PIE_SOURCE);
      await vi.waitFor(
        () => {
          expect(
            root.querySelectorAll(".mermaid-preview path.pieCircle")
          ).toHaveLength(5);
        },
        { timeout: 10000 }
      );
      const fills = Array.from(
        root.querySelectorAll<SVGPathElement>(
          ".mermaid-preview path.pieCircle"
        )
      ).map((path) => path.getAttribute("fill"));
      const legendFills = Array.from(
        root.querySelectorAll<SVGRectElement>(
          ".mermaid-preview .legend rect"
        )
      ).map(rectFill);

      expect(fills[0]).toBe("#ECECFE");
      expect(fills[1]).toBe("#E9E9F1");
      expect(legendFills.map(normalizeColor)).toEqual(
        fills.map(normalizeColor)
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
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pie");
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
        const embeddedSliceFills = Array.from(
          embeddedDoc.querySelectorAll<SVGPathElement>(
            "path.pieCircle"
          )
        ).map((path) => path.getAttribute("fill"));
        const embeddedLegendFills = Array.from(
          embeddedDoc.querySelectorAll<SVGRectElement>(
            ".legend rect"
          )
        ).map(rectFill);

        expect(embedded).not.toContain("hsl(");
        expect(embedded).not.toContain("hsla(");
        expect(embeddedLegendFills.map(normalizeColor)).toEqual(
          embeddedSliceFills.map(normalizeColor)
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
