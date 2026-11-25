import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEditor, setMarkdown } from "./index";

class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
const globals = globalThis as unknown as Record<string, unknown>;
if (!globals.IntersectionObserver) globals.IntersectionObserver = StubObserver;
if (!globals.ResizeObserver) globals.ResizeObserver = StubObserver;

describe("theme structural spacing", () => {
  it("keeps list item paragraphs compact under external theme margins", () => {
    const themeCss = readFileSync(
      resolve(process.cwd(), "src/editor/theme/index.css"),
      "utf8"
    );
    const baseStyle = document.createElement("style");
    baseStyle.textContent = themeCss;
    const externalTheme = document.createElement("style");
    externalTheme.textContent = ".milkdown p{margin:0 0 1em}";
    document.head.append(baseStyle, externalTheme);
    const root = document.createElement("div");
    root.className = "milkdown";
    root.innerHTML =
      '<div class="editor">' +
      '<div class="milkdown-list-item-block">' +
      '<div class="list-item"><div class="children">' +
      '<div class="content-dom">' +
      "<p>item</p><ul><li>nested</li></ul>" +
      "</div>" +
      "</div></div></div></div>";
    const editorRoot = root.querySelector<HTMLElement>(".editor")!;
    const secondItem = document.createElement("div");
    secondItem.className = "milkdown-list-item-block";
    secondItem.innerHTML =
      '<div class="list-item"><div class="children">' +
      '<div class="content-dom"><p>second</p></div>' +
      "</div></div>";
    editorRoot.appendChild(secondItem);
    document.body.appendChild(root);

    try {
      const paragraph = root.querySelector(".content-dom > p")!;
      const nestedList = root.querySelector(".content-dom > ul")!;
      expect(getComputedStyle(paragraph).marginBottom).toBe("0px");
      expect(
        parseFloat(getComputedStyle(nestedList).marginBlockStart)
      ).toBeGreaterThan(0);
      expect(getComputedStyle(nestedList).marginBlockEnd).toBe("0px");
      expect(parseFloat(getComputedStyle(secondItem).marginTop)).toBeGreaterThan(
        0
      );
    } finally {
      root.remove();
      baseStyle.remove();
      externalTheme.remove();
    }
  });

  it("matches the real Milkdown list content DOM", async () => {
    const themeCss = readFileSync(
      resolve(process.cwd(), "src/editor/theme/index.css"),
      "utf8"
    );
    const baseStyle = document.createElement("style");
    baseStyle.textContent = themeCss;
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);
    const externalTheme = document.createElement("style");
    externalTheme.textContent =
      ".milkdown p{margin:0 0 1em}";
    document.head.append(baseStyle, externalTheme);

    try {
      await editor.create();
      setMarkdown(editor, "- 第一项\n- 第二项\n  - 嵌套项");
      const paragraphs = Array.from(
        root.querySelectorAll<HTMLElement>(
          ".milkdown-list-item-block .content-dom > p"
        )
      );
      expect(paragraphs.length).toBeGreaterThan(0);
      for (const paragraph of paragraphs) {
        expect(getComputedStyle(paragraph).marginBottom).toBe("0px");
      }
    } finally {
      await editor.destroy();
      baseStyle.remove();
      externalTheme.remove();
      root.remove();
    }
  });
});
