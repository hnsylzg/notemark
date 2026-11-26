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
      "<p>item</p><p>second paragraph</p>" +
      "<ul><li>nested</li></ul><p>after nested</p>" +
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
      const paragraphs = root.querySelectorAll(".content-dom > p");
      const paragraph = paragraphs[0]!;
      const secondParagraph = paragraphs[1]!;
      const nestedList = root.querySelector(".content-dom > ul")!;
      const paragraphAfterNestedList = root.querySelector(
        ".content-dom > ul + p"
      )!;
      expect(getComputedStyle(paragraph).marginBlockStart).toBe("0px");
      expect(getComputedStyle(paragraph).marginBottom).toBe("0px");
      expect(
        parseFloat(getComputedStyle(secondParagraph).marginBlockStart)
      ).toBeGreaterThan(0);
      expect(getComputedStyle(secondParagraph).marginBottom).toBe("0px");
      expect(getComputedStyle(secondParagraph).marginBlockEnd).toBe("0px");
      expect(
        parseFloat(getComputedStyle(nestedList).marginBlockStart)
      ).toBeGreaterThan(0);
      expect(getComputedStyle(nestedList).marginBlockEnd).toBe("0px");
      expect(
        parseFloat(
          getComputedStyle(paragraphAfterNestedList).marginBlockStart
        )
      ).toBeGreaterThan(0);
      expect(
        getComputedStyle(paragraphAfterNestedList).marginBlockEnd
      ).toBe("0px");
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

  it("spaces multiple paragraphs inside a real list item", async () => {
    const themeCss = readFileSync(
      resolve(process.cwd(), "src/editor/theme/index.css"),
      "utf8"
    );
    const baseStyle = document.createElement("style");
    baseStyle.textContent = themeCss;
    const externalTheme = document.createElement("style");
    externalTheme.textContent = ".milkdown p{margin:0 0 1em}";
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);
    document.head.append(baseStyle, externalTheme);

    try {
      await editor.create();
      setMarkdown(editor, "- first\n\n  second\n- next");
      const firstItem = root.querySelector(".milkdown-list-item-block");
      expect(firstItem).not.toBeNull();
      const paragraphs = Array.from(
        firstItem!.querySelectorAll<HTMLElement>(".content-dom > p")
      );
      expect(paragraphs).toHaveLength(2);
      expect(getComputedStyle(paragraphs[0]!).marginBlockStart).toBe("0px");
      expect(
        parseFloat(getComputedStyle(paragraphs[1]!).marginBlockStart)
      ).toBeGreaterThan(0);
      expect(getComputedStyle(paragraphs[1]!).marginBottom).toBe("0px");
      expect(getComputedStyle(paragraphs[1]!).marginBlockEnd).toBe("0px");
    } finally {
      await editor.destroy();
      baseStyle.remove();
      externalTheme.remove();
      root.remove();
    }
  });

  it("spaces an optional continuation paragraph after a nested list", async () => {
    const themeCss = readFileSync(
      resolve(process.cwd(), "src/editor/theme/index.css"),
      "utf8"
    );
    const baseStyle = document.createElement("style");
    baseStyle.textContent = themeCss;
    const externalTheme = document.createElement("style");
    externalTheme.textContent = ".milkdown p{margin:0 0 1em}";
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);
    document.head.append(baseStyle, externalTheme);

    try {
      await editor.create();
      setMarkdown(editor, "- parent\n  - nested\n\n  continuation");
      const firstItem = root.querySelector(".milkdown-list-item-block");
      expect(firstItem).not.toBeNull();
      const paragraph = firstItem!.querySelector<HTMLElement>(
        ".content-dom > ul + p"
      );
      expect(paragraph).not.toBeNull();
      expect(
        parseFloat(getComputedStyle(paragraph!).marginBlockStart)
      ).toBeGreaterThan(0);
      expect(getComputedStyle(paragraph!).marginBottom).toBe("0px");
    } finally {
      await editor.destroy();
      baseStyle.remove();
      externalTheme.remove();
      root.remove();
    }
  });

  it("uses Typora heading rhythm in the built-in theme", () => {
    const style = document.createElement("style");
    style.textContent = [
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/tokens.css"),
        "utf8"
      ),
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/base.css"),
        "utf8"
      ),
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/index.css"),
        "utf8"
      ),
    ].join("\n");
    document.head.appendChild(style);
    const root = document.createElement("div");
    root.className = "milkdown";
    root.innerHTML =
      '<div class="editor"><h1>One</h1><h2>Two</h2><h6>Six</h6></div>';
    document.body.appendChild(root);

    try {
      for (const heading of root.querySelectorAll("h1, h2, h6")) {
        const computed = getComputedStyle(heading);
        expect(computed.marginBlockStart).toBe("15px");
        expect(computed.marginBlockEnd).toBe("15px");
        expect(
          parseFloat(computed.lineHeight) / parseFloat(computed.fontSize)
        ).toBeCloseTo(1.4, 3);
      }
    } finally {
      root.remove();
      style.remove();
    }
  });

  it("lets Rose and Emerald inherit the built-in heading rhythm", () => {
    const baseCss = [
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/tokens.css"),
        "utf8"
      ),
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/base.css"),
        "utf8"
      ),
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/index.css"),
        "utf8"
      ),
    ].join("\n");

    for (const themeFile of ["rose.css", "emerald.css"]) {
      const style = document.createElement("style");
      style.textContent =
        baseCss +
        "\n" +
        readFileSync(resolve(process.cwd(), themeFile), "utf8");
      document.head.appendChild(style);
      const root = document.createElement("div");
      root.className = "milkdown";
      root.innerHTML = '<div class="editor"><h1>One</h1><h6>Six</h6></div>';
      document.body.appendChild(root);

      try {
        for (const heading of root.querySelectorAll("h1, h6")) {
          const computed = getComputedStyle(heading);
          expect(computed.marginBlockStart).toBe("15px");
          expect(computed.marginBlockEnd).toBe("15px");
          expect(
            parseFloat(computed.lineHeight) / parseFloat(computed.fontSize)
          ).toBeCloseTo(1.4, 3);
        }
      } finally {
        root.remove();
        style.remove();
      }
    }
  });

  it("shares article rhythm and inline-code spacing inside tables", () => {
    const baseCss = [
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/tokens.css"),
        "utf8"
      ),
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/base.css"),
        "utf8"
      ),
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/index.css"),
        "utf8"
      ),
    ].join("\n");

    for (const themeFile of [
      "github.css",
      "latex.css",
      "rose.css",
      "emerald.css",
      "forest.css",
    ]) {
      const paragraphMarginEm =
        themeFile === "forest.css"
          ? 0.5142857
          : themeFile === "latex.css"
            ? 0.175
            : themeFile === "github.css"
              ? 0.35
              : 0.4666667;
      const style = document.createElement("style");
      style.textContent =
        baseCss +
        "\n" +
        readFileSync(resolve(process.cwd(), themeFile), "utf8");
      document.head.appendChild(style);
      const root = document.createElement("div");
      root.className = "milkdown";
      root.innerHTML =
        '<div class="editor">' +
        "<p>正文 <code>outside</code></p>" +
        "<table><tbody><tr><td><p>单元格 <code>inside</code></p></td></tr></tbody></table>" +
        "</div>";
      document.body.appendChild(root);

      try {
        const article = root.querySelector<HTMLElement>(".editor > p")!;
        const cell = root.querySelector<HTMLElement>("td")!;
        const cellParagraph = cell.querySelector<HTMLElement>("p")!;
        const outsideCode = article.querySelector<HTMLElement>("code")!;
        const insideCode = cellParagraph.querySelector<HTMLElement>("code")!;

        expect(parseFloat(getComputedStyle(cell).lineHeight)).toBeCloseTo(
          parseFloat(getComputedStyle(article).lineHeight),
          3
        );
        expect(getComputedStyle(insideCode).paddingTop).toBe(
          getComputedStyle(outsideCode).paddingTop
        );
        expect(getComputedStyle(insideCode).paddingBottom).toBe(
          getComputedStyle(outsideCode).paddingBottom
        );
        expect(
          parseFloat(getComputedStyle(cell).paddingTop)
        ).toBeCloseTo(
          0,
          3
        );
        expect(
          parseFloat(getComputedStyle(cell).paddingBottom)
        ).toBeCloseTo(
          0,
          3
        );
        expect(
          parseFloat(getComputedStyle(cellParagraph).marginBlockStart)
        ).toBeCloseTo(
          parseFloat(getComputedStyle(root).fontSize) * paragraphMarginEm,
          3
        );
        if (themeFile === "github.css") {
          expect(getComputedStyle(cell).verticalAlign).not.toBe("top");
        }
      } finally {
        root.remove();
        style.remove();
      }
    }
  });

  it("keeps GitHub code blocks on the shared block rhythm", () => {
    const style = document.createElement("style");
    style.textContent = [
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/tokens.css"),
        "utf8"
      ),
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/base.css"),
        "utf8"
      ),
      readFileSync(
        resolve(process.cwd(), "src/editor/theme/index.css"),
        "utf8"
      ),
      readFileSync(resolve(process.cwd(), "github.css"), "utf8"),
    ].join("\n");
    document.head.appendChild(style);
    const root = document.createElement("div");
    root.className = "milkdown";
    root.innerHTML =
      '<div class="editor"><div class="milkdown-code-block"></div></div>';
    document.body.appendChild(root);

    try {
      const code = root.querySelector(".milkdown-code-block")!;
      expect(getComputedStyle(code).marginBlockStart).toBe("16px");
      expect(getComputedStyle(code).marginBlockEnd).toBe("16px");
    } finally {
      root.remove();
      style.remove();
    }
  });

});
