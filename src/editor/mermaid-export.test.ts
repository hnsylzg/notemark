import { describe, expect, it } from "vitest";
import {
  DEFAULT_MERMAID_EXPORT_BACKGROUND,
  applyMermaidEdgeLabelBackground,
  normalizeMermaidSvgForExport,
  resolveMermaidExportBackground,
} from "./mermaid-export";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
  '<g class="edgeLabel"><rect width="40" height="20" style="fill:#28253D;opacity:0.5"/></g>' +
  "</svg>";

describe("Mermaid export", () => {
  it("normalizes edge label background in SVG strings", () => {
    const normalized = normalizeMermaidSvgForExport(SVG, "#ffffff");
    const parsed = new DOMParser().parseFromString(
      normalized,
      "image/svg+xml"
    );
    const rect = parsed.querySelector(".edgeLabel rect");

    expect(rect?.getAttribute("fill")).toBe("#ffffff");
    expect(rect?.getAttribute("opacity")).toBe("1");
  });

  it("normalizes a cloned SVG used by copy-as-image", () => {
    const host = document.createElement("div");
    host.innerHTML = SVG;
    const svg = host.querySelector("svg");
    expect(svg).toBeTruthy();

    applyMermaidEdgeLabelBackground(svg!, "#fefefe");

    const rect = svg!.querySelector(".edgeLabel rect");
    expect(rect?.getAttribute("fill")).toBe("#fefefe");
    expect(rect?.getAttribute("opacity")).toBe("1");
  });

  it("resolves the active diagram background and uses white as fallback", () => {
    const diagram = document.createElement("div");
    diagram.style.setProperty("--mt-color-bg", "#fefefe");

    expect(resolveMermaidExportBackground(diagram)).toBe("#fefefe");
    expect(resolveMermaidExportBackground(null)).toBe(
      DEFAULT_MERMAID_EXPORT_BACKGROUND
    );
  });
});
