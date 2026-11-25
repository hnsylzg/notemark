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
});
