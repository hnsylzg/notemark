import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_FONT_SCALE,
  MAX_EDITOR_FONT_SCALE,
  MIN_EDITOR_FONT_SCALE,
  applyEditorFontScale,
  formatEditorFontScale,
  loadEditorFontScale,
  normalizeEditorFontScale,
  saveEditorFontScale,
  stepEditorFontScale,
} from "./editor-font-scale";

describe("editor font scale", () => {
  it("normalizes to 5% steps and keeps the supported range", () => {
    expect(normalizeEditorFontScale(1.12)).toBe(1.1);
    expect(normalizeEditorFontScale(0.5)).toBe(MIN_EDITOR_FONT_SCALE);
    expect(normalizeEditorFontScale(2)).toBe(MAX_EDITOR_FONT_SCALE);
    expect(normalizeEditorFontScale("large")).toBe(
      DEFAULT_EDITOR_FONT_SCALE
    );
  });

  it("moves one step at a time and formats the menu label", () => {
    expect(stepEditorFontScale(1, 1)).toBe(1.05);
    expect(stepEditorFontScale(1, -1)).toBe(0.95);
    expect(formatEditorFontScale(1.1)).toBe("110%");
  });

  it("scales the theme body and code sizes with the same ratio", () => {
    const style = document.createElement("style");
    style.textContent =
      ".milkdown{--mt-font-size-base:16px;--mt-code-font-size:13px}";
    document.head.appendChild(style);
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);

    try {
      const sizes = applyEditorFontScale(root, 1.1);

      expect(sizes).toEqual({
        body: "17.5px",
        code: "14.5px",
        source: "15.5px",
      });
      expect(root.style.getPropertyValue("--mt-font-size-base")).toBe(
        "17.5px"
      );
      expect(root.style.getPropertyValue("--mt-code-font-size")).toBe(
        "14.5px"
      );
    } finally {
      root.remove();
      style.remove();
    }
  });

  it("removes overrides when returning to the theme default", () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    root.style.setProperty("--mt-font-size-base", "18px");
    root.style.setProperty("--mt-code-font-size", "16px");

    const sizes = applyEditorFontScale(root, 1);

    expect(sizes).toEqual({ body: null, code: null, source: null });
    expect(root.style.getPropertyValue("--mt-font-size-base")).toBe("");
    expect(root.style.getPropertyValue("--mt-code-font-size")).toBe("");
  });

  it("persists the normalized scale", async () => {
    localStorage.removeItem("notemark:state:editorFontScale");

    await saveEditorFontScale(1.2);

    expect(await loadEditorFontScale()).toBe(1.2);
    localStorage.removeItem("notemark:state:editorFontScale");
  });
});
