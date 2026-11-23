import { describe, expect, it, vi } from "vitest";
import { languages } from "@codemirror/language-data";
import {
  CodeBlockLanguageLoader,
  calculateLanguagePickerPosition,
  createMermaidCodeBlockPreview,
} from "./code-block-view";

vi.mock("./mathjax", () => ({
  loadMathJax: vi.fn(async () => ({})),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text>diagram</text></svg>',
    })),
  },
}));

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

describe("Mermaid code block language", () => {
  it("keeps Mermaid in its normal language order", async () => {
    const loader = new CodeBlockLanguageLoader(languages);
    const names = loader.getAll().map((language) => language.name);
    const mermaidIndex = names.indexOf("mermaid");

    expect(mermaidIndex).toBeGreaterThan(names.indexOf("Markdown"));
    expect(mermaidIndex).toBeLessThan(names.indexOf("MS SQL"));
  });

  it("does not try to load a CM language for Mermaid", async () => {
    const loader = new CodeBlockLanguageLoader([]);

    await expect(loader.load("MERMAID")).resolves.toBeUndefined();
  });

  it("renders Mermaid previews only for the Mermaid language", async () => {
    const preview = createMermaidCodeBlockPreview();
    const apply = vi.fn();

    expect(preview.renderPreview("javascript", "const x = 1", apply)).toBeNull();
    expect(preview.renderPreview("mermaid", "", apply)).toBeNull();
    expect(
      preview.renderPreview("Mermaid", "flowchart LR\nA --> B", apply)
    ).toBeUndefined();

    await vi.waitFor(() => {
      expect(apply).toHaveBeenLastCalledWith(
        expect.stringContaining('class="diagram mermaid-preview"')
      );
    });
    preview.destroy();
  });
});
