import { Schema } from "@milkdown/prose/model";
import {
  EditorState,
  TextSelection,
} from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it, vi } from "vitest";
import {
  MARK_SOURCE_SYNTAX,
  autoFormatInlineMarkdown,
  createMarkSourcePlugin,
  createMarkSourceTransaction,
  markSourceKey,
  sourceSessionBlockElement,
  startMarkSource,
} from "./mark-source";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
  },
  marks: {
    strong: { toDOM: () => ["strong", 0] },
    emphasis: { toDOM: () => ["em", 0] },
    strike_through: { toDOM: () => ["del", 0] },
    inlineCode: { inclusive: true, toDOM: () => ["code", 0] },
    highlight: { toDOM: () => ["mark", 0] },
    underline: { toDOM: () => ["u", 0] },
    superscript: { toDOM: () => ["sup", 0] },
    subscript: { toDOM: () => ["sub", 0] },
    link: {
      attrs: {
        href: {},
        title: { default: null },
      },
      toDOM: (mark) => [
        "a",
        { href: mark.attrs.href, title: mark.attrs.title },
        0,
      ],
    },
  },
});

function stateWithText(
  text: string,
  from = 1,
  to = from
): EditorState {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, text ? schema.text(text) : undefined),
  ]);
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, from, to),
    plugins: [createMarkSourcePlugin()],
  });
}

function formatState(state: EditorState): EditorState {
  const tr = autoFormatInlineMarkdown(state, false);
  return tr ? state.applyTransaction(tr).state : state;
}

