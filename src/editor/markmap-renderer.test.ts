import { afterEach, describe, expect, it } from "vitest";
import { renderMarkmapSvg } from "./markmap-renderer";

describe("Markmap renderer", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("renders Markdown as self-contained SVG without foreignObject", async () => {
    document.documentElement.dataset.theme = "light";
    const svg = await renderMarkmapSvg(
      [
        "# Linux",
        "",
        "## init",
        "- Systemd",
        "- OpenRC",
        "## slim",
        "- Xfce",
      ].join("\n")
    );
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");

    expect(parsed.documentElement.localName).toBe("svg");
    expect(parsed.querySelector("parsererror")).toBeNull();
    expect(parsed.querySelector("foreignObject")).toBeNull();
    expect(
      parsed.querySelector('svg > rect[style*="var(--mm-bg)"]')
    ).toBeNull();
    expect(parsed.documentElement.textContent).toContain("Linux");
    expect(parsed.documentElement.textContent).toContain("OpenRC");
  });

  it("uses dark theme tokens when the editor is dark", async () => {
    document.documentElement.dataset.theme = "dark";
    const svg = await renderMarkmapSvg("# Dark\n- branch");

    expect(svg).toContain("--mm-bg:");
    expect(svg).toMatch(/@media|<style>[\s\S]*--mm-bg:/);
  });
});
