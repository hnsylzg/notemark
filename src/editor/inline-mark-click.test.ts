/*
 * 回归测试：点击行内标记（不输入任何字符）不得改动文档。
 *
 * 背景：mark-source 打开会话时会把 `**`、反引号、`<mark>` 作为【真实文本】
 * 写进文档，关闭时再从文本反推标记。下面几种形态反推不回来，于是「点一下」
 * 就变成了一次真实的文档修改（App 的脏标记随之亮起）：
 *   - 行内代码里含反引号或换行（正则匹配不完整）；
 *   - 行内代码外层还套着加粗/斜体（关闭时会剥掉范围内其它 mark）；
 *   - 代码块里的占位 `<pre><code>`（被误判成行内代码，插入的反引号留在正文）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { undo, undoDepth } from "@milkdown/prose/history";
import type { EditorView } from "@milkdown/kit/prose/view";
import { describe, expect, it } from "vitest";
import { createEditor, getMarkdown, setMarkdown } from "./index";
import { markSourceKey } from "./mark-source";

// jsdom 缺这两个 observer，代码块 NodeView 初始化会直接抛错
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

const FIXTURE = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "__fixtures__",
    "docx-export-test.md"
  ),
  "utf8"
);

/** 挂载一个真实编辑器并载入 markdown，返回 view 与清理函数 */
async function openEditor(markdown: string): Promise<{
  view: EditorView;
  markdown: () => string;
  dispose: () => Promise<void>;
}> {
  const root = document.createElement("div");
  root.className = "milkdown";
  document.body.appendChild(root);
  const editor = createEditor(root);
  await editor.create();
  setMarkdown(editor, markdown);
  return {
    view: editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView,
    markdown: () => getMarkdown(editor),
    dispose: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}

/** 模拟鼠标点中某个元素（走项目自己的 handleClick 链） */
function clickElement(
  view: EditorView,
  element: HTMLElement,
  pos = view.posAtDOM(element, 0, 1)
): void {
  view.someProp("handleClick", (handler) =>
    handler(view, pos, {
      button: 0,
      // 真实鼠标事件一定带坐标：代码块「点下方空白补空段」的插件会读 clientY，
      // 缺省成 undefined 会让 0 与 0 比较失真，凭空插入一个空段落。
      clientX: 0,
      clientY: 0,
      target: element,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as MouseEvent)
  );
}

/** 模拟点到别处：会话随之关闭并还原 */
function clickOutside(): void {
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: false }));
}

function contentPosition(
  view: EditorView,
  element: HTMLElement
): number {
  const node = element.firstChild ?? element;
  const offset = Math.min(
    1,
    node.nodeType === Node.TEXT_NODE ? (node.nodeValue?.length ?? 0) : 0
  );
  return view.posAtDOM(node, offset, 1);
}

