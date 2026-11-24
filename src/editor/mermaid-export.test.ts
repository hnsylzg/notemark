import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MERMAID_EXPORT_BACKGROUND,
  applyMermaidEdgeLabelBackground,
  ensureMermaidXlinkNamespace,
  normalizeMermaidSvgForExport,
  preserveMermaidIshikawaTextBaseline,
  preserveMermaidVennTitle,
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

  it("expands the viewBox so a venn-beta title is not clipped by Word", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" height="450" viewBox="0 0 800 450">' +
      "<style>.venn-title{font-size:32px;fill:#000000}</style>" +
      '<text class="venn-title" x="50%" y="16">Team overlap</text>' +
      '<circle cx="400" cy="213" r="198"/>' +
      "</svg>";
    const parsed = new DOMParser().parseFromString(
      source,
      "image/svg+xml"
    );

    preserveMermaidVennTitle(parsed.documentElement);

    expect(parsed.querySelector(".venn-title")?.getAttribute("y")).toBe("16");
    expect(parsed.documentElement.getAttribute("viewBox")).toBe(
      "0 0 800 466"
    );
    expect(parsed.documentElement.getAttribute("height")).toBe("466");
    const shifted = parsed.querySelector(
      'g[data-mermaid-export-offset="true"]'
    );
    expect(shifted?.getAttribute("transform")).toBe("translate(0 16)");
    expect(shifted?.querySelector(".venn-title")).not.toBeNull();
    expect(shifted?.querySelector("circle")).not.toBeNull();
  });

  it("keeps an already fitting venn title unchanged", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">' +
      "<style>.venn-title{font-size:32px}</style>" +
      '<text class="venn-title" x="50%" y="48">Team overlap</text>' +
      "</svg>";
    const parsed = new DOMParser().parseFromString(
      source,
      "image/svg+xml"
    );

    preserveMermaidVennTitle(parsed.documentElement);

    expect(parsed.querySelector(".venn-title")?.getAttribute("y")).toBe(
      "48"
    );
    expect(parsed.documentElement.getAttribute("viewBox")).toBe(
      "0 0 800 450"
    );
  });

  it("declares XLink before parsing a kanban ticket link SVG", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">' +
      '<a xlink:href="https://example.com/MC-2038">' +
      '<text>MC-2038</text></a></svg>';

    const withNamespace = ensureMermaidXlinkNamespace(source);
    expect(withNamespace).toContain(
      'xmlns:xlink="http://www.w3.org/1999/xlink"'
    );
    const parsed = new DOMParser().parseFromString(
      normalizeMermaidSvgForExport(withNamespace, "#ffffff"),
      "image/svg+xml"
    );

    expect(parsed.querySelector("parsererror")).toBeNull();
    expect(parsed.querySelector("a")?.getAttribute("xlink:href")).toBe(
      "https://example.com/MC-2038"
    );
  });

  it("uses explicit baseline offsets for Ishikawa labels in Word exports", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" aria-roledescription="ishikawa" viewBox="0 0 400 200">' +
      "<style>.ishikawa text{font-size:14px;font-family:Arial}" +
      ".ishikawa-label.cause{dominant-baseline:middle}" +
      ".ishikawa-label.down{dominant-baseline:hanging}</style>" +
      '<text class="ishikawa-head-label" x="0" y="10">Title</text>' +
      '<text class="ishikawa-label cause" x="20" y="50">Cause</text>' +
      '<text class="ishikawa-label align up" x="30" y="70">Up</text>' +
      '<text class="ishikawa-label align down" x="40" y="90">Down</text>' +
      "</svg>";
    const parsed = new DOMParser().parseFromString(
      source,
      "image/svg+xml"
    );
    const context = {
      font: "",
      textBaseline: "alphabetic",
      measureText() {
        return {
          alphabeticBaseline:
            this.textBaseline === "hanging" ? -11.2 : -4.2,
        } as TextMetrics;
      },
    };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(
        context as unknown as CanvasRenderingContext2D
      );

    try {
      preserveMermaidIshikawaTextBaseline(parsed.documentElement);

      expect(
        parsed.querySelector(".ishikawa-head-label")?.getAttribute("y")
      ).toBe("14.2");
      expect(
        parsed.querySelector(".ishikawa-label.cause")?.getAttribute("y")
      ).toBe("54.2");
      expect(
        parsed.querySelector(".ishikawa-label.up")?.getAttribute("y")
      ).toBe("70");
      expect(
        parsed.querySelector(".ishikawa-label.down")?.getAttribute("y")
      ).toBe("101.2");
      expect(
        parsed.querySelector(".ishikawa-label.cause")?.getAttribute("style")
      ).toContain("dominant-baseline: auto !important");
    } finally {
      getContext.mockRestore();
    }
  });

  it("does not alter text baselines for non-Ishikawa diagrams", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" aria-roledescription="flowchart" viewBox="0 0 400 200">' +
      '<text class="ishikawa-label cause" x="20" y="50">Cause</text>' +
      "</svg>";
    const parsed = new DOMParser().parseFromString(
      source,
      "image/svg+xml"
    );

    preserveMermaidIshikawaTextBaseline(parsed.documentElement);

    expect(
      parsed.querySelector("text")?.getAttribute("y")
    ).toBe("50");
  });

});
