import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Schema } from "@milkdown/kit/prose/model";
import { buildDocx } from "./docxExporter";

describe("State diagram Word export", () => {
  it("keeps start and end markers visible", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        text: { group: "inline" },
        code_block: {
          group: "block",
          content: "text*",
          marks: "",
          code: true,
          defining: true,
          attrs: { language: { default: "" } },
          toDOM: () => ["pre", 0],
        },
      },
    });
    const source = [
      "stateDiagram-v2",
      "    [*] --> 启动",
      "    启动 --> 运行中",
      "    停止 --> [*]",
    ].join("\n");
    const doc = schema.node("doc", null, [
      schema.node(
        "code_block",
        { language: "mermaid" },
        schema.text(source)
      ),
    ]);

    const viewDom = document.createElement("div");
    viewDom.innerHTML =
      '<div class="milkdown-code-block diagram-code-block mermaid-code-block">' +
      '<div class="diagram mermaid-preview">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="360" viewBox="0 0 340 360">' +
      "<style>" +
      "#chart .node circle.state-start{fill:#000000;stroke:#000000;}" +
      "#chart .node circle.state-end{fill:#28253D;stroke:#ffffff;stroke-width:1.5;}" +
      "#chart .end-state-inner{fill:#ffffff;stroke-width:1.5;}" +
      "</style>" +
      '<g class="node"><circle class="state-start" r="7" style="filter:url(#shadow)"/></g>' +
      '<g class="node"><circle class="state-end" r="7"/>' +
      '<path class="end-state-inner" d="M7 0 C7 4.286e-16 7 7 0 7"/>' +
      "</g>" +
      '<g class="node" id="chart-state-root_end-1"><g class="outer-path" style="filter:url(#shadow)">' +
      '<path d="M7 0 C7 7 -7 7 -7 0" fill="#ffffff" stroke="none"/>' +
      '<path d="M7 0 C7 7 -7 7 -7 0" fill="none" stroke="#28253D" stroke-width="2"/>' +
      "<g>" +
      '<path d="M2.5 0 C2.5 2.5 -2.5 2.5 -2.5 0" fill="#28253D" stroke="none"/>' +
      '<path d="M2.5 0 C2.5 2.5 -2.5 2.5 -2.5 0" fill="none" stroke="#28253D" stroke-width="2"/>' +
      "</g></g></g>" +
      "</svg></div></div>";

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
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:state");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
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
      const bytes = await buildDocx({ doc, viewDom });
      const zip = await JSZip.loadAsync(bytes);
      const svgName = Object.keys(zip.files).find(
        (name) =>
          name.startsWith("word/media/") && name.endsWith(".svg")
      );
      expect(svgName).toBeDefined();
      const embedded = await zip.file(svgName!)!.async("string");
      const parsed = new DOMParser().parseFromString(
        embedded,
        "image/svg+xml"
      );

      expect(parsed.querySelector(".state-start")?.getAttribute("fill")).toBe(
        "#000000"
      );
      expect(parsed.querySelector(".state-end")?.getAttribute("fill")).toBe(
        "#28253D"
      );
      expect(
        parsed.querySelector(".end-state-inner")?.getAttribute("fill")
      ).toBe("#ffffff");
      expect(parsed.querySelector(".state-start")?.getAttribute("style")).not.toContain(
        "filter"
      );
      expect(
        parsed.querySelector(".outer-path")?.getAttribute("style")
      ).not.toContain("filter");
      expect(parsed.querySelectorAll(".outer-path > circle")).toHaveLength(2);
      expect(parsed.querySelector("path")?.getAttribute("d")).not.toMatch(
        /[eE][-+]?\d/
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
  });
});
