import { describe, expect, it } from "vitest";
import { inlineMarkmapSvgTheme } from "./markmap-export";

describe("Markmap Word export SVG", () => {
  it("inlines theme variables used by lines and text", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">',
      "<style>.markmap{--mm-text:#112233;--mm-branch-0:#abcdef;}</style>",
      '<path d="M10 50 H190" style="fill:none;stroke:var(--mm-branch-0);stroke-width:4"/>',
      '<text><tspan style="fill:var(--mm-text)">Linux</tspan></text>',
      "</svg>",
    ].join("");

    const output = inlineMarkmapSvgTheme(svg);
    const doc = new DOMParser().parseFromString(
      output,
      "image/svg+xml"
    );
    const path = doc.querySelector("path");
    const span = doc.querySelector("tspan");

    expect(output).not.toContain("var(--mm-");
    expect(doc.querySelector("style")).toBeNull();
    expect(path?.getAttribute("style")).toContain("stroke:#abcdef");
    expect(span?.getAttribute("style")).toContain("fill:#112233");
  });
});
