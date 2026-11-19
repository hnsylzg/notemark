import { describe, expect, it } from "vitest";
import { calculateLanguagePickerPosition } from "./code-block-view";

const boundary = { top: 0, right: 1000, bottom: 800, left: 0 };

describe("language picker positioning", () => {
  it("keeps the original bottom-start position when it fits", () => {
    const trigger = { top: 300, right: 600, bottom: 324, left: 450 };

    expect(
      calculateLanguagePickerPosition(
        trigger,
        boundary,
        { width: 240, height: 200 },
        12
      )
    ).toEqual({ left: 450, top: 324 });
  });

  it("shifts left only when bottom-start would overflow", () => {
    const trigger = { top: 100, right: 980, bottom: 124, left: 850 };

    expect(
      calculateLanguagePickerPosition(
        trigger,
        boundary,
        { width: 240, height: 300 },
        12
      )
    ).toEqual({ left: 748, top: 124 });
  });

  it("flips above when the lower side has less space", () => {
    const trigger = { top: 650, right: 980, bottom: 674, left: 850 };

    expect(
      calculateLanguagePickerPosition(
        trigger,
        boundary,
        { width: 240, height: 300 },
        12
      )
    ).toEqual({ left: 748, top: 350 });
  });

  it("clamps both axes to the editor viewport", () => {
    const trigger = { top: 250, right: 500, bottom: 275, left: 450 };

    expect(
      calculateLanguagePickerPosition(
        trigger,
        { top: 0, right: 300, bottom: 300, left: 0 },
        { width: 320, height: 400 },
        12
      )
    ).toEqual({ left: 12, top: 12 });
  });
});
