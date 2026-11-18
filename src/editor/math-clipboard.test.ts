import { beforeEach, describe, expect, it, vi } from "vitest";
import { mathClipboardText, mathTex, mathToMathMl } from "./math-clipboard";

vi.mock("./mathjax", () => ({
  texToMathMl: vi.fn(async (tex: string, displayMode: boolean) =>
    `<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="${tex}"${
      displayMode ? ' display="block"' : ""
    }><mi>x</mi></math>`
  ),
}));

describe("inline math clipboard", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("reads the exact TeX source without dollar delimiters", () => {
    const element = document.createElement("span");
    element.dataset.value = String.raw`\frac{a}{b}`;
    expect(mathTex(element)).toBe(String.raw`\frac{a}{b}`);
  });

  it("reads the live input value while the formula is being edited", () => {
    const element = document.createElement("span");
    element.className = "milkdown-math-inline is-editing";
    element.dataset.value = "x";
    const input = document.createElement("input");
    input.className = "milkdown-math-inline-input";
    input.value = "$x^2$";
    element.appendChild(input);

    expect(mathTex(element)).toBe("x^2");
  });

  it("reads the live block-formula textarea", () => {
    const element = document.createElement("div");
    element.className = "milkdown-math-block is-editing";
    element.dataset.value = "x";
    const textarea = document.createElement("textarea");
    textarea.className = "math-block-editor";
    textarea.value = String.raw`\sum_{i=1}^n i`;
    element.appendChild(textarea);

    expect(mathTex(element)).toBe(String.raw`\sum_{i=1}^n i`);
  });

  it("formats MathJax MathML and keeps its source attributes", async () => {
    const mathml = await mathToMathMl(String.raw`x^2 + y^2`);
    expect(mathml.startsWith("<math")).toBe(true);
    expect(mathml).toContain("</math>");
    expect(mathml).not.toContain("<span");
    expect(mathml).toContain('data-latex="x^2 + y^2"');
    expect(mathml).toContain("\n  <mi>x</mi>");
  });

  it("uses block MathML display mode for block formulas", async () => {
    const mathml = await mathToMathMl(String.raw`\sum_{i=1}^n i`, true);
    expect(mathml).toContain('display="block"');
  });

  it("copies raw MathML text for Word like Typora", async () => {
    const tex = String.raw`\mathcal{F}`;
    const text = await mathClipboardText(tex, "word");

    expect(text).toBe(
      `<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="${tex}"><mi>x</mi></math>`
    );
  });

  it("keeps formatted MathML for the explicit MathML action", async () => {
    const text = await mathClipboardText(String.raw`x^2`, "mathml");

    expect(text).toContain("\n  <mi>x</mi>");
  });
});
