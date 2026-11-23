import { describe, expect, it } from "vitest";
import {
  normalizeMermaidHslColors,
  normalizeMermaidSvgForExport,
} from "./mermaid-export";

describe("Mermaid Word HSL colors", () => {
  it("converts CSS and paint HSL colors to RGB", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      "<style>.task{fill:hsl(240, 90%, 100%);stroke:hsla(0, 0%, 0%, 0.5);}</style>",
      '<rect fill="hsl(60, 90%, 100%)" stroke="hsla(240, 50%, 50%, 0.8)"/>',
      "</svg>",
    ].join("");

    const output = normalizeMermaidHslColors(svg);
    expect(output).not.toContain("hsl(");
    expect(output).not.toContain("hsla(");
    expect(output).toContain("rgb(");
    expect(output).toContain("rgba(");
  });

  it("inlines Gantt grid line geometry and paint for Word", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<style>.grid .tick { stroke: hsl(0, 0%, 83%); opacity: 0.8; shape-rendering: crispEdges; }</style>',
      '<g class="grid"><g class="tick"><line stroke="currentColor" y2="-87"/></g></g>',
      "</svg>",
    ].join("");

    const output = normalizeMermaidHslColors(
      normalizeMermaidSvgForExport(svg, "#ffffff")
    );
    const line = new DOMParser()
      .parseFromString(output, "image/svg+xml")
      .querySelector(".grid .tick line");
    expect(line?.getAttribute("x1")).toBe("0");
    expect(line?.getAttribute("y1")).toBe("0");
    expect(line?.getAttribute("x2")).toBe("0");
    expect(line?.getAttribute("stroke")).toBe("rgb(212, 212, 212)");
    expect(line?.getAttribute("stroke-width")).toBe("1");
    expect(line?.getAttribute("shape-rendering")).toBe("crispEdges");
  });

  it("inlines state markers and removes path exponent notation", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      "<style>",
      "#chart .node circle.state-start{fill:#000000;stroke:#000000;}",
      "#chart .node circle.state-end{fill:#28253D;stroke:#ffffff;stroke-width:1.5;}",
      "#chart .end-state-inner{fill:#ffffff;stroke-width:1.5;}",
      "</style>",
      '<g class="node"><circle class="state-start" r="7" style="filter:url(#shadow)"/></g>',
      '<g class="node"><circle class="state-end" r="7"/>',
      '<path class="end-state-inner" d="M7 0 C7 4.286e-16 7 7 0 7"/></g>',
      '<g class="node" id="chart-state-root_end-1"><g class="outer-path" style="filter:url(#shadow)">',
      '<path d="M7 0 C7 7 -7 7 -7 0" fill="#ffffff" stroke="none"/>',
      '<path d="M7 0 C7 7 -7 7 -7 0" fill="none" stroke="#28253D" stroke-width="2"/>',
      '<g>',
      '<path d="M2.5 0 C2.5 2.5 -2.5 2.5 -2.5 0" fill="#28253D" stroke="none"/>',
      '<path d="M2.5 0 C2.5 2.5 -2.5 2.5 -2.5 0" fill="none" stroke="#28253D" stroke-width="2"/>',
      "</g></g></g>",
      "</svg>",
    ].join("");

    const output = normalizeMermaidSvgForExport(svg, "#ffffff");
    const parsed = new DOMParser().parseFromString(
      output,
      "image/svg+xml"
    );
    expect(parsed.querySelector(".state-start")?.getAttribute("fill")).toBe(
      "#000000"
    );
    expect(parsed.querySelector(".state-end")?.getAttribute("stroke")).toBe(
      "#ffffff"
    );
    expect(
      parsed.querySelector(".end-state-inner")?.getAttribute("stroke-width")
    ).toBe("1.5");
    expect(parsed.querySelector(".state-start")?.getAttribute("style")).not.toContain(
      "filter"
    );
    expect(
      parsed.querySelector(".outer-path")?.getAttribute("style")
    ).not.toContain("filter");
    const endMarkerCircles = parsed.querySelectorAll(".outer-path > circle");
    expect(endMarkerCircles).toHaveLength(2);
    expect(endMarkerCircles[0]?.getAttribute("fill")).toBe("#ffffff");
    expect(endMarkerCircles[1]?.getAttribute("fill")).toBe("#28253D");
    expect(parsed.querySelector("path")?.getAttribute("d")).not.toMatch(
      /[eE][-+]?\d/
    );
  });
});
