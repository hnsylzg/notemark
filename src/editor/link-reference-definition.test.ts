import { editorViewCtx } from "@milkdown/kit/core";
import { GapCursor } from "@milkdown/kit/prose/gapcursor";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { describe, expect, it, vi } from "vitest";
import { createEditor, getMarkdown, setMarkdown } from "./index";
import {
  insertLinkReferenceDefinition,
  LINK_REFERENCE_DEFINITION_NAME,
  LINK_REFERENCE_MARK_NAME,
  parseLinkReferenceDefinitionSource,
} from "./link-reference-definition";
import { markSourceKey, startMarkSourceRange } from "./mark-source";

describe("link reference definitions", () => {
  it("parses and serializes Markdown reference definitions", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(
        editor,
        '正文\n\n[site]: https://example.com "示例"\n'
      );
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const definition = view.dom.querySelector(
        ".mt-link-reference-definition"
      );
      expect(
        definition?.querySelector<HTMLInputElement>(
          '[data-field="identifier"]'
        )?.value
      ).toBe("site");
      expect(
        definition?.querySelector<HTMLInputElement>(
          '[data-field="url"]'
        )?.value
      ).toBe("https://example.com");
      expect(
        definition?.querySelector<HTMLInputElement>(
          '[data-field="title"]'
        )?.value
      ).toBe("示例");
      expect(getMarkdown(editor)).toContain(
        '[site]: https://example.com "示例"'
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("resolves inline reference links from their definitions", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(
        editor,
        "[链接文字][site]\n\n[site]: https://example.com\n"
      );
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const link = view.dom.querySelector<HTMLAnchorElement>(
        'a[data-reference-label="site"]'
      );

      expect(link?.textContent).toBe("链接文字");
      expect(link?.getAttribute("href")).toBe("https://example.com");
      expect(getMarkdown(editor)).toContain("[链接文字][site]");
      expect(getMarkdown(editor)).toContain(
        "[site]: https://example.com"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("supports link text and reference identifier with the same name", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(
        editor,
        "[test][test]\n\n[test]: https://example.com\n"
      );
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const link = view.dom.querySelector<HTMLAnchorElement>(
        'a[data-reference-label="test"]'
      );

      expect(link?.textContent).toBe("test");
      expect(link?.getAttribute("href")).toBe("https://example.com");
      expect(getMarkdown(editor)).toContain("[test][test]");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it.each([
    ["普通链接", "[链接](https://example.com)\n", "link"],
    [
      "引用式链接",
      "[链接][site]\n\n[site]: https://example.com\n",
      LINK_REFERENCE_MARK_NAME,
    ],
  ])(
    "does not extend a %s when typing at its end",
    async (_label, markdown, markName) => {
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
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.create(view.state.doc, 3))
            .insertText("X", 3)
        );

        let typedMarks: readonly { type: { name: string } }[] = [];
        view.state.doc.descendants((node) => {
          if (node.isText && node.text?.includes("X")) {
            typedMarks = node.marks;
          }
        });
        expect(typedMarks.map((mark) => mark.type.name)).not.toContain(
          markName
        );
      } finally {
        await editor.destroy();
        root.remove();
      }
    }
  );

  it("inserts an empty definition editor", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;

      expect(insertLinkReferenceDefinition(view)).toBe(true);
      expect(view.state.doc.firstChild?.type.name).toBe(
        LINK_REFERENCE_DEFINITION_NAME
      );
      expect(view.state.doc.childCount).toBe(1);
      expect(view.state.doc.firstChild?.attrs).toMatchObject({
        identifier: "",
        url: "",
        title: null,
      });
      const definition = view.dom.querySelector(
        ".mt-link-reference-definition"
      );
      expect(definition?.classList.contains("is-empty")).toBe(true);
      expect(
        definition?.querySelector<HTMLInputElement>(
          '[data-field="identifier"]'
        )?.placeholder
      ).toBe("name");
      expect(
        definition?.querySelector<HTMLInputElement>(
          '[data-field="url"]'
        )?.placeholder
      ).toBe("input link url here");
      expect(
        definition?.querySelector<HTMLInputElement>(
          '[data-field="title"]'
        )?.placeholder
      ).toBe("title (optional)");
      expect(getMarkdown(editor)).toContain("[]: ");
      await vi.waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalled();
      });
      expect(document.activeElement).toBe(
        definition?.querySelector('[data-field="identifier"]')
      );
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoView
        );
      } else {
        Reflect.deleteProperty(
          HTMLElement.prototype,
          "scrollIntoView"
        );
      }
      await editor.destroy();
      root.remove();
    }
  });

  it("inserts before the current paragraph when invoked at its start", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "正文\n");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1)
        )
      );

      expect(insertLinkReferenceDefinition(view)).toBe(true);
      expect(view.state.doc.firstChild?.type.name).toBe(
        LINK_REFERENCE_DEFINITION_NAME
      );
      expect(view.state.doc.child(1).type.name).toBe("paragraph");
      expect(view.state.doc.child(1).textContent).toBe("正文");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("inserts before a bold paragraph after its inline source closes", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "**粗体**\n");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      startMarkSourceRange(view, "strong", 1, 3, 1);
      expect(markSourceKey.getState(view.state)?.markName).toBe("strong");

      vi.spyOn(view, "posAtCoords")
        .mockReturnValueOnce({ pos: 3, inside: -1 })
        .mockReturnValue({ pos: 1, inside: -1 });
      view.dom.querySelector("strong")!.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 10,
          clientY: 10,
        })
      );
      view.dom.querySelector("strong")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );
      expect(markSourceKey.getState(view.state)?.markName).toBe("strong");

      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".mt-context-menu__item"
        )
      ).find(
        (item) =>
          item.querySelector(".mt-context-menu__label")?.textContent ===
          "链接引用"
      );
      expect(button).not.toBeNull();
      button?.click();

      expect(view.state.doc.firstChild?.type.name).toBe(
        LINK_REFERENCE_DEFINITION_NAME
      );
      expect(view.state.doc.child(1).textContent).toBe("粗体");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await editor.destroy();
      root.remove();
    }
  });

  it("inserts at a top-level document boundary", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "正文\n");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const end = view.state.doc.content.size;
      view.dispatch(
        view.state.tr.setSelection(
          new GapCursor(view.state.doc.resolve(end))
        )
      );

      expect(insertLinkReferenceDefinition(view)).toBe(true);
      expect(view.state.doc.childCount).toBe(2);
      expect(view.state.doc.lastChild?.type.name).toBe(
        LINK_REFERENCE_DEFINITION_NAME
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("removes an empty definition after leaving the input", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      insertLinkReferenceDefinition(view);

      const definition = view.dom.querySelector(
        ".mt-link-reference-definition"
      )!;
      definition.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true })
      );
      await Promise.resolve();

      expect(
        view.state.doc.firstChild?.type.name
      ).toBe("paragraph");
      expect(view.dom.querySelector(
        ".mt-link-reference-definition"
      )).toBeNull();
      expect(getMarkdown(editor)).not.toContain("[]:");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("keeps a partially entered definition", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      insertLinkReferenceDefinition(view);

      const identifier = view.dom.querySelector<HTMLInputElement>(
        '.mt-link-reference-definition [data-field="identifier"]'
      )!;
      identifier.value = "test";
      identifier.dispatchEvent(
        new Event("input", { bubbles: true })
      );
      view.dom
        .querySelector(".mt-link-reference-definition")!
        .dispatchEvent(
          new FocusEvent("focusout", { bubbles: true })
        );
      await Promise.resolve();

      expect(
        view.state.doc.firstChild?.type.name
      ).toBe(LINK_REFERENCE_DEFINITION_NAME);
      expect(view.state.doc.firstChild?.attrs.identifier).toBe("test");
      expect(getMarkdown(editor)).toContain("[test]: ");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("moves a stale gap cursor after the saved definition", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      insertLinkReferenceDefinition(view);

      const identifier = view.dom.querySelector<HTMLInputElement>(
        '.mt-link-reference-definition [data-field="identifier"]'
      )!;
      identifier.value = "test";
      identifier.dispatchEvent(
        new Event("input", { bubbles: true })
      );
      view.dom
        .querySelector(".mt-link-reference-definition")!
        .dispatchEvent(
          new FocusEvent("focusout", { bubbles: true })
        );
      await Promise.resolve();

      expect(view.state.selection).not.toBeInstanceOf(GapCursor);
      expect(view.state.selection.$from.parent.type.name).toBe(
        "paragraph"
      );
      expect(view.state.doc.firstChild?.type.name).toBe(
        LINK_REFERENCE_DEFINITION_NAME
      );
      expect(view.state.doc.child(1).type.name).toBe("paragraph");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("allows the cursor before a definition block", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(
        editor,
        "正文\n\n[site]: https://example.com\n"
      );
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      let definitionPos = -1;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === LINK_REFERENCE_DEFINITION_NAME) {
          definitionPos = pos;
          return false;
        }
        return true;
      });
      expect(definitionPos).toBeGreaterThan(0);

      view.dispatch(
        view.state.tr.setSelection(
          new GapCursor(view.state.doc.resolve(definitionPos))
        )
      );

      expect(view.state.selection).toBeInstanceOf(GapCursor);
      expect(
        view.state.selection.$from.nodeAfter?.type.name
      ).toBe(LINK_REFERENCE_DEFINITION_NAME);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("updates definition attributes from the three input fields", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      insertLinkReferenceDefinition(view);

      const input = (field: string) =>
        view.dom.querySelector<HTMLInputElement>(
          `[data-field="${field}"]`
        )!;
      for (const [field, value] of [
        ["identifier", "test"],
        ["url", "https://example.com"],
        ["title", "示例"],
      ]) {
        const element = input(field);
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
      view.dom
        .querySelector(".mt-link-reference-definition")!
        .dispatchEvent(
          new FocusEvent("focusout", {
            bubbles: true,
          })
        );
      await Promise.resolve();

      expect(view.state.doc.firstChild?.attrs).toMatchObject({
        identifier: "test",
        label: "test",
        url: "https://example.com",
        title: "示例",
      });
      expect(
        view.dom
          .querySelector(".mt-link-reference-definition")
          ?.classList.contains("is-empty")
      ).toBe(false);
      expect(getMarkdown(editor)).toContain(
        '[test]: https://example.com "示例"'
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("marks the optional title as empty after leaving id and url", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      insertLinkReferenceDefinition(view);

      const input = (field: string) =>
        view.dom.querySelector<HTMLInputElement>(
          `.mt-link-reference-definition [data-field="${field}"]`
        )!;
      for (const [field, value] of [
        ["identifier", "test"],
        ["url", "https://example.com"],
      ]) {
        const element = input(field);
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }

      const definition = view.dom.querySelector(
        ".mt-link-reference-definition"
      )!;
      definition.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true })
      );
      await Promise.resolve();

      expect(definition.classList.contains("is-empty")).toBe(false);
      expect(definition.classList.contains("is-title-empty")).toBe(true);
      expect(getMarkdown(editor)).toContain(
        "[test]: https://example.com"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("keeps the field alive while typing consecutive characters", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      insertLinkReferenceDefinition(view);

      const field = view.dom.querySelector<HTMLInputElement>(
        '.mt-link-reference-definition [data-field="identifier"]'
      )!;
      const definition = field.closest(
        ".mt-link-reference-definition"
      );
      field.focus();

      for (const value of ["t", "te"]) {
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }

      expect(field.isConnected).toBe(true);
      expect(
        view.dom.querySelector(
          ".mt-link-reference-definition"
        )
      ).toBe(definition);
      expect(field.value).toBe("te");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("moves between fields with left and right arrows", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      insertLinkReferenceDefinition(view);

      const field = (name: string) =>
        view.dom.querySelector<HTMLInputElement>(
          `.mt-link-reference-definition [data-field="${name}"]`
        )!;
      const identifier = field("identifier");
      const url = field("url");
      const title = field("title");

      identifier.focus();
      identifier.setSelectionRange(0, 0);
      identifier.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        })
      );
      expect(document.activeElement).toBe(url);

      url.setSelectionRange(0, 0);
      url.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        })
      );
      expect(document.activeElement).toBe(title);

      title.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        })
      );
      expect(document.activeElement).toBe(url);

      url.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        })
      );
      expect(document.activeElement).toBe(identifier);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("moves out to the next paragraph with the right arrow", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      insertLinkReferenceDefinition(view);

      const title = view.dom.querySelector<HTMLInputElement>(
        '.mt-link-reference-definition [data-field="title"]'
      )!;
      title.focus();
      title.setSelectionRange(0, 0);
      title.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        })
      );

      expect(view.state.doc.childCount).toBe(1);
      expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
      expect(view.state.selection.$from.parent.type.name).toBe(
        "paragraph"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("inserts the definition from the context menu", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 1,
        inside: -1,
      });
      view.dom.querySelector("p")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".mt-context-menu__item"
        )
      ).find(
        (item) =>
          item.querySelector(".mt-context-menu__label")?.textContent ===
          "链接引用"
      );
      expect(button).not.toBeNull();
      button?.click();

      expect(view.state.doc.firstChild?.type.name).toBe(
        LINK_REFERENCE_DEFINITION_NAME
      );
      expect(getMarkdown(editor)).toContain("[]: ");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await editor.destroy();
      root.remove();
    }
  });

  it("uses selected text as the reference link label", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "链接文字\n");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      view.dispatch(
        view.state.tr.setSelection(
          // "链接文字" occupies positions 1–5 in the first paragraph.
          TextSelection.create(view.state.doc, 1, 5)
        )
      );
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 2,
        inside: -1,
      });
      view.dom.querySelector("p")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".mt-context-menu__item"
        )
      ).find(
        (item) =>
          item.querySelector(".mt-context-menu__label")?.textContent ===
          "链接引用"
      );
      button?.click();

      expect(
        view.state.doc.firstChild?.child(0).marks[0].type.name
      ).toBe(LINK_REFERENCE_MARK_NAME);
      expect(view.state.doc.child(1).type.name).toBe(
        LINK_REFERENCE_DEFINITION_NAME
      );
      expect(getMarkdown(editor)).toContain("[链接文字][site]");
      expect(getMarkdown(editor)).toContain(
        "[site]: https://example.com"
      );
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      await editor.destroy();
      root.remove();
    }
  });

  it("recognizes the supported definition variants", () => {
    expect(
      parseLinkReferenceDefinitionSource(
        "[site]: <https://example.com> (示例)"
      )
    ).toEqual({
      identifier: "site",
      label: "site",
      url: "https://example.com",
      title: "示例",
    });
    expect(parseLinkReferenceDefinitionSource("[^note]: 不是引用定义")).toBe(
      null
    );
  });
});
