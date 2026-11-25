import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { describe, expect, it, vi } from "vitest";
import { createEditor, getMarkdown, setMarkdown } from "./index";
import { mergeMarkdown } from "./md-merge";

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

describe("format menu with the application schema", () => {
  it.each([
    ["**图片：**", "strong", "图片："],
    ["*图片：*", "em", "图片："],
    ["`图片：`", "code", "图片："],
    ["~~图片：~~", "del", "图片："],
    ["==图片：==", "mark.md-highlight", "图片："],
    ["<u>图片：</u>", "u", "图片："],
    ["图片：^2^", "sup", "图片：2"],
    ["图片：~2~", "sub", "图片：2"],
    ["<kbd>图片：</kbd>", "[data-inline-html-mark]", "图片："],
    ["[图片：](https://example.com)", "a[href]", "图片："],
  ])(
    "inserts a block after the whole %s paragraph",
    async (markdown, inlineSelector, expectedText) => {
      const root = document.createElement("div");
      root.className = "milkdown";
      document.body.appendChild(root);
      const editor = createEditor(root);

      try {
        await editor.create();
        setMarkdown(editor, markdown);
        const view = editor.action((ctx) =>
          ctx.get(editorViewCtx)
        ) as EditorView;
        const paragraph =
          view.dom.querySelector<HTMLElement>("p")!;
        const inline =
          paragraph.querySelector<HTMLElement>(inlineSelector)!;
        expect(inline).not.toBeNull();
        vi.spyOn(inline, "getBoundingClientRect").mockReturnValue({
          x: 0,
          y: 0,
          top: 0,
          right: 100,
          bottom: 20,
          left: 0,
          width: 100,
          height: 20,
          toJSON: () => ({}),
        });
        vi.spyOn(view, "posAtCoords").mockReturnValue({
          pos: view.posAtDOM(inline, 0, 1),
          inside: 1,
        });

        const rightClick = new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 2,
          buttons: 2,
          clientX: 110,
          clientY: 10,
        });
        view.dom.dispatchEvent(rightClick);
        view.dom.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: 110,
            clientY: 10,
          })
        );
        const item = (
          label: string,
          rootNode: ParentNode = document
        ) =>
          Array.from(
            rootNode.querySelectorAll<HTMLButtonElement>(
              ".mt-context-menu__item"
            )
          ).find(
            (candidate) =>
              candidate.querySelector(".mt-context-menu__label")
                ?.textContent === label
          );
        item("插入")!.click();
        const insertPanel = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".mt-context-menu__submenu"
          )
        ).find(
          (panel) => !panel.hidden && item("代码块", panel)
        );
        item("代码块", insertPanel)!.click();

        expect(view.state.doc.childCount).toBe(2);
        expect(view.state.doc.child(0).textContent).toBe(expectedText);
        expect(view.state.doc.child(1).type.name).toBe("code_block");
      } finally {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          })
        );
        await editor.destroy();
        root.remove();
      }
    }
  );

  it("enables paragraph insertion in a normal paragraph", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "正文");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const paragraph = view.dom.querySelector<HTMLElement>("p")!;
      const paragraphPos = view.posAtDOM(paragraph, 0, 1);
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: paragraphPos,
        inside: -1,
      });

      paragraph.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );
      const item = (label: string, rootNode: ParentNode = document) =>
        Array.from(
          rootNode.querySelectorAll<HTMLButtonElement>(
            ".mt-context-menu__item"
          )
        ).find(
          (candidate) =>
            candidate.querySelector(".mt-context-menu__label")
              ?.textContent === label
        );

      item("插入")?.click();
      const insertPanel = Array.from(
        document.querySelectorAll<HTMLElement>(".mt-context-menu__submenu")
      ).find((panel) => !panel.hidden && item("段落（下方）", panel));
      expect(insertPanel).toBeDefined();
      expect(item("段落（上方）", insertPanel)?.disabled).toBe(false);
      expect(item("段落（下方）", insertPanel)?.disabled).toBe(false);
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await editor.destroy();
      root.remove();
    }
  });

  it("does not serialize an inserted empty paragraph as a br placeholder", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "first\n\nsecond");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      expect(view.state.doc.childCount).toBe(2);
      const first = view.state.doc.firstChild!;

      view.dispatch(
        view.state.tr.insert(
          first.nodeSize,
          view.state.schema.nodes.paragraph.create()
        )
      );

      const markdown = getMarkdown(editor);
      expect(markdown).not.toContain("<br");
      expect(markdown).toContain("first");
      expect(markdown).toContain("second");
      expect(mergeMarkdown("first\n\nsecond", markdown)).toBe(
        "first\n\n\n\nsecond"
      );

      setMarkdown(editor, markdown);
      expect(view.state.doc.childCount).toBe(3);
      expect(view.state.doc.child(1).type.name).toBe("paragraph");
      expect(view.state.doc.child(1).textContent).toBe("");

      // 空段落必须可重复往返：源码模式切回、保存后重新打开都走
      // setMarkdown(相同 Markdown)，不能每轮再解析出一层空段落。
      const secondPass = getMarkdown(editor);
      setMarkdown(editor, secondPass);
      expect(view.state.doc.childCount).toBe(3);
      expect(view.state.doc.child(1).textContent).toBe("");

      const thirdPass = getMarkdown(editor);
      setMarkdown(editor, thirdPass);
      expect(view.state.doc.childCount).toBe(3);
      expect(view.state.doc.child(1).textContent).toBe("");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("keeps consecutive empty paragraphs stable across reloads", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "first\n\nsecond");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const first = view.state.doc.firstChild!;

      view.dispatch(
        view.state.tr.insert(
          first.nodeSize,
          view.state.schema.nodes.paragraph.create()
        )
      );
      const firstBlankPos = first.nodeSize;
      view.dispatch(
        view.state.tr.insert(
          firstBlankPos + 2,
          view.state.schema.nodes.paragraph.create()
        )
      );
      expect(view.state.doc.childCount).toBe(4);

      const markdown = getMarkdown(editor);
      setMarkdown(editor, markdown);
      expect(view.state.doc.childCount).toBe(4);

      const secondPass = getMarkdown(editor);
      setMarkdown(editor, secondPass);
      expect(view.state.doc.childCount).toBe(4);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("enables paragraph insertion around a table block", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "| A |\n| --- |\n| B |");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const cell = view.dom.querySelector<HTMLElement>("td")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: view.posAtDOM(cell, 0, 1),
        inside: -1,
      });

      cell.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );
      const item = (label: string, rootNode: ParentNode = document) =>
        Array.from(
          rootNode.querySelectorAll<HTMLButtonElement>(
            ".mt-context-menu__item"
          )
        ).find(
          (candidate) =>
            candidate.querySelector(".mt-context-menu__label")
              ?.textContent === label
        );

      item("插入")?.click();
      const insertPanel = Array.from(
        document.querySelectorAll<HTMLElement>(".mt-context-menu__submenu")
      ).find((panel) => !panel.hidden && item("段落（下方）", panel));
      expect(insertPanel).toBeDefined();
      const menuChildren = Array.from(insertPanel!.children);
      expect(
        menuChildren[0]?.classList.contains("mt-context-menu__sep")
      ).toBe(false);
      expect(
        menuChildren.at(-1)?.classList.contains("mt-context-menu__sep")
      ).toBe(false);
      expect(
        menuChildren.some(
          (child, index) =>
            index > 0 &&
            child.classList.contains("mt-context-menu__sep") &&
            menuChildren[index - 1].classList.contains(
              "mt-context-menu__sep"
            )
        )
      ).toBe(false);
      const paragraphBefore = item("段落（上方）", insertPanel)!;
      const paragraphAfter = item("段落（下方）", insertPanel)!;
      expect(paragraphBefore.disabled).toBe(false);
      expect(paragraphAfter.disabled).toBe(false);

      paragraphAfter.click();
      expect(view.state.doc.firstChild?.type.name).toBe("table");
      expect(view.state.doc.lastChild?.type.name).toBe("paragraph");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await editor.destroy();
      root.remove();
    }
  });
});
