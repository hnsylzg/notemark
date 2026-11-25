import { afterEach, describe, expect, it } from "vitest";
import { getMermaidConfig, MERMAID_FONT_FAMILY } from "./mermaid-renderer";

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
});

describe("Mermaid theme boundary", () => {
  it("uses theme colors while keeping font and graph geometry fixed", () => {
    document.documentElement.dataset.theme = "light";
    const root = document.createElement("div");
    root.className = "milkdown";
    const diagram = document.createElement("div");
    diagram.className = "diagram";
    diagram.style.setProperty("--mermaid-theme", "neutral");
    diagram.style.setProperty("--mermaid-font-family", '"Test Serif"');
    diagram.style.setProperty("--mermaid-look", "neo");
    diagram.style.setProperty("--mermaid-layout", "elk");
    diagram.style.setProperty("--mermaid-flowchart-curve", "linear");
    diagram.style.setProperty("--mermaid-flowchart-html-labels", "true");
    diagram.style.setProperty("--mermaid-flowchart-node-spacing", "120");
    diagram.style.setProperty("--mermaid-flowchart-rank-spacing", "140");
    root.appendChild(diagram);
    document.body.appendChild(root);

    expect(getMermaidConfig()).toEqual({
      startOnLoad: false,
      theme: "neutral",
      look: "classic",
      layout: "dagre",
      fontFamily: MERMAID_FONT_FAMILY,
      htmlLabels: false,
      flowchart: { look: "classic" },
    });
  });
});
