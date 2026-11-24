import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { describe, expect, it, vi } from "vitest";
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

describe("format menu with the application schema", () => {
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
