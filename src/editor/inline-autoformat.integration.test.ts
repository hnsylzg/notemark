import { editorViewCtx } from "@milkdown/kit/core";
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { describe, expect, it } from "vitest";
import { createEditor, getMarkdown, setMarkdown } from "./index";
import { markSourceKey } from "./mark-source";

function typePlainText(view: EditorView, text: string): void {
  for (const character of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, from, to, character, () => view.state.tr)
    );
    if (!handled) {
      view.dispatch(view.state.tr.insertText(character, from, to));
    }
  }
}

function clickInlineHtml(view: EditorView, element: HTMLElement): boolean {
  const pos = view.posAtDOM(element, 0, 1);
  return Boolean(
    view.someProp("handleClick", (handler) =>
      handler(view, pos, {
        button: 0,
        target: element,
      } as unknown as MouseEvent)
    )
  );
}

describe("inline markdown autoformat integration", () => {
  it.each([
    ["inline HTML", "<mark>高亮</mark>x", "mark[data-inline-html-mark]"],
    ["strong", "**粗体**x", "strong"],
  ])(
    "autoformats pending %s after the keyboard selection leaves its source",
    async (_label, source, renderedSelector) => {
      const root = document.createElement("div");
      root.className = "milkdown";
      document.body.appendChild(root);
      const editor = createEditor(root);

      try {
        await editor.create();
        const view = editor.action((ctx) =>
          ctx.get(editorViewCtx)
        ) as EditorView;
        view.dispatch(view.state.tr.insertText("x", 1));
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 1)
          )
        );
        typePlainText(view, source.slice(0, -1));
        await Promise.resolve();

        expect(root.querySelector(renderedSelector)).toBeNull();
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(
              view.state.doc,
              1 + source.length
            )
          )
        );

        expect(root.querySelector(renderedSelector)).not.toBeNull();
        expect(getMarkdown(editor)).toContain(
          _label === "inline HTML"
            ? "<mark>高亮</mark>x"
            : "**粗体**x"
        );
      } finally {
        await editor.destroy();
        root.remove();
      }
    }
  );

  it.each([
    ["inline HTML", "前 <mark>高亮</mark> 后", "mark[data-inline-html-mark]"],
    ["strong", "前 **粗体** 后", "strong"],
  ])(
    "types before %s without escaping or breaking the inline mark",
    async (_label, markdown, selector) => {
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
        const target = root.querySelector<HTMLElement>(selector);
        expect(target).not.toBeNull();
        const beforeMark = view.posAtDOM(target!, 0, -1);
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, beforeMark)
          )
        );
        typePlainText(view, "X");
        document.body.dispatchEvent(
          new MouseEvent("click", { bubbles: false })
        );

        expect(getMarkdown(editor)).not.toContain("\\<");
        expect(getMarkdown(editor)).not.toContain("\\>");
        expect(root.querySelector(selector)).not.toBeNull();
      } finally {
        await editor.destroy();
        root.remove();
      }
    }
  );

  it("autoformats emphasis after completing the opening marker and exiting from the left", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      typePlainText(view, "xxx*");
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1)
        )
      );
      typePlainText(view, "*");
      await Promise.resolve();

      expect(root.querySelector("em")).toBeNull();
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1)
        )
      );

      expect(root.querySelector("em")?.textContent).toBe("xxx");
      expect(getMarkdown(editor)).toContain("*xxx*");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("keeps an incomplete trailing marker as ordinary text", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      typePlainText(view, "xxx*");
      await Promise.resolve();

      expect(root.querySelector("em")).toBeNull();
      expect(root.querySelector(".mt-inline-source-preview")).toBeNull();
      expect(getMarkdown(editor)).toContain("xxx*");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("autoformats inline math after completing the opening dollar and exiting left", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      typePlainText(view, "xxx$");
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1)
        )
      );
      typePlainText(view, "$");
      await Promise.resolve();

      expect(root.querySelector(".milkdown-math-inline")).toBeNull();
      expect(view.state.doc.textContent).toBe("$xxx$");

      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1)
        )
      );

      expect(
        view.state.doc.firstChild?.firstChild?.type.name
      ).toBe("math_inline");
      expect(getMarkdown(editor)).toContain("$xxx$");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("autoformats inline math when keyboard selection moves to the next line", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      setMarkdown(editor, "xxx$\n\nbelow");
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1)
        )
      );
      typePlainText(view, "$");
      await Promise.resolve();

      expect(root.querySelector(".milkdown-math-inline")).toBeNull();
      expect(view.state.doc.textContent).toContain("$xxx$");

      const nextLine = view.state.doc.child(0).nodeSize + 2;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, nextLine)
        )
      );

      expect(root.querySelector(".milkdown-math-inline")).not.toBeNull();
      expect(view.state.doc.child(0).firstChild?.type.name).toBe(
        "math_inline"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("autoformats inline math when the first vertical move selects a horizontal rule", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      setMarkdown(editor, "xxx$\n\n---\n\nafter");
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1)
        )
      );
      typePlainText(view, "$");
      await Promise.resolve();

      expect(root.querySelector(".milkdown-math-inline")).toBeNull();
      const rulePos = view.state.doc.child(0).nodeSize;
      expect(view.state.doc.nodeAt(rulePos)?.type.name).toBe("hr");

      view.dispatch(
        view.state.tr.setSelection(
          NodeSelection.create(view.state.doc, rulePos)
        )
      );

      expect(root.querySelector(".milkdown-math-inline")).not.toBeNull();
      expect(view.state.doc.child(0).firstChild?.type.name).toBe(
        "math_inline"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("autoformats a complete inline HTML tag typed as plain text", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      typePlainText(view, "<mrk>高亮</mark>");
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(root.querySelector("mark[data-inline-html-mark]")).toBeNull();

      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 3)
        )
      );
      typePlainText(view, "a");
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );

      expect(getMarkdown(editor)).toContain("<mark>高亮</mark>");
      expect(
        root.querySelector("mark[data-inline-html-mark]")?.textContent
      ).toBe("高亮");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("edits and re-renders inline HTML through the mark source flow", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "前 <mark>高亮</mark> 后");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const target = root.querySelector<HTMLElement>(
        "mark[data-inline-html-mark]"
      );
      expect(target).not.toBeNull();
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => root,
      });

      expect(clickInlineHtml(view, target!)).toBe(true);
      const session = markSourceKey.getState(view.state);
      expect(session).not.toBeNull();
      expect(
        view.state.doc.textBetween(
          session!.from,
          session!.to,
          "\n",
          "\n"
        )
      ).toBe("<mark>高亮</mark>");

      view.dispatch(
        view.state.tr.replaceWith(
          session!.from,
          session!.to,
          view.state.schema.text('<span class="x">高亮</span>')
        )
      );
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: false, button: 0 })
      );
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false, button: 0 })
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(getMarkdown(editor)).toContain(
        '<span class="x">高亮</span>'
      );
      expect(root.querySelector("span.x")?.textContent).toBe("高亮");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("does not serialize paragraph-boundary spaces as HTML entities", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(
        editor,
        [
          "前面 <center>居中块</center> 后面。",
          "",
          '前面 <iframe src="https://example.com/embed" width="480" height="270"></iframe> 后面。',
          "",
          "> 引用内 <center>居中块</center> 后续。",
          "",
          "- 列表项 <center>居中块</center> 后续。",
        ].join("\n")
      );

      const markdown = getMarkdown(editor);
      expect(markdown).not.toContain("&#x20;");
      expect(markdown).toContain("前面 ");
      expect(markdown).toContain(" 后面。");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("keeps iframe block and inline semantics based on paragraph context", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const iframe =
        '<iframe src="https://example.com/embed" width="560" height="315"></iframe>';

      setMarkdown(editor, iframe);
      expect(root.querySelectorAll(".mt-html-block")).toHaveLength(1);
      expect(root.querySelectorAll(".mt-inline-html-node")).toHaveLength(0);
      expect(root.querySelector(".mt-html-block-edit")?.textContent).toBe(
        "HTML </>"
      );

      setMarkdown(editor, `前文 ${iframe} 后文`);
      expect(root.querySelectorAll(".mt-html-block")).toHaveLength(0);
      expect(root.querySelectorAll(".mt-inline-html-node")).toHaveLength(1);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it.each(["code", "sup", "strong", "em", "del"])(
    "opens the inline HTML source editor for a <%s> tag",
    async (tag) => {
      const root = document.createElement("div");
      root.className = "milkdown";
      document.body.appendChild(root);
      const editor = createEditor(root);

      try {
        await editor.create();
        setMarkdown(editor, `前 <${tag}>内容</${tag}> 后`);
        const view = editor.action((ctx) =>
          ctx.get(editorViewCtx)
        ) as EditorView;
        const target = root.querySelector<HTMLElement>(
          `${tag}[data-inline-html-mark]`
        );
        expect(target).not.toBeNull();
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: () => root,
        });

        expect(clickInlineHtml(view, target!)).toBe(true);
        const session = markSourceKey.getState(view.state);
        expect(session?.markName).toBe("inlineHtmlMarkup");
        expect(
          view.state.doc.textBetween(
            session!.from,
            session!.to,
            "\n",
            "\n"
          )
        ).toBe(`<${tag}>内容</${tag}>`);
      } finally {
        await editor.destroy();
        root.remove();
      }
    }
  );

  it(
    "automatically renders completed inline HTML when selection leaves its source range",
    async () => {
      const root = document.createElement("div");
      root.className = "milkdown";
      document.body.appendChild(root);
      const editor = createEditor(root);

      try {
        await editor.create();
        setMarkdown(editor, "前 <mark>高亮</mark> 后");
        const view = editor.action((ctx) =>
          ctx.get(editorViewCtx)
        ) as EditorView;
        const target = root.querySelector<HTMLElement>(
          "mark[data-inline-html-mark]"
        )!;
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: () => root,
        });
        expect(clickInlineHtml(view, target)).toBe(true);
        const session = markSourceKey.getState(view.state)!;

        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(
              view.state.doc,
              Math.min(view.state.doc.content.size, session.to + 1)
            )
          )
        );

        expect(markSourceKey.getState(view.state)).toBeNull();
        expect(getMarkdown(editor)).toContain("<mark>高亮</mark>");
        expect(
          root.querySelector("mark[data-inline-html-mark]")?.textContent
        ).toBe("高亮");
      } finally {
        await editor.destroy();
        root.remove();
      }
    }
  );

  it.each([
    ["tag name", 2, "a"],
    ["opening bracket", 0, "<"],
  ])(
    "re-renders inline HTML after repairing an invalid %s",
    async (_label, offset, repairCharacter) => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(editor, "前 <mark>高亮</mark> 后");
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const target = root.querySelector<HTMLElement>(
        "mark[data-inline-html-mark]"
      )!;
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => root,
      });
      expect(clickInlineHtml(view, target)).toBe(true);
      const session = markSourceKey.getState(view.state)!;
      const deleteAt = session.from + offset;

      view.dispatch(view.state.tr.delete(deleteAt, deleteAt + 1));
      expect(markSourceKey.getState(view.state)).not.toBeNull();
      const invalidSession = markSourceKey.getState(view.state)!;
      const repairAt = invalidSession.from + offset;
      view.dispatch(view.state.tr.insertText(repairCharacter, repairAt));

      expect(markSourceKey.getState(view.state)).toBeNull();
      expect(getMarkdown(editor)).toContain("<mark>高亮</mark>");
      expect(
        root.querySelector("mark[data-inline-html-mark]")?.textContent
      ).toBe("高亮");
    } finally {
      await editor.destroy();
      root.remove();
    }
    }
  );

  it.each([
    [
      "original",
      "行内 HTML 白名单：<u>下划线</u>、<ins>ins 插入</ins>、<mark>高亮 mark</mark>、<b>粗</b>、<i>斜</i>、<s>删除 s</s>、<del>del 删除</del>、<code>code 标签</code>、<kbd>Ctrl</kbd>+<kbd>S</kbd>、<samp>samp 输出</samp>、<tt>tt 等宽</tt>、换行<br>这里是 `<br>` 之后的新行。",
    ],
    [
      "saved wrapped",
      "行内 HTML 白名单：<u>下划线</u>、<ins>ins 插入</ins>、<mark>高亮 mark</mark>、<b>粗</b>、<i>斜</i>、<s>删除 s</s>、~~<del>del 删除</del>~~、`<code>code 标签</code>`、<kbd>Ctrl</kbd>+<kbd>S</kbd>、<samp>samp 输出</samp>、<tt>tt 等宽</tt>、换行<br>这里是 `<br>` 之后的新行。",
    ],
  ])("keeps %s inline HTML unchanged when clicked", async (_label, markdown) => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const changes: string[] = [];
    const editor = createEditor(root, "", (markdown) => changes.push(markdown));
    try {
      await editor.create();
      setMarkdown(editor, markdown);
      const baseline = getMarkdown(editor);
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => root,
      });
      const inlineElements = root.querySelectorAll(
        "u, ins, mark, b, i, s, del, code, kbd, samp, tt"
      );
      expect(inlineElements.length).toBeGreaterThan(0);

      for (const element of inlineElements) {
        element.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, button: 0 })
        );
        element.dispatchEvent(
          new MouseEvent("click", { bubbles: true, button: 0 })
        );
        document.body.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: false, button: 0 })
        );
        document.body.dispatchEvent(
          new MouseEvent("click", { bubbles: false, button: 0 })
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(getMarkdown(editor)).toBe(baseline);
      expect(changes.at(-1) ?? baseline).toBe(baseline);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("formats a complete emphasis marker entered as plain text", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const editorView = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      typePlainText(editorView, "*ddd*");
      expect(
        editorView.dom.querySelector(
          ".mt-inline-source-preview--emphasis"
        )?.textContent
      ).toBe("ddd");
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );

      expect(editorView.state.doc.textContent).toBe("ddd");
      expect(
        editorView.state.doc.firstChild?.firstChild?.marks[0].type.name
      ).toBe("emphasis");
      expect(editorView.dom.querySelector("em")?.textContent).toBe(
        "ddd"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("does not autoformat completed source until the pointer click leaves it", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      typePlainText(view, "*ddd*");
      await Promise.resolve();

      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: false })
      );
      expect(view.state.doc.textContent).toBe("*ddd*");

      view.dom.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(view.state.doc.textContent).toBe("*ddd*");

      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(view.state.doc.textContent).toBe("ddd");
      expect(
        view.state.doc.firstChild?.firstChild?.marks[0].type.name
      ).toBe("emphasis");
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("commits italic formatting when ordinary text follows the marker", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const editorView = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      typePlainText(editorView, "*ddd*");
      expect(
        editorView.dom.querySelector(
          ".mt-inline-source-preview--emphasis"
        )?.textContent
      ).toBe("ddd");

      const caret = editorView.state.selection.from;
      editorView.someProp("handleTextInput", (handler) =>
        handler(editorView, caret, caret, "x", () =>
          editorView.state.tr
        )
      );
      editorView.dispatch(
        editorView.state.tr.insertText("x", caret, caret)
      );
      await Promise.resolve();

      expect(editorView.state.doc.textContent).toBe("dddx");
      expect(editorView.dom.querySelector("em")?.textContent).toBe("ddd");
      expect(
        editorView.dom.querySelector(".mt-inline-source-preview")
      ).toBeNull();
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("formats after typing the closing stars, moving to the start, and repairing the opening star", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      expect(view).toBeInstanceOf(Object);
      const editorView = view as EditorView;
      typePlainText(editorView, "*ddd**");
      expect(
        editorView.dom.querySelector(".mt-inline-source-preview")
      ).toBeNull();
      const start = 1;
      editorView.dispatch(
        editorView.state.tr.setSelection(
          TextSelection.create(editorView.state.doc, start)
        )
      );
      editorView.dispatch(
        editorView.state.tr.insertText("*", start, start)
      );
      expect(
        editorView.dom.querySelector(
          ".mt-inline-source-preview--strong"
        )?.textContent
      ).toBe("ddd");
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );

      expect(editorView.state.doc.textContent).toBe("ddd");
      expect(
        editorView.state.doc.firstChild?.firstChild?.marks[0].type.name
      ).toBe("strong");
      expect(editorView.dom.querySelector("strong")?.textContent).toBe(
        "ddd"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("upgrades rendered emphasis to strong after re-entering its source", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const editorView = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      typePlainText(editorView, "*ddd*");
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(editorView.state.doc.textContent).toBe("ddd");

      const afterText = 4;
      editorView.dispatch(
        editorView.state.tr.setSelection(
          TextSelection.create(editorView.state.doc, afterText)
        )
      );
      expect(editorView.state.doc.textContent).toBe("*ddd*");

      editorView.dispatch(
        editorView.state.tr.insertText("*", 1, 1)
      );
      const sourceEnd = 6;
      editorView.someProp("handleTextInput", (handler) =>
        handler(editorView, sourceEnd, sourceEnd, "*", () =>
          editorView.state.tr
        )
      );
      editorView.dispatch(
        editorView.state.tr.insertText("*", sourceEnd, sourceEnd)
      );
      expect(editorView.state.doc.textContent).toBe("**ddd**");
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );

      expect(editorView.state.doc.textContent).toBe("ddd");
      expect(
        editorView.state.doc.firstChild?.firstChild?.marks.map(
          (mark) => mark.type.name
        )
      ).toEqual(["strong"]);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });

  it("renders the repaired format when clicking another line's syntax", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      const editorView = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      ) as EditorView;
      const schema = editorView.state.schema;
      const emphasis = schema.marks.emphasis.create();
      const strong = schema.marks.strong.create();
      const doc = schema.nodes.doc.create(null, [
        schema.nodes.paragraph.create(
          null,
          schema.text("ddd", [emphasis])
        ),
        schema.nodes.paragraph.create(
          null,
          schema.text("eee", [strong])
        ),
      ]);
      editorView.dispatch(
        editorView.state.tr.replaceWith(
          0,
          editorView.state.doc.content.size,
          doc.content
        )
      );
      editorView.dispatch(
        editorView.state.tr.setSelection(
          TextSelection.create(editorView.state.doc, 2)
        )
      );
      expect(editorView.state.doc.firstChild?.textContent).toBe(
        "*ddd*"
      );

      editorView.dispatch(
        editorView.state.tr.insertText("*", 1, 1)
      );
      editorView.dispatch(
        editorView.state.tr.insertText("*", 6, 6)
      );
      expect(editorView.state.doc.firstChild?.textContent).toBe(
        "**ddd**"
      );

      const otherLineSyntax =
        editorView.dom.querySelector("strong")!;
      otherLineSyntax.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: false })
      );
      const secondTextPos =
        editorView.state.doc.child(0).nodeSize + 1;
      editorView.dispatch(
        editorView.state.tr
          .setSelection(
            TextSelection.create(
              editorView.state.doc,
              secondTextPos
            )
          )
          .setMeta("pointer", true)
      );
      otherLineSyntax.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(editorView.state.doc.firstChild?.textContent).toBe("ddd");
      expect(
        editorView.state.doc.firstChild?.firstChild?.marks.map(
          (mark) => mark.type.name
        )
      ).toEqual(["strong"]);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
