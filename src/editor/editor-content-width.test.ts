import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_CONTENT_WIDTH,
  applyEditorContentWidth,
  loadEditorContentWidth,
  normalizeEditorContentWidth,
  saveEditorContentWidth,
} from "./editor-content-width";

describe("editor content width", () => {
  it("accepts only the supported width modes", () => {
    expect(normalizeEditorContentWidth("adaptive")).toBe("adaptive");
    expect(normalizeEditorContentWidth("full")).toBe("full");
    expect(normalizeEditorContentWidth("wide")).toBe(
      DEFAULT_EDITOR_CONTENT_WIDTH
    );
    expect(normalizeEditorContentWidth(null)).toBe(
      DEFAULT_EDITOR_CONTENT_WIDTH
    );
  });

  it("applies the selected mode as a data attribute", () => {
    const root = document.createElement("div");

    applyEditorContentWidth(root, "adaptive");
    expect(root.getAttribute("data-content-width")).toBe("adaptive");

    applyEditorContentWidth(root, "full");
    expect(root.getAttribute("data-content-width")).toBe("full");
  });

  it("persists the normalized mode", async () => {
    localStorage.removeItem("notemark:state:editorContentWidth");

    await saveEditorContentWidth("adaptive");

    expect(await loadEditorContentWidth()).toBe("adaptive");
    localStorage.removeItem("notemark:state:editorContentWidth");
  });

  it("lets explicit width modes override later external theme rules", () => {
    const themeCss = readFileSync(
      resolve(process.cwd(), "src/editor/theme/index.css"),
      "utf8"
    );
    const baseStyle = document.createElement("style");
    baseStyle.textContent = themeCss;
    const externalTheme = document.createElement("style");
    externalTheme.textContent =
      ".milkdown .editor{max-width:1012px}";
    document.head.append(baseStyle, externalTheme);
    const root = document.createElement("div");
    root.className = "milkdown";
    root.setAttribute("data-content-width", "full");
    const editor = document.createElement("div");
    editor.className = "editor";
    root.appendChild(editor);
    document.body.appendChild(root);

    try {
      expect(getComputedStyle(editor).maxWidth).toBe("100%");
    } finally {
      root.remove();
      baseStyle.remove();
      externalTheme.remove();
    }
  });
});