describe("clicking an inline mark must not modify the document", () => {
  it("does not expand a nearby mark when clicking inline math", async () => {
    const source = "**bold** $x$\n";
    const editor = await openEditor(source);
    try {
      const view = editor.view;
      const math = view.dom.querySelector<HTMLElement>(
        ".milkdown-math-inline"
      )!;
      expect(math).not.toBeNull();
      const mathPos = view.posAtDOM(math, 0, 1);
      view.dispatch(
        view.state.tr
          .setSelection(
            TextSelection.create(view.state.doc, mathPos)
          )
          .setMeta("pointer", true)
      );
      math.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        })
      );

      expect(markSourceKey.getState(view.state)).toBeNull();
      expect(view.dom.querySelector("strong")?.textContent).toBe(
        "bold"
      );
      expect(editor.markdown()).toBe(source);
    } finally {
      await editor.dispose();
    }
  });

  it("expands a rendered mark when the caret is placed at its right edge", async () => {
    const source = "**bold** text\n";
    const editor = await openEditor(source);
    try {
      const view = editor.view;
      const paragraph = view.dom.querySelector<HTMLElement>("p")!;
      clickElement(view, paragraph, 5);

      expect(markSourceKey.getState(view.state)?.markName).toBe(
        "strong"
      );
      expect(view.dom.querySelector("p")?.textContent).toBe(
        "**bold** text"
      );
      const session = markSourceKey.getState(view.state)!;
      expect(view.state.selection.from).toBe(session.to);
      expect(
        view.someProp("handleTextInput", (handler) =>
          handler(
            view,
            session.to,
            session.to,
            "X",
            () => view.state.tr
          )
        )
      ).toBe(true);
      expect(view.state.doc.textContent).toBe("boldX text");
      expect(editor.markdown()).toBe("**bold**X text\n");
    } finally {
      await editor.dispose();
    }
  });

  it("keeps inline code nested inside strong untouched", async () => {
    const source = "**加粗里有*斜体*与`代码`**\n";
    const editor = await openEditor(source);
    try {
      const before = editor.markdown();
      const code = editor.view.dom.querySelector("strong code");
      expect(code).not.toBeNull();
      clickElement(editor.view, code as HTMLElement);
      clickOutside();
      expect(editor.markdown()).toBe(before);
    } finally {
      await editor.dispose();
    }
  });

  it("keeps fenced code block content untouched", async () => {
    const source = "```python\ndef hello(name):\n    return name\n```\n";
    const editor = await openEditor(source);
    try {
      const before = editor.markdown();
      const code = editor.view.dom.querySelector("pre code");
      if (code) {
        clickElement(editor.view, code as HTMLElement);
        clickOutside();
      }
      expect(editor.markdown()).toBe(before);
    } finally {
      await editor.dispose();
    }
  });

  it("keeps the caret where the keyboard moved it when the session closes", async () => {
    const source = "**粗体** 正文\n";
    const editor = await openEditor(source);
    try {
      const view = editor.view;
      const strong = view.dom.querySelector("strong");
      expect(strong).not.toBeNull();
      clickElement(view, strong as HTMLElement);
      expect(markSourceKey.getState(view.state)).not.toBeNull();
      expect(editor.markdown()).toContain("**粗体**");

      // 模拟用户用方向键把光标移到标记之外（段落末尾）
      const end = view.state.doc.content.size - 1;
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, end))
      );

      expect(markSourceKey.getState(view.state)).toBeNull();
      // 关键：光标必须留在移出去的位置，不能被弹回标记内部
      expect(view.state.selection.from).toBe(end - 4);
      expect(view.state.selection.from).toBeGreaterThan(3);
      expect(editor.markdown()).toBe(source);
    } finally {
      await editor.dispose();
    }
  });

  it("undo after editing inside a clicked mark removes only the typed text", async () => {
    const source = "**粗体** 正文\n";
    const editor = await openEditor(source);
    try {
      const view = editor.view;
      // jsdom 没有布局，撤销事务触发的滚动会抛 getClientRects 错误
      (view as unknown as { scrollToSelection: () => void }).scrollToSelection =
        () => {};

      const strong = view.dom.querySelector("strong");
      expect(strong).not.toBeNull();
      // pos 2 落在「粗体」两个字的中间，确保光标在标记内容里
      clickElement(view, strong as HTMLElement, 2);
      const at = view.state.selection.from;
      view.dispatch(view.state.tr.insertText("X", at));
      clickOutside();
      expect(editor.markdown()).toBe("**粗X体** 正文\n");

      // 撤销只该撤掉刚输入的 X，不能把临时分隔符还原成正文
      expect(undo(view.state, (tr) => view.dispatch(tr))).toBe(true);
      expect(editor.markdown()).toBe(source);
      expect(editor.markdown()).not.toContain("****");
      // 分隔符换回 mark 的那一步不该占历史，撤到底就没了
      expect(undo(view.state, (tr) => view.dispatch(tr))).toBe(false);
    } finally {
      await editor.dispose();
    }
  });

  it("does not leave a no-edit mark click in undo history", async () => {
    const source = "**bold** text\n";
    const editor = await openEditor(source);
    try {
      const view = editor.view;
      const strong = view.dom.querySelector("strong");
      expect(strong).not.toBeNull();

      clickElement(view, strong as HTMLElement);
      // Exceed ProseMirror's default history grouping delay so opening and
      // closing source become separate history candidates.
      await new Promise((resolve) => setTimeout(resolve, 650));
      clickOutside();

      expect(editor.markdown()).toBe(source);
      const undoChanged = undo(view.state, () => undefined);
      expect(undoChanged).toBe(false);
    } finally {
      await editor.dispose();
    }
  });

  it.each([
    ["emphasis", "*italic* text\n", "em"],
    ["link", "[link](https://example.com) text\n", "a"],
    ["highlight", "==highlight== text\n", "mark.md-highlight"],
    ["inlineCode", "`code` text\n", "code"],
  ])(
    "undo after editing inside a clicked %s removes only the typed text",
    async (_label, source, selector) => {
      const editor = await openEditor(source);
      try {
        const view = editor.view;
        (
          view as unknown as { scrollToSelection: () => void }
        ).scrollToSelection = () => {};

        const element = view.dom.querySelector(selector);
        expect(element).not.toBeNull();
        clickElement(
          view,
          element as HTMLElement,
          contentPosition(view, element as HTMLElement)
        );
        expect(undoDepth(view.state)).toBe(0);

        const at = view.state.selection.from;
        view.dispatch(view.state.tr.insertText("X", at));
        expect(undoDepth(view.state)).toBe(1);

        clickOutside();
        expect(markSourceKey.getState(view.state)).toBeNull();
        expect(undoDepth(view.state)).toBe(1);

        expect(undo(view.state, (tr) => view.dispatch(tr))).toBe(true);
        expect(editor.markdown()).toBe(source);
        expect(undoDepth(view.state)).toBe(0);
        expect(undo(view.state, (tr) => view.dispatch(tr))).toBe(false);
      } finally {
        await editor.dispose();
      }
    }
  );

  it("keeps the format-test document byte-identical after clicking every inline code",
    async () => {
      const editor = await openEditor(FIXTURE);
      try {
        const baseline = editor.markdown();
        const elements = Array.from(
          editor.view.dom.querySelectorAll("code")
        ) as HTMLElement[];
        expect(elements.length).toBeGreaterThan(0);
        for (const element of elements) {
          const before = editor.markdown();
          clickElement(editor.view, element);
          clickOutside();
          expect(editor.markdown()).toBe(before);
        }
        expect(editor.markdown()).toBe(baseline);
      } finally {
        await editor.dispose();
      }
    },
    120000
  );

});
