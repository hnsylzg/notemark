import { describe, expect, it } from "vitest";
import {
  mathMlRequiresRasterFallback,
  mathMlToOmml,
} from "./mathml-to-omml";

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

function mathMl(content: string): string {
  return `<math xmlns="${MATHML_NS}">${content}</math>`;
}

describe("MathML to OMML math variants", () => {
  it("maps script characters to the native Word script math font", () => {
    const omml = mathMlToOmml(
      mathMl(
        '<mrow><mi mathvariant="script">F</mi><mo>(</mo><mi>f</mi><mo>)</mo></mrow>'
      )
    );

    expect(omml).toContain('<m:scr m:val="script"');
    expect(omml).toContain('<m:sty m:val="p"');
    expect(omml).toContain(">F</m:t>");
    expect(omml).not.toContain('m:val="undefined"');
    expect(omml).not.toContain("<m:nor");
  });

  it("combines inherited math variants with their weight and style", () => {
    const omml = mathMlToOmml(
      mathMl('<mstyle mathvariant="bold-script"><mi>F</mi></mstyle>')
    );

    expect(omml).toContain('<m:scr m:val="script"');
    expect(omml).toContain('<m:sty m:val="b"');
  });

  it("leaves ordinary formulas on the standard math font", () => {
    const omml = mathMlToOmml(mathMl("<mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow>"));

    expect(omml).not.toContain("<m:scr");
    expect(omml).not.toContain("undefined");
  });

  it("detects layout that cannot be represented faithfully in OMML", () => {
    const latexLogo = mathMl(
      '<mrow><mi>L</mi><mspace width="-.325em"></mspace><mpadded voffset="+.21em"><mi>A</mi></mpadded></mrow>'
    );
    const integral = mathMl(
      '<mrow><mi mathvariant="script">F</mi><mo>=</mo><msubsup><mo>∫</mo><mn>0</mn><mn>1</mn></msubsup></mrow>'
    );

    expect(mathMlRequiresRasterFallback(latexLogo)).toBe(true);
    expect(mathMlRequiresRasterFallback(integral)).toBe(false);
  });
});