describe("Typora-style mark source editing", () => {
  it("formats plain markdown when the missing opening star is added", () => {
    const state = stateWithText("*xx**", 2);
    const inserted = state.applyTransaction(
      state.tr.insertText("*", 1, 1)
    ).state;
    const next = formatState(inserted);

    expect(next.doc.textContent).toBe("xx");
    expect(next.doc.firstChild?.firstChild?.marks[0].type.name).toBe(
      "strong"
    );
  });

  it("formats completed plain syntax when focus leaves", () => {
    const state = stateWithText("*ddd*", 1);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, { state });

    try {
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(view.state.doc.textContent).toBe("ddd");
      expect(
        view.state.doc.firstChild?.firstChild?.marks[0].type.name
      ).toBe("emphasis");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("waits until the caret leaves before formatting italics", () => {
    const editing = stateWithText("*ddd*", 6);
    expect(autoFormatInlineMarkdown(editing)).toBeNull();

    const afterSpace = stateWithText("*ddd* ", 7);
    const tr = autoFormatInlineMarkdown(afterSpace);
    const next = tr
      ? afterSpace.applyTransaction(tr).state
      : afterSpace;
    expect(next.doc.textContent).toBe("ddd ");
    expect(next.doc.firstChild?.firstChild?.marks[0].type.name).toBe(
      "emphasis"
    );
  });

  it("formats a plain inline fragment beside existing formatted text", () => {
    const strong = schema.marks.strong.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("前", [strong]),
        schema.text("*斜**"),
      ]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 3),
      plugins: [createMarkSourcePlugin()],
    });
    const inserted = state.applyTransaction(
      state.tr.insertText("*", 2, 2)
    ).state;
    const next = formatState(inserted);

    expect(next.doc.textContent).toBe("前斜");
    expect(
      next.doc.firstChild?.firstChild?.marks[0].type.name
    ).toBe("strong");
  });

  it.each([
    ["strong", "*x**", "*"],
    ["emphasis", "x*", "*"],
    ["strike_through", "~x~~", "~"],
    ["inlineCode", "x`", "`"],
    ["highlight", "=x==", "="],
    ["underline", "x</u>", "<u>"],
    ["superscript", "x^", "^"],
    ["subscript", "x~", "~"],
  ])(
    "formats %s when the leading delimiter is completed",
    (markName, incomplete, leading) => {
      const state = stateWithText(incomplete, 2);
      const inserted = state.applyTransaction(
        state.tr.insertText(leading, 1, 1)
      ).state;
      const next = formatState(inserted);

      expect(next.doc.textContent).toBe("x");
      expect(next.doc.firstChild?.firstChild?.marks[0].type.name).toBe(
        markName
      );
    }
  );

  it.each([
    "strong",
    "emphasis",
    "strike_through",
    "inlineCode",
    "highlight",
    "underline",
    "superscript",
    "subscript",
  ])(
    "repairs and renders the %s delimiters after an outside click",
    (markName) => {
      const mark = schema.marks[markName].create();
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, schema.text("x", [mark])),
      ]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 2),
          plugins: [createMarkSourcePlugin()],
        }),
      });

      try {
        expect(startMarkSource(view, markName)).toBe(true);
        const syntax = MARK_SOURCE_SYNTAX[markName];
        const source = view.state.doc.textContent ?? "";
        const closeStart = 1 + syntax.open.length + 1;
        const deletedAt =
          closeStart + (syntax.close.length > 1 ? 1 : 0);
        view.dispatch(
          view.state.tr.delete(deletedAt, deletedAt + 1)
        );
        expect(markSourceKey.getState(view.state)).not.toBeNull();
        view.dispatch(
          view.state.tr.insertText(
            source[deletedAt - 1],
            deletedAt,
            deletedAt
          )
        );
        expect(markSourceKey.getState(view.state)).not.toBeNull();

        document.body.dispatchEvent(
          new MouseEvent("click", { bubbles: false })
        );
        expect(view.state.doc.textContent).toBe("x");
        expect(
          view.state.doc.firstChild?.firstChild?.marks[0].type.name
        ).toBe(markName);
      } finally {
        view.destroy();
        host.remove();
      }
    }
  );

  it.each([
    "strong",
    "emphasis",
    "strike_through",
    "inlineCode",
    "highlight",
    "underline",
    "superscript",
    "subscript",
  ])(
    "expands a rendered %s mark when the keyboard caret enters it",
    (markName) => {
      const mark = schema.marks[markName].create();
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, schema.text("x", [mark])),
      ]);
      const state = EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 1),
        plugins: [createMarkSourcePlugin()],
      });
      const next = state.applyTransaction(
        state.tr.setSelection(TextSelection.create(doc, 2))
      ).state;

      expect(next.doc.textContent).toBe(
        `${MARK_SOURCE_SYNTAX[markName].open}x` +
          MARK_SOURCE_SYNTAX[markName].close
      );
      expect(markSourceKey.getState(next)?.markName).toBe(markName);
    }
  );

  it("formats a link when the leading bracket is completed", () => {
    const state = stateWithText("x](https://example.com)", 2);
    const inserted = state.applyTransaction(
      state.tr.insertText("[", 1, 1)
    ).state;
    const next = formatState(inserted);

    expect(next.doc.textContent).toBe("x");
    expect(next.doc.firstChild?.firstChild?.marks[0].type.name).toBe(
      "link"
    );
    expect(next.doc.firstChild?.firstChild?.marks[0].attrs.href).toBe(
      "https://example.com"
    );
  });

  it("expands a rendered link when the keyboard caret enters it", () => {
    const link = schema.marks.link.create({
      href: "https://example.com",
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("x", [link])),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
      plugins: [createMarkSourcePlugin()],
    });
    const next = state.applyTransaction(
      state.tr.setSelection(TextSelection.create(doc, 2))
    ).state;

    expect(next.doc.textContent).toBe(
      "[x](https://example.com)"
    );
    expect(markSourceKey.getState(next)?.markName).toBe("link");
  });

  it("turns a selected mark into editable source delimiters", () => {
    const state = stateWithText("hello", 1, 6);
    const tr = createMarkSourceTransaction(state, "strong")!;
    const next = state.applyTransaction(tr).state;

    expect(next.doc.textContent).toBe("**hello**");
    expect(next.doc.firstChild?.firstChild?.marks).toEqual([]);
    let contentMarks: readonly import("@milkdown/prose/model").Mark[] = [];
    next.doc.descendants((node) => {
      if (node.isText && node.text === "hello") contentMarks = node.marks;
    });
    expect(contentMarks[0].type.name).toBe("strong");
    expect(markSourceKey.getState(next)).toEqual({
      markName: "strong",
      from: 1,
      to: 10,
      attrs: undefined,
    });
  });

  it("opens an empty source pair with editable delimiter text", () => {
    const state = stateWithText("", 1, 1);
    const opened = state.applyTransaction(
      createMarkSourceTransaction(state, "strong")!
    ).state;
    expect(markSourceKey.getState(opened)).toEqual({
      markName: "strong",
      from: 1,
      to: 5,
      attrs: undefined,
    });

    const typed = opened.applyTransaction(
      opened.tr.insertText("粗体", 3, 3)
    ).state;
    expect(typed.doc.textContent).toBe("**粗体**");
    expect(markSourceKey.getState(typed)).toEqual({
      markName: "strong",
      from: 1,
      to: 7,
      attrs: undefined,
    });
  });

  it("keeps source mode after deleting and restoring one delimiter character", () => {
    const state = stateWithText("", 1, 1);
    const opened = state.applyTransaction(
      createMarkSourceTransaction(state, "strong")!
    ).state;
    expect(opened.doc.textContent).toBe("****");

    const deleted = opened.applyTransaction(
      opened.tr.delete(3, 4)
    ).state;
    expect(deleted.doc.textContent).toBe("***");
    expect(markSourceKey.getState(deleted)).not.toBeNull();

    const restored = deleted.applyTransaction(
      deleted.tr.insertText("*", 3, 3)
    ).state;
    expect(restored.doc.textContent).toBe("****");
    expect(markSourceKey.getState(restored)).not.toBeNull();
  });

  it("renders normally after repairing the closing delimiter around text", () => {
    const state = stateWithText("", 1, 1);
    const opened = state.applyTransaction(
      createMarkSourceTransaction(state, "strong")!
    ).state;
    const typed = opened.applyTransaction(
      opened.tr.insertText("粗体", 3, 3)
    ).state;
    expect(typed.doc.textContent).toBe("**粗体**");

    const deleted = typed.applyTransaction(
      typed.tr.delete(5, 6)
    ).state;
    expect(deleted.doc.textContent).toBe("**粗体*");
    const restored = deleted.applyTransaction(
      deleted.tr.insertText("*", 5, 5)
    ).state;
    expect(restored.doc.textContent).toBe("**粗体**");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, { state: restored });
    try {
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(view.state.doc.textContent).toBe("粗体");
      expect(
        view.state.doc.firstChild?.firstChild?.marks[0].type.name
      ).toBe("strong");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("closes source editing as soon as the caret leaves the marked range", () => {
    const state = stateWithText("粗体 正文", 1, 3);
    const opened = state.applyTransaction(
      createMarkSourceTransaction(state, "strong")!
    ).state;
    expect(opened.doc.textContent).toBe("**粗体** 正文");
    expect(markSourceKey.getState(opened)?.to).toBe(7);

    const moved = opened.applyTransaction(
      opened.tr.setSelection(TextSelection.create(opened.doc, 9))
    ).state;
    expect(markSourceKey.getState(moved)).toBeNull();
    expect(moved.doc.textContent).toBe("粗体 正文");
    expect(
      moved.doc.firstChild?.firstChild?.marks[0].type.name
    ).toBe("strong");
  });

  it("renders the delimiters as real editable document text", () => {
    const state = stateWithText("粗体", 1, 3);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state,
    });

    try {
      view.dispatch(view.state.tr.setSelection(
        TextSelection.create(view.state.doc, 1, 3)
      ));
      startMarkSource(view, "strong");
      expect(view.dom.querySelector("p")?.textContent).toBe("**粗体**");
      expect(view.dom.querySelector("strong")?.textContent).toBe("粗体");
      expect(
        view.dom.querySelectorAll(".mt-mark-source-marker")
      ).toHaveLength(0);
      view.dispatch(view.state.tr.delete(1, 3));
      expect(view.dom.querySelector("p")?.textContent).toBe("粗体**");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("renders edited content after clicking outside", () => {
    const state = stateWithText("粗体 正文", 1, 3);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, { state });

    try {
      expect(startMarkSource(view, "strong")).toBe(true);
      view.dispatch(view.state.tr.insertText("重点", 3, 5));
      expect(view.dom.querySelector("p")?.textContent).toBe(
        "**重点** 正文"
      );

      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );

      expect(view.dom.querySelector("p")?.textContent).toBe("重点 正文");
      expect(view.dom.querySelector("strong")?.textContent).toBe("重点");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("closes source mode when the pointer lands at the source end", () => {
    const state = stateWithText("粗体", 1, 3);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, { state });

    try {
      expect(startMarkSource(view, "strong")).toBe(true);
      const session = markSourceKey.getState(view.state)!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: session.to,
        inside: -1,
      });
      view.dom.querySelector("p")!.dispatchEvent(
        new MouseEvent("click", {
          bubbles: false,
          clientX: 10,
          clientY: 10,
        })
      );

      expect(markSourceKey.getState(view.state)).toBeNull();
      expect(view.dom.querySelector("p")?.textContent).toBe("粗体");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("renders underline after repairing a deleted closing slash", () => {
    const underline = schema.marks.underline.create();
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        schema.text("underline", [underline])
      ),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 3),
        plugins: [createMarkSourcePlugin()],
      }),
    });

    try {
      expect(startMarkSource(view, "underline")).toBe(true);
      expect(view.dom.querySelector("p")?.textContent).toBe(
        "<u>underline</u>"
      );
      const source = view.state.doc.textContent ?? "";
      const slash = 1 + source.indexOf("</u>") + 1;
      view.dispatch(view.state.tr.delete(slash, slash + 1));
      expect(view.state.doc.textContent).toBe("<u>underline<u>");
      expect(markSourceKey.getState(view.state)).not.toBeNull();

      view.dispatch(view.state.tr.insertText("/", slash, slash));
      expect(view.state.doc.textContent).toBe("<u>underline</u>");
      expect(markSourceKey.getState(view.state)).not.toBeNull();
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );

      expect(view.state.doc.textContent).toBe("underline");
      expect(view.dom.querySelector("u")?.textContent).toBe("underline");
      expect(
        view.state.doc.firstChild?.firstChild?.marks[0].type.name
      ).toBe("underline");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("upgrades an expanded emphasis to strong when both stars are added", () => {
    const emphasis = schema.marks.emphasis.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("x", [emphasis])),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 2),
        plugins: [createMarkSourcePlugin()],
      }),
    });

    try {
      expect(startMarkSource(view, "emphasis")).toBe(true);
      expect(view.state.doc.textContent).toBe("*x*");
      view.dispatch(view.state.tr.insertText("*", 1, 1));
      const session = markSourceKey.getState(view.state)!;
      view.dispatch(
        view.state.tr.insertText("*", session.to, session.to)
      );
      expect(view.state.doc.textContent).toBe("**x**");

      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      expect(view.state.doc.textContent).toBe("x");
      expect(
        view.state.doc.firstChild?.firstChild?.marks.map(
          (mark) => mark.type.name
        )
      ).toEqual(["strong"]);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("commits the current source when clicking syntax in another line", () => {
    const emphasis = schema.marks.emphasis.create();
    const strong = schema.marks.strong.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("a", [emphasis])),
      schema.node("paragraph", null, schema.text("b", [strong])),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 2),
        plugins: [createMarkSourcePlugin()],
      }),
    });

    try {
      expect(startMarkSource(view, "emphasis")).toBe(true);
      const session = markSourceKey.getState(view.state)!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: session.from,
        inside: -1,
      });
      const at = view.domAtPos(session.from + 1);
      const sourceNode =
        at.node.nodeType === Node.TEXT_NODE
          ? at.node.parentElement
          : (at.node as Element);
      expect(sourceNode?.closest("p")).toBe(
        view.dom.querySelector("p")
      );
      expect(
        sourceSessionBlockElement(view, session)
      ).toBe(view.dom.querySelector("p"));
      const otherLine = view.dom.querySelector("strong")!;
      otherLine.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true })
      );
      expect(markSourceKey.getState(view.state)).toBeNull();
      otherLine.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
      otherLine.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(markSourceKey.getState(view.state)).toBeNull();
      expect(view.state.doc.firstChild?.textContent).toBe("a");
      expect(
        view.state.doc.firstChild?.firstChild?.marks[0].type.name
      ).toBe("emphasis");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("removes the format when both editable delimiters are deleted", () => {
    const state = stateWithText("粗体", 1, 3);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, { state });

    try {
      expect(startMarkSource(view, "strong")).toBe(true);
      expect(view.dom.querySelector("p")?.textContent).toBe("**粗体**");
      const tr = view.state.tr.delete(5, 7).delete(1, 3);
      tr.setSelection(TextSelection.create(tr.doc, 2));
      view.dispatch(tr);
      view.someProp("handleDOMEvents", (handlers) => {
        handlers.blur?.(view, new FocusEvent("blur"));
        return false;
      });

      expect(view.state.doc.textContent).toBe("粗体");
      expect(view.state.doc.firstChild?.firstChild?.marks).toEqual([]);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("places editable delimiter text around the caret", () => {
    const state = stateWithText("", 1, 1);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, { state });

    try {
      expect(startMarkSource(view, "emphasis")).toBe(true);
      const paragraph = view.dom.querySelector("p")!;
      expect(paragraph.textContent).toBe("**");
      expect(markSourceKey.getState(view.state)).toEqual({
        markName: "emphasis",
        from: 1,
        to: 3,
        attrs: undefined,
      });
      expect(view.state.selection.from).toBe(2);
      view.dispatch(view.state.tr.insertText("测试", 2, 2));
      expect(view.dom.querySelector("p")?.textContent).toBe("*测试*");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("does not leak the source mark into text after the source range", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph"),
      schema.node(
        "paragraph",
        null,
        schema.text("正文")
      ),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
      plugins: [createMarkSourcePlugin()],
    });
    const opened = state.applyTransaction(
      createMarkSourceTransaction(state, "strong")!
    ).state;
    expect(
      opened.storedMarks?.some((mark) => mark.type.name === "strong")
    ).toBe(true);
    expect(opened.doc.firstChild?.textContent).toBe("****");
    const typedInside = opened.applyTransaction(
      opened.tr.insertText("粗体", 3, 3)
    ).state;

    const moved = typedInside.applyTransaction(
      typedInside.tr.setSelection(
        TextSelection.create(
          typedInside.doc,
          typedInside.doc.content.size - 1
        )
      )
    ).state;
    expect(markSourceKey.getState(moved)).toBeNull();
    expect(moved.storedMarks ?? []).toEqual([]);
    expect(moved.doc.firstChild?.textContent).toBe("粗体");
    expect(
      moved.doc.firstChild?.firstChild?.marks[0].type.name
    ).toBe("strong");

    const typed = moved.applyTransaction(
      moved.tr.insertText(
        "普通",
        moved.doc.content.size - 1,
        moved.doc.content.size - 1
      )
    ).state;
    let plainTextMarks: readonly import("@milkdown/prose/model").Mark[] = [];
    typed.doc.descendants((node) => {
      if (node.isText && node.text?.includes("普通")) {
        plainTextMarks = node.marks;
      }
    });
    expect(
      plainTextMarks.some((mark) => mark.type.name === "strong")
    ).toBe(false);
  });

  it("clears stored marks when the editor blurs or the pointer clicks outside", () => {
    const state = stateWithText("", 1, 1);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, { state });

    try {
      expect(startMarkSource(view, "strong")).toBe(true);
      view.someProp("handleDOMEvents", (handlers) => {
        handlers.blur?.(view, new FocusEvent("blur"));
        return false;
      });
      expect(markSourceKey.getState(view.state)).toBeNull();
      expect(view.state.storedMarks ?? []).toEqual([]);

      expect(startMarkSource(view, "strong")).toBe(true);
      document.body.dispatchEvent(
        new MouseEvent("click", {
          bubbles: false,
          clientX: 20,
          clientY: 20,
        })
      );
      expect(markSourceKey.getState(view.state)).toBeNull();
      expect(view.state.storedMarks ?? []).toEqual([]);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("reopens a rendered mark when its DOM is clicked", () => {
    const strong = schema.marks.strong.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("粗体", [strong])),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 3),
        plugins: [createMarkSourcePlugin()],
      }),
    });

    try {
      const strongElement = view.dom.querySelector("strong");
      expect(strongElement).not.toBeNull();
      const handled = view.someProp("handleClick", (handler) =>
        handler(
          view,
          2,
          { button: 0, target: strongElement } as MouseEvent
        )
      );
      expect(handled).toBe(true);
      expect(markSourceKey.getState(view.state)).toEqual({
        markName: "strong",
        from: 1,
        to: 7,
        attrs: undefined,
      });
      expect(view.state.selection.empty).toBe(true);
      expect(view.state.selection.from).toBe(4);
      expect(view.dom.querySelector("p")?.textContent).toBe("**粗体**");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("expands a rendered link into Markdown source on click", () => {
    const link = schema.marks.link.create({ href: "https://example.com" });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("链接", [link])),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 2),
        plugins: [createMarkSourcePlugin()],
      }),
    });

    try {
      const anchor = view.dom.querySelector("a");
      expect(anchor).not.toBeNull();
      const handled = view.someProp("handleClick", (handler) =>
        handler(
          view,
          2,
          { button: 0, target: anchor } as MouseEvent
        )
      );
      expect(handled).toBe(true);
      expect(markSourceKey.getState(view.state)).toMatchObject({
        markName: "link",
        from: 1,
      });
      expect(view.dom.querySelector("p")?.textContent).toBe(
        "[链接](https://example.com)"
      );
      expect(view.dom.querySelector("a")?.textContent).toBe("链接");
      const clickEvent = {
        button: 0,
        target: view.dom.querySelector("a"),
        preventDefault: vi.fn(),
      } as unknown as MouseEvent;
      expect(
        view.someProp("handleClick", (handler) =>
          handler(view, 2, clickEvent)
        )
      ).toBe(true);
      expect(clickEvent.preventDefault).toHaveBeenCalled();

      const href = "https://example.com";
      const urlStart =
        (view.state.doc.textContent ?? "").indexOf(href) + 1;
      view.dispatch(
        view.state.tr.insertText(
          "https://openai.com",
          urlStart,
          urlStart + href.length
        )
      );
      expect(view.dom.querySelector("p")?.textContent).toBe(
        "[链接](https://openai.com)"
      );

      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: false })
      );
      const linkedText = view.state.doc.firstChild?.firstChild;
      expect(view.state.doc.textContent).toBe("链接");
      expect(linkedText?.marks[0].attrs.href).toBe(
        "https://openai.com"
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
