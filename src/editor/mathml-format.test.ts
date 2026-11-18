import { describe, expect, it } from "vitest";
import { formatMathMl, formatMathMlString } from "./mathml-format";

function mathElement(source: string): Element {
  const template = document.createElement("template");
  template.innerHTML = source;
  const math = template.content.querySelector("math");
  if (!math) throw new Error("missing math element");
  return math;
}

describe("MathML source formatting", () => {
  it("indents structure while keeping token and annotation content inline", () => {
    const formatted = formatMathMl(
      mathElement(
        '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi>F</mi><mo>(</mo><mi>x</mi><mo>)</mo></mrow><annotation encoding="application/x-tex">F(x)</annotation></semantics></math>'
      )
    );

    expect(formatted).toBe(
      [
        '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">',
        "  <semantics>",
        "    <mrow>",
        "      <mi>F</mi>",
        "      <mo>(</mo>",
        "      <mi>x</mi>",
        "      <mo>)</mo>",
        "    </mrow>",
        '    <annotation encoding="application/x-tex">F(x)</annotation>',
        "  </semantics>",
        "</math>",
      ].join("\n")
    );
  });

  it("escapes XML text without changing TeX backslashes", () => {
    const formatted = formatMathMl(
      mathElement(
        '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><annotation encoding="application/x-tex">\\frac{a}{b} &lt; c</annotation></semantics></math>'
      )
    );
    expect(formatted).toContain(String.raw`\frac{a}{b} &lt; c`);
    expect(formatted).not.toContain(String.raw`\\frac`);
  });

  it("removes MathJax semantic-analysis attributes from copied MathML", () => {
    const formatted = formatMathMlString(
      '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="x" data-semantic-type="identifier"><mi data-latex="x" data-semantic-id="0">x</mi></math>'
    );
    expect(formatted).toContain('data-latex="x"');
    expect(formatted).not.toContain("data-semantic-");
  });

  it("matches Typora by removing semantic operators and wrapper rows", () => {
    const formatted = formatMathMlString(
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mrow data-mjx-texclass="ORD" data-latex="\\mathcal{F}"><mi mathvariant="script">F</mi></mrow><mo>\u2061</mo><mrow><mi>f</mi></mrow></mrow></math>'
    );

    expect(formatted).not.toContain("\u2061");
    expect(formatted).toContain('data-latex="\\mathcal{F}"');
    expect(formatted.match(/<mrow/g)).toHaveLength(1);
  });

  it("serializes non-ASCII math symbols as XML character references", () => {
    const formatted = formatMathMlString(
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>\u03BE</mi><mo>\u222B</mo><mo>\u2212</mo><mi>\u221E</mi><mi>\u03C0</mi></math>'
    );

    expect(formatted).toContain("&#x3BE;");
    expect(formatted).toContain("&#x222B;");
    expect(formatted).toContain("&#x2212;");
    expect(formatted).toContain("&#x221E;");
    expect(formatted).toContain("&#x3C0;");
    expect(formatted).not.toContain("\u03BE");
  });
});
