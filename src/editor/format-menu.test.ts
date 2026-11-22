import { Schema } from "@milkdown/prose/model";
import {
  AllSelection,
  EditorState,
  NodeSelection,
  TextSelection,
} from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import {
  CellSelection,
  TableMap,
  tableEditing,
  tableNodes,
} from "@milkdown/prose/tables";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import { getAllCellsInTable } from "@milkdown/kit/preset/gfm";
import { describe, expect, it, vi } from "vitest";
import {
  contentEditableSourceCopyText,
  createFormatMenuProsePlugin,
  htmlBlockVisibleText,
  htmlSourceCopyText,
  normalizeClipboardPlainText,
  replaceHtmlBlockSource,
  selectionHtmlSource,
} from "./format-menu";
import { createHtmlBlockNodeView } from "./html-block";
import { IMAGE_SOURCE_CONTEXTMENU_EVENT } from "./image-view";
import {
  createMarkSourcePlugin,
  markSourceKey,
  startMarkSource,
} from "./mark-source";
import { createMathInlineNodeView } from "./math-view";
import {
  createLinkReferenceDefinitionNodeView,
  LINK_REFERENCE_MARK_NAME,
} from "./link-reference-definition";
import {
  createFootnoteDefinitionView,
  createFootnoteReferenceView,
} from "./footnote";
import type { ObjectMenuContext } from "./object-menu-context";

vi.mock("./mathjax", () => ({
  renderMathJaxSvg: vi.fn(async (tex: string) => {
    const output = document.createElement("span");
    output.textContent = tex;
    return output;
  }),
}));

async function flushClipboardTasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    htmlBlock: {
      group: "block",
      atom: true,
      attrs: { value: { default: "" } },
      toDOM: () => ["div", { class: "mt-html-block" }],
    },
    hardbreak: {
      group: "inline",
      inline: true,
      selectable: false,
      toDOM: () => ["br"],
    },
    mathBlock: {
      group: "block",
      atom: true,
      selectable: true,
      toDOM: () => [
        "div",
        { class: "milkdown-math-block" },
        "∑",
      ],
    },
    math_inline: {
      group: "inline",
      content: "text*",
      inline: true,
      atom: true,
      toDOM: () => ["span", { class: "milkdown-math-inline" }, 0],
    },
    yaml: {
      group: "block",
      atom: true,
      attrs: { value: { default: "" } },
      toDOM: () => ["div", { class: "mt-frontmatter" }],
    },
    link_reference_definition: {
      group: "block",
      atom: true,
      attrs: {
        identifier: { default: "" },
        label: { default: "" },
        url: { default: "" },
        title: { default: null },
      },
      toDOM: () => [
        "div",
        { class: "mt-link-reference-definition" },
      ],
    },
    footnote_reference: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { label: { default: "" } },
      toDOM: () => [
        "sup",
        { class: "mt-footnote-reference", "data-type": "footnote_reference" },
      ],
    },
    footnote_definition: {
      group: "block",
      content: "block+",
      attrs: { label: { default: "" } },
      toDOM: () => [
        "dl",
        { class: "mt-footnote-definition", "data-type": "footnote_definition" },
        ["dt"],
        ["dd", 0],
      ],
    },
    diagram: {
      group: "block",
      atom: true,
      attrs: {
        value: { default: "" },
        identity: { default: "test" },
      },
      toDOM: () => ["div", { class: "diagram" }],
    },
    alert: {
      group: "block",
      content: "block+",
      attrs: {
        alertType: { default: "note" },
        title: { default: "" },
      },
      toDOM: (node) => [
        "blockquote",
        {
          class: "md-alert",
          "data-alert": node.attrs.alertType,
          "data-alert-title": node.attrs.title,
        },
        ["span", { class: "md-alert-title" }, "Note"],
        ["div", { class: "md-alert-content" }, 0],
      ],
    },
    blockquote: {
      group: "block",
      content: "block+",
      toDOM: () => ["blockquote", 0],
    },
    codeBlock: {
      group: "block",
      atom: true,
      toDOM: () => [
        "div",
        { class: "milkdown-code-block" },
        [
          "pre",
          { class: "milkdown-code-block-placeholder" },
          ["code", "const value = 1;"],
        ],
      ],
    },
    text: { group: "inline" },
  },
  marks: {
    strong: { toDOM: () => ["strong", 0] },
    link: {
      attrs: {
        href: { default: "" },
        title: { default: null },
      },
      toDOM: (mark) => [
        "a",
        { href: mark.attrs.href, title: mark.attrs.title },
        0,
      ],
    },
    inlineCode: {
      toDOM: () => ["code", 0],
    },
    [LINK_REFERENCE_MARK_NAME]: {
      attrs: {
        identifier: { default: "" },
        label: { default: "" },
        url: { default: "" },
        title: { default: null },
        referenceType: { default: "full" },
      },
      toDOM: (mark) => [
        "a",
        {
          href: mark.attrs.url,
          "data-reference-label": mark.attrs.label,
        },
        0,
      ],
    },
  },
});

function createBlockSourceNodeView(
  hostClass: string,
  editorClass: string
): NodeViewConstructor {
  return (node) => {
    const dom = document.createElement("div");
    dom.className = hostClass;
    let editor: HTMLTextAreaElement | null = null;

    const startEditing = (): void => {
      if (editor) return;
      editor = document.createElement("textarea");
      editor.className = editorClass;
      editor.value = String(node.attrs.value ?? "x");
      editor.addEventListener("blur", () => {
        if (editor) editor.hidden = true;
      });
      dom.replaceChildren(editor);
      editor.focus();
      editor.setSelectionRange(0, editor.value.length);
    };

    dom.addEventListener("click", startEditing);
    return {
      dom,
      update: (updatedNode) => {
        node = updatedNode;
        return true;
      },
    };
  };
}

const tableSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    ...tableNodes({
      tableGroup: "block",
      cellContent: "paragraph",
      cellAttributes: {},
    }),
  },
  marks: {
    link: {
      attrs: { href: { default: "" }, title: { default: null } },
      toDOM: (mark) => [
        "a",
        { href: mark.attrs.href, title: mark.attrs.title },
        0,
      ],
    },
    inlineCode: {
      toDOM: () => ["code", 0],
    },
  },
});

function createTable() {
  const cell = (type: "table_header" | "table_cell", text: string) =>
    tableSchema.node(
      type,
      null,
      tableSchema.node("paragraph", null, tableSchema.text(text))
    );
  return tableSchema.node("table", null, [
    tableSchema.node("table_row", null, [
      cell("table_header", "A"),
      cell("table_header", "B"),
    ]),
    tableSchema.node("table_row", null, [
      cell("table_cell", "A1"),
      cell("table_cell", "B1"),
    ]),
  ]);
}

function createTableView(selection?: CellSelection) {
  const doc = tableSchema.node("doc", null, [
    createTable(),
    tableSchema.node("paragraph"),
  ]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      schema: tableSchema,
      doc,
      selection,
      plugins: [
        tableEditing({ allowTableNodeSelection: true }),
        createFormatMenuProsePlugin(),
      ],
    }),
  });
  return { view, host };
}

describe("copy selection as HTML source", () => {
  it("serializes only the selection and removes ProseMirror clipboard metadata", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", { level: 1 }, schema.text("标题")),
      schema.node("paragraph", null, [
        schema.text("加粗", [schema.marks.strong.create()]),
        schema.text(" 普通文本"),
      ]),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: new AllSelection(doc),
      }),
    });

    try {
      const html = selectionHtmlSource(view);
      expect(html).toBe(
        "<h1>标题</h1>\n<p><strong>加粗</strong> 普通文本</p>"
      );
      expect(html).not.toContain("data-pm-slice");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("returns null when there is no text selection", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
    });

    try {
      expect(selectionHtmlSource(view)).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe("right-click selection preservation", () => {
  it("cancels the native mousedown action without collapsing AllSelection", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("正文")),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: new AllSelection(doc),
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      const target = view.dom.querySelector("p");
      expect(target).not.toBeNull();
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 });
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 2,
      });

      target!.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(view.state.selection).toBeInstanceOf(AllSelection);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("keeps a full table selection when its context menu opens", () => {
    const table = createTable();
    const doc = tableSchema.node("doc", null, [table]);
    const map = TableMap.get(table);
    const seed = TextSelection.create(doc, map.map[0] + 3);
    const cells = getAllCellsInTable(seed)!;
    const selection = CellSelection.create(
      doc,
      cells[0].pos,
      cells[cells.length - 1].pos
    );
    const { view, host } = createTableView(selection);

    try {
      expect(view.state.selection).toBe(selection);
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: cells[0].pos + 1,
        inside: -1,
      });
      view.dom.querySelector("td")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      expect(view.state.selection).toBe(selection);
      const html = selectionHtmlSource(view)!;
      expect(html).toContain("<table");
      for (const text of ["A", "B", "A1", "B1"]) {
        expect(html).toContain(text);
      }

      const clipboard = new Map<string, string>();
      const copyEvent = new Event("copy", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(copyEvent, "clipboardData", {
        value: {
          setData(type: string, value: string) {
            clipboard.set(type, value);
          },
        },
      });
      view.dom.dispatchEvent(copyEvent);

      expect(copyEvent.defaultPrevented).toBe(true);
      const copiedHtml = clipboard.get("text/html") ?? "";
      for (const text of ["A", "B", "A1", "B1"]) {
        expect(copiedHtml).toContain(text);
      }
      expect(copiedHtml).not.toContain("text-align: left");
      expect(clipboard.get("text/plain")).toBe("A   B\nA1  B1");
    } finally {
      // Clear the module-level captured right-click before the next test.
      view.dom.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 })
      );
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      view.destroy();
      host.remove();
    }
  });

  it("keeps a table text selection on right-button mousedown over an inline object", () => {
    const link = tableSchema.marks.link.create({ href: "#target" });
    const linkedCell = (text: string) =>
      tableSchema.node(
        "table_header",
        null,
        tableSchema.node(
          "paragraph",
          null,
          tableSchema.text(text, [link])
        )
      );
    const table = tableSchema.node("table", null, [
      tableSchema.node("table_row", null, [linkedCell("LINK")]),
    ]);
    const doc = tableSchema.node("doc", null, [table]);
    let linkFrom = -1;
    doc.descendants((node, pos) => {
      if (linkFrom < 0 && node.isText) {
        linkFrom = pos;
        return false;
      }
      return true;
    });
    expect(linkFrom).toBeGreaterThan(0);
    const selection = TextSelection.create(doc, linkFrom, linkFrom + 2);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema: tableSchema,
        doc,
        selection,
        plugins: [
          tableEditing({ allowTableNodeSelection: true }),
          createFormatMenuProsePlugin(),
        ],
      }),
    });

    try {
      const anchor = view.dom.querySelector("a");
      expect(anchor).not.toBeNull();
      const nativeSelection = document.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(anchor!);
      nativeSelection.removeAllRanges();
      nativeSelection.addRange(range);
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: linkFrom + 3,
        inside: -1,
      });

      const down = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 10,
        clientY: 10,
      });
      anchor!.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      expect(view.state.selection).toBe(selection);
    } finally {
      view.dom.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 })
      );
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      document.getSelection()?.removeAllRanges();
      view.destroy();
      host.remove();
    }
  });

  it.each(["粘贴为纯文本", "粘贴"])(
    "places %s inside an expanded inline code source",
    async (label) => {
    const readText = vi.fn().mockResolvedValue("PASTE");
    vi.stubGlobal("navigator", {
      clipboard: { readText },
      userAgent: "",
    });
    const inlineCode = schema.marks.inlineCode.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("code", [inlineCode])),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 3),
        plugins: [
          createMarkSourcePlugin(),
          createFormatMenuProsePlugin(),
        ],
      }),
    });

    try {
      expect(startMarkSource(view, "inlineCode")).toBe(true);
      const session = markSourceKey.getState(view.state);
      expect(session).not.toBeNull();
      const pasteText = vi
        .spyOn(view, "pasteText")
        .mockImplementation(() => true);
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: session!.from,
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

      const pasteItem =
        label === "粘贴"
          ? document.querySelector<HTMLButtonElement>(
              '.mt-context-menu__item[aria-label="粘贴"]'
            )
          : Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                ".mt-context-menu__item"
              )
            ).find(
              (item) =>
                item.querySelector(".mt-context-menu__label")
                  ?.textContent === label
            );
      expect(pasteItem).not.toBeUndefined();
      pasteItem!.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        })
      );
      expect(markSourceKey.getState(view.state)).not.toBeNull();
      pasteItem!.click();
      await flushClipboardTasks();

      expect(pasteText).toHaveBeenCalledWith("PASTE");
      expect(markSourceKey.getState(view.state)).not.toBeNull();
      expect(view.state.selection.from).toBeGreaterThan(session!.from);
      expect(view.state.selection.from).toBeLessThan(session!.to);
    } finally {
      view.dom.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 })
      );
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      view.destroy();
      host.remove();
      vi.unstubAllGlobals();
    }
    }
  );

  it.each(["粘贴为纯文本", "粘贴"])(
    "keeps inline math expanded and pastes into its source with %s",
    async (label) => {
      const readText = vi.fn().mockResolvedValue("y");
      vi.stubGlobal("navigator", {
        clipboard: { readText },
        userAgent: "",
      });
      const math = schema.nodes.math_inline.create(
        null,
        schema.text("x")
      );
      const doc = schema.node("doc", null, [
        schema.node("paragraph", null, math),
      ]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 3),
          plugins: [createFormatMenuProsePlugin()],
        }),
        nodeViews: {
          math_inline: createMathInlineNodeView,
        },
      });

      try {
        const mathDom = view.dom.querySelector<HTMLElement>(
          ".milkdown-math-inline"
        )!;
        const input = mathDom.querySelector<HTMLInputElement>(
          ".milkdown-math-inline-input"
        )!;
        mathDom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(mathDom.classList.contains("is-editing")).toBe(true);
        expect(input.value).toBe("$x$");
        vi.spyOn(view, "posAtCoords").mockReturnValue({
          pos: 1,
          inside: 0,
        });
        input.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          })
        );

        const pasteItem =
          label === "粘贴"
            ? document.querySelector<HTMLButtonElement>(
                '.mt-context-menu__item[aria-label="粘贴"]'
              )
            : Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  ".mt-context-menu__item"
                )
              ).find(
                (item) =>
                  item.querySelector(".mt-context-menu__label")
                    ?.textContent === label
              );
        expect(pasteItem).not.toBeUndefined();
        pasteItem!.click();
        await flushClipboardTasks();

        expect(input.value).toBe("$y$");
        expect(input.style.display).toBe("");
        expect(mathDom.classList.contains("is-editing")).toBe(true);
        expect(view.state.doc.firstChild!.firstChild!.textContent).toBe("x");
      } finally {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        view.destroy();
        host.remove();
        vi.unstubAllGlobals();
      }
    }
  );

  const blockSourceCases = [
    {
      name: "math block",
      nodeName: "mathBlock",
      hostSelector: ".milkdown-math-block",
      editorSelector: ".math-block-editor",
    },
    {
      name: "Mermaid block",
      nodeName: "diagram",
      hostSelector: ".diagram",
      editorSelector: ".diagram-editor",
    },
    {
      name: "Front Matter",
      nodeName: "yaml",
      hostSelector: ".mt-frontmatter",
      editorSelector: ".mt-frontmatter-body",
    },
  ] as const;

  it.each(
    blockSourceCases.flatMap((fixture) =>
      ["粘贴", "粘贴为纯文本"].map((label) => ({ ...fixture, label }))
    )
  )(
    "keeps $name source expanded and pastes with $label",
    async ({ nodeName, hostSelector, editorSelector, label }) => {
      const readText = vi.fn().mockResolvedValue("PASTE\r\n");
      vi.stubGlobal("navigator", {
        clipboard: { readText },
        userAgent: "",
      });
      const node = schema.nodes[nodeName].create(
        nodeName === "mathBlock" ? null : { value: "x" }
      );
      const doc = schema.node("doc", null, [node]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 1),
          plugins: [createFormatMenuProsePlugin()],
        }),
        nodeViews: {
          [nodeName]: createBlockSourceNodeView(
            hostSelector.slice(1),
            editorSelector.slice(1)
          ),
        },
      });

      try {
        const block = view.dom.querySelector<HTMLElement>(hostSelector)!;
        block.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        const editor =
          block.querySelector<HTMLTextAreaElement>(editorSelector)!;
        const inputEvents = vi.fn();
        editor.addEventListener("input", inputEvents);
        expect(document.activeElement).toBe(editor);
        expect(editor.value).toBe("x");
        vi.spyOn(view, "posAtCoords").mockReturnValue({
          pos: 1,
          inside: 0,
        });
        editor.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          })
        );

        const pasteItem =
          label === "粘贴"
            ? document.querySelector<HTMLButtonElement>(
                '.mt-context-menu__item[aria-label="粘贴"]'
              )
            : Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  ".mt-context-menu__item"
                )
              ).find(
                (item) =>
                  item.querySelector(".mt-context-menu__label")
                    ?.textContent === label
              );
        expect(pasteItem).not.toBeUndefined();
        expect(pasteItem!.disabled).toBe(false);
        pasteItem!.click();
        await flushClipboardTasks();

        expect(editor.value).toBe("PASTE");
        expect(editor.hidden).toBe(false);
        expect(document.activeElement).toBe(editor);
        expect(inputEvents).toHaveBeenCalledOnce();
      } finally {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        view.destroy();
        host.remove();
        vi.unstubAllGlobals();
      }
    }
  );

  it("inserts an empty link source from the paragraph menu", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 1),
        plugins: [
          createMarkSourcePlugin(),
          createFormatMenuProsePlugin(),
        ],
      }),
    });

    try {
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

      const linkButton = document.querySelector<HTMLButtonElement>(
        '[aria-label="链接"]'
      );
      expect(linkButton).not.toBeNull();
      expect(linkButton?.disabled).toBe(false);
      linkButton?.click();

      expect(view.state.doc.textContent).toBe("[]()");
      expect(view.state.selection.from).toBe(2);
      expect(markSourceKey.getState(view.state)?.markName).toBe("link");

      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      view.someProp("handleKeyDown", (handler) =>
        handler(view, escape)
      );

      expect(markSourceKey.getState(view.state)).toBeNull();
      expect(view.state.doc.textContent).toBe("");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      view.destroy();
      host.remove();
    }
  });

  it("disables plain-text copying without a text selection", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("正文")),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      const target = view.dom.querySelector("p")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 });
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const copyPlainText = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".mt-context-menu__item"
        )
      ).find(
        (item) =>
          item.querySelector(".mt-context-menu__label")?.textContent ===
          "复制为纯文本"
      );
      expect(copyPlainText?.disabled).toBe(true);
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("does not treat an atom node selection as selectable plain text", () => {
    const doc = schema.node("doc", null, [schema.node("mathBlock")]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: NodeSelection.create(doc, 0),
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      const target = view.dom.querySelector(".milkdown-math-block")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 0, inside: -1 });
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const copyPlainText = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".mt-context-menu__item"
        )
      ).find(
        (item) =>
          item.querySelector(".mt-context-menu__label")?.textContent ===
          "复制为纯文本"
      );
      expect(copyPlainText?.disabled).toBe(true);
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe("link reference context menu", () => {
  it("opens the shared menu from a reference definition input", () => {
    const definition = schema.nodes.link_reference_definition.create({
      identifier: "site",
      label: "site",
      url: "https://example.com",
      title: null,
    });
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
      nodeViews: {
        link_reference_definition:
          createLinkReferenceDefinitionNodeView,
      },
    });

    try {
      const input = view.dom.querySelector<HTMLInputElement>(
        '.mt-link-reference-definition [data-field="url"]'
      )!;
      input.focus();
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 1,
        inside: 0,
      });
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      });
      input.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(
        document.querySelector(".mt-context-menu--typora")
      ).not.toBeNull();
      expect(
        Array.from(
          document.querySelectorAll(".mt-context-menu__label")
        ).some((label) => label.textContent === "链接引用")
      ).toBe(true);
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      view.destroy();
      host.remove();
    }
  });

  it("opens the shared menu from a rendered reference link", () => {
    const reference = schema.marks[LINK_REFERENCE_MARK_NAME].create({
      identifier: "site",
      label: "site",
      url: "https://example.com",
      title: null,
      referenceType: "full",
    });
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        schema.text("引用链接", [reference])
      ),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 2,
        inside: 1,
      });
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      });
      view.dom
        .querySelector("a[data-reference-label]")!
        .dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(
        document.querySelector(".mt-context-menu--typora")
      ).not.toBeNull();
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      view.destroy();
      host.remove();
    }
  });

  it.each(
    ["identifier", "url", "title"].flatMap((field) =>
      ["粘贴", "粘贴为纯文本"].map((label) => ({ field, label }))
    )
  )(
    "pastes into the reference $field field with $label",
    async ({ field, label }) => {
      const readText = vi.fn().mockResolvedValue("PASTE");
      vi.stubGlobal("navigator", {
        clipboard: { readText },
        userAgent: "",
      });
      const definition = schema.nodes.link_reference_definition.create({
        identifier: "site",
        label: "site",
        url: "https://example.com",
        title: "title",
      });
      const doc = schema.node("doc", null, [definition]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          plugins: [createFormatMenuProsePlugin()],
        }),
        nodeViews: {
          link_reference_definition:
            createLinkReferenceDefinitionNodeView,
        },
      });

      try {
        const input = view.dom.querySelector<HTMLInputElement>(
          `.mt-link-reference-definition [data-field="${field}"]`
        )!;
        input.focus();
        input.setSelectionRange(0, input.value.length);
        vi.spyOn(view, "posAtCoords").mockReturnValue({
          pos: 1,
          inside: 0,
        });
        input.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          })
        );

        const pasteItem =
          label === "粘贴"
            ? document.querySelector<HTMLButtonElement>(
                '.mt-context-menu__item[aria-label="粘贴"]'
              )
            : Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  ".mt-context-menu__item"
                )
              ).find(
                (item) =>
                  item.querySelector(".mt-context-menu__label")
                    ?.textContent === label
              );
        expect(pasteItem).not.toBeUndefined();
        expect(pasteItem!.disabled).toBe(false);
        pasteItem!.click();
        await flushClipboardTasks();

        expect(input.value).toBe("PASTE");
        expect(document.activeElement).toBe(input);
        expect(input.isConnected).toBe(true);
      } finally {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        view.destroy();
        host.remove();
        vi.unstubAllGlobals();
      }
    }
  );

  it("pastes into the optional title when it was not focused before right-click", async () => {
    const readText = vi.fn().mockResolvedValue("PASTE");
    vi.stubGlobal("navigator", {
      clipboard: { readText },
      userAgent: "",
    });
    const definition = schema.nodes.link_reference_definition.create({
      identifier: "site",
      label: "site",
      url: "https://example.com",
      title: "title",
    });
    const doc = schema.node("doc", null, [definition]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
      nodeViews: {
        link_reference_definition:
          createLinkReferenceDefinitionNodeView,
      },
    });

    try {
      const input = view.dom.querySelector<HTMLInputElement>(
        '.mt-link-reference-definition [data-field="title"]'
      )!;
      input.setSelectionRange(0, input.value.length);
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 1,
        inside: 0,
      });
      input.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const pasteItem = document.querySelector<HTMLButtonElement>(
        '.mt-context-menu__item[aria-label="粘贴"]'
      );
      expect(pasteItem).not.toBeNull();
      expect(pasteItem!.disabled).toBe(false);
      pasteItem!.click();
      await flushClipboardTasks();

      expect(input.value).toBe("PASTE");
      expect(document.activeElement).toBe(input);
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      view.destroy();
      host.remove();
      vi.unstubAllGlobals();
    }
  });
});

describe("footnote context menu", () => {
  it("opens the shared menu from a footnote reference index", () => {
    const reference = schema.nodes.footnote_reference.create({ label: "1" });
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        [schema.text("正文"), reference]
      ),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
      nodeViews: {
        footnote_reference: createFootnoteReferenceView,
      },
    });

    try {
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 3,
        inside: 1,
      });
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      });
      view.dom
        .querySelector(".mt-footnote-reference")!
        .dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(
        document.querySelector(".mt-context-menu--typora")
      ).not.toBeNull();
      expect(
        Array.from(
          document.querySelectorAll(".mt-context-menu__label")
        ).some((label) => label.textContent === "脚注索引")
      ).toBe(true);
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      view.destroy();
      host.remove();
    }
  });

  it.each(["粘贴", "粘贴为纯文本"])(
    "keeps %s inside the footnote explanation",
    async (label) => {
      const readText = vi.fn().mockResolvedValue("PASTE");
      vi.stubGlobal("navigator", {
        clipboard: { readText },
        userAgent: "",
      });
      const definition = schema.nodes.footnote_definition.create(
        { label: "1" },
        schema.node("paragraph", null, schema.text("note"))
      );
      const doc = schema.node("doc", null, [
        definition,
        schema.node("paragraph", null, schema.text("outside")),
      ]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 3),
          plugins: [createFormatMenuProsePlugin()],
        }),
        nodeViews: {
          footnote_definition: createFootnoteDefinitionView,
        },
      });

      try {
        const note = view.dom.querySelector(
          '[data-type="footnote_definition"] dd p'
        )!;
        const noteContainer = note.closest("dd")!;
        const noteStart = view.posAtDOM(note, 0, 1);
        vi.spyOn(view, "posAtCoords").mockReturnValue({
          pos: noteStart + 2,
          inside: noteStart - 1,
        });
        const pasteText = vi
          .spyOn(view, "pasteText")
          .mockImplementation(() => true);
        noteContainer.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          })
        );

        const pasteItem =
          label === "粘贴"
            ? document.querySelector<HTMLButtonElement>(
                '.mt-context-menu__item[aria-label="粘贴"]'
              )
            : Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  ".mt-context-menu__item"
                )
              ).find(
                (item) =>
                  item.querySelector(".mt-context-menu__label")
                    ?.textContent === label
              );
        expect(pasteItem).not.toBeUndefined();
        pasteItem!.click();
        await flushClipboardTasks();

        expect(pasteText).toHaveBeenCalledWith("PASTE");
        expect(view.state.selection.$from.parent.textContent).toBe("note");
      } finally {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        view.destroy();
        host.remove();
        vi.unstubAllGlobals();
      }
    }
  );

  it.each(
    ["reference", "definition"].flatMap((kind) =>
      ["粘贴", "粘贴为纯文本"].map((label) => ({ kind, label }))
    )
  )(
    "pastes into the $kind number editor with $label",
    async ({ kind, label }) => {
      const readText = vi.fn().mockResolvedValue("2");
      vi.stubGlobal("navigator", {
        clipboard: { readText },
        userAgent: "",
      });
      const reference = schema.nodes.footnote_reference.create({ label: "1" });
      const definition = schema.nodes.footnote_definition.create(
        { label: "1" },
        schema.node("paragraph", null, schema.text("note"))
      );
      const doc = schema.node("doc", null, [
        schema.node(
          "paragraph",
          null,
          kind === "reference"
            ? [schema.text("正文"), reference]
            : schema.text("正文")
        ),
        definition,
      ]);
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          plugins: [createFormatMenuProsePlugin()],
        }),
        nodeViews: {
          footnote_reference: createFootnoteReferenceView,
          footnote_definition: createFootnoteDefinitionView,
        },
      });

      try {
        const trigger =
          kind === "reference"
            ? view.dom.querySelector<HTMLElement>(
                ".mt-footnote-reference"
              )!
            : view.dom.querySelector<HTMLElement>(
                '[data-type="footnote_definition"] dt'
              )!;
        trigger.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            button: 0,
          })
        );
        const source = view.dom.querySelector<HTMLInputElement>(
          ".mt-footnote-label-source"
        )!;
        expect(source.style.display).toBe("inline-block");
        source.setSelectionRange(2, 3);

        const note = view.dom.querySelector(
          '[data-type="footnote_definition"] dd p'
        )!;
        const noteStart = view.posAtDOM(note, 0, 1);
        vi.spyOn(view, "posAtCoords").mockReturnValue({
          pos: noteStart + 1,
          inside: noteStart - 1,
        });
        source.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          })
        );

        const pasteItem =
          label === "粘贴"
            ? document.querySelector<HTMLButtonElement>(
                '.mt-context-menu__item[aria-label="粘贴"]'
              )
            : Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  ".mt-context-menu__item"
                )
              ).find(
                (item) =>
                  item.querySelector(".mt-context-menu__label")
                    ?.textContent === label
              );
        expect(pasteItem).not.toBeUndefined();
        pasteItem!.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            button: 0,
          })
        );
        pasteItem!.click();
        await flushClipboardTasks();

        expect(source.value).toBe(
          kind === "reference" ? "[^2]" : "[^2]:"
        );
        expect(source.isConnected).toBe(true);
      } finally {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        view.destroy();
        host.remove();
        vi.unstubAllGlobals();
      }
    }
  );
});

describe("HTML source context menu", () => {
  it("uses the shared context menu shell with source-only actions", () => {
    const html = schema.nodes.htmlBlock.create({
      value: "<p>HTML 源码</p>",
    });
    const doc = schema.node("doc", null, [html]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
      nodeViews: { htmlBlock: createHtmlBlockNodeView },
    });

    try {
      const button = view.dom.querySelector<HTMLButtonElement>(
        ".mt-html-block-edit"
      );
      const textarea = view.dom.querySelector<HTMLTextAreaElement>(
        ".mt-html-block-body"
      );
      expect(button).not.toBeNull();
      expect(textarea).not.toBeNull();

      button!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      expect(textarea!.style.display).toBe("");

      const contextEvent = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 36,
        clientY: 48,
      });
      textarea!.dispatchEvent(contextEvent);

      expect(contextEvent.defaultPrevented).toBe(true);
      const menu = document.querySelector<HTMLElement>(
        ".mt-context-menu--typora"
      );
      expect(menu).not.toBeNull();
      const labels = Array.from(
        menu!.querySelectorAll(".mt-context-menu__label")
      ).map((node) => node.textContent);
      expect(labels).toContain("复制 / 粘贴为…");
      expect(labels).toContain("HTML 源码");
      expect(labels).toContain("段落");
      expect(labels).not.toContain("一级标题");
      expect(labels).not.toContain("完成编辑");
      expect(labels).not.toContain("取消编辑");
      expect(labels).toContain("插入");
      expect(
        menu!.querySelector('[aria-label="加粗"]')
      ).not.toBeNull();
      const copyPlainText = Array.from(
        menu!.querySelectorAll<HTMLButtonElement>(
          ".mt-context-menu__item"
        )
      ).find(
        (item) =>
          item.querySelector(".mt-context-menu__label")?.textContent ===
          "复制为纯文本"
      );
      expect(copyPlainText?.disabled).toBe(false);

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      expect(document.querySelector(".mt-context-menu")).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("converts the live source editor value to a paragraph", () => {
    const html = schema.nodes.htmlBlock.create({
      value: "<p>旧内容</p>",
    });
    const doc = schema.node("doc", null, [html]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
      nodeViews: { htmlBlock: createHtmlBlockNodeView },
    });

    try {
      const button = view.dom.querySelector<HTMLButtonElement>(
        ".mt-html-block-edit"
      );
      const textarea = view.dom.querySelector<HTMLTextAreaElement>(
        ".mt-html-block-body"
      );
      Object.defineProperty(view, "scrollToSelection", {
        configurable: true,
        value: () => {},
      });
      button!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      textarea!.value = "第一行\n\n第三行";
      textarea!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 36,
          clientY: 48,
        })
      );

      const menu = document.querySelector<HTMLElement>(
        ".mt-context-menu--typora"
      );
      const paragraph = Array.from(
        menu!.querySelectorAll<HTMLButtonElement>(".mt-context-menu__item")
      ).find(
        (item) =>
          item.querySelector(".mt-context-menu__label")?.textContent ===
          "段落"
      );
      expect(paragraph).not.toBeUndefined();
      paragraph!.click();

      expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
      expect(view.state.doc.firstChild?.textContent).toBe("第一行第三行");
      expect(
        view.state.doc.firstChild?.content.content.filter(
          (child) => child.type.name === "hardbreak"
        )
      ).toHaveLength(2);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe("code block context menu", () => {
  it("copies the quick-copy source with Markdown fences", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const doc = schema.node("doc", null, [schema.node("codeBlock")]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      const target = view.dom.querySelector(".milkdown-code-block")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 0, inside: -1 });
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const copy = document.querySelector<HTMLButtonElement>(
        '[aria-label="复制代码源码"]'
      );
      expect(copy?.disabled).toBe(false);
      copy?.click();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith(
        "```\nconst value = 1;\n```"
      );
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });

  it("uses copy-as-plain-text instead of a separate whole-code item", () => {
    const doc = schema.node("doc", null, [schema.node("codeBlock")]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      const target = view.dom.querySelector(".milkdown-code-block")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 0, inside: -1 });
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const menu = document.querySelector<HTMLElement>(
        ".mt-context-menu--typora"
      );
      expect(menu).not.toBeNull();
      const labels = Array.from(
        menu!.querySelectorAll(".mt-context-menu__label")
      ).map((node) => node.textContent);
      expect(labels).toContain("复制为纯文本");
      expect(labels).not.toContain("复制整段代码");
      const copyPlainText = Array.from(
        menu!.querySelectorAll<HTMLButtonElement>(
          ".mt-context-menu__item"
        )
      ).find(
        (item) =>
          item.querySelector(".mt-context-menu__label")?.textContent ===
          "复制为纯文本"
      );
      expect(copyPlainText?.disabled).toBe(false);
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe("table quick copy", () => {
  it.each(["粘贴为纯文本", "粘贴"])(
    "strips the clipboard trailing newline when using %s in a table",
    async (label) => {
      const readText = vi.fn().mockResolvedValue("PASTE\r\n");
      vi.stubGlobal("navigator", {
        clipboard: { readText },
        userAgent: "",
      });
      const { view, host } = createTableView();

      try {
        const table = view.state.doc.firstChild!;
        const map = TableMap.get(table);
        vi.spyOn(view, "posAtCoords").mockReturnValue({
          pos: map.map[0] + 3,
          inside: -1,
        });
        const pasteText = vi
          .spyOn(view, "pasteText")
          .mockImplementation(() => true);
        view.dom.querySelector("td")!.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          })
        );

        const pasteItem =
          label === "粘贴"
            ? document.querySelector<HTMLButtonElement>(
                '.mt-context-menu__item[aria-label="粘贴"]'
              )
            : Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                  ".mt-context-menu__item"
                )
              ).find(
                (item) =>
                  item.querySelector(".mt-context-menu__label")
                    ?.textContent === label
              );
        expect(pasteItem).not.toBeUndefined();
        pasteItem!.click();
        await flushClipboardTasks();

        if (label === "粘贴") {
          expect(pasteText).toHaveBeenCalledWith("PASTE");
        } else {
          expect(pasteText).not.toHaveBeenCalled();
          let pastedText = "";
          view.state.doc.descendants((node) => {
            if (node.isText && node.text?.includes("PASTE")) {
              pastedText = node.text;
            }
          });
          expect(pastedText).toContain("PASTE");
          expect(pastedText).not.toMatch(/[\r\n]/);
        }
      } finally {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        vi.unstubAllGlobals();
        view.destroy();
        host.remove();
      }
    }
  );

  it("copies the current table as Markdown source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const { view, host } = createTableView();

    try {
      const table = view.state.doc.firstChild!;
      const map = TableMap.get(table);
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: map.map[0] + 3,
        inside: -1,
      });
      view.dom.querySelector("td")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const copy = document.querySelector<HTMLButtonElement>(
        '[aria-label="复制表格源码"]'
      );
      expect(copy?.disabled).toBe(false);
      copy?.click();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith(
        "| A | B |\n| --- | --- |\n| A1 | B1 |"
      );
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });

  it("cuts table source only after the clipboard write succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const { view, host } = createTableView();

    try {
      const table = view.state.doc.firstChild!;
      const map = TableMap.get(table);
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: map.map[0] + 3,
        inside: -1,
      });
      view.dom.querySelector("td")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="剪切表格源码"]'
        )
        ?.click();
      await flushClipboardTasks();

      expect(writeText).toHaveBeenCalledWith(
        "| A | B |\n| --- | --- |\n| A1 | B1 |"
      );
      expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });

  it("uses the Markdown serializer for an ordinary text selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        schema.text("bold", [schema.marks.strong.create()])
      ),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 1, 5),
        plugins: [createFormatMenuProsePlugin(() => "**bold**")],
      }),
    });

    try {
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

      const copy = document.querySelector<HTMLButtonElement>(
        '[aria-label="复制 Markdown 源码"]'
      );
      expect(copy?.disabled).toBe(false);
      copy?.click();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith("**bold**");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });

  it("cuts an ordinary selection as Markdown source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        schema.text("bold", [schema.marks.strong.create()])
      ),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 1, 5),
        plugins: [createFormatMenuProsePlugin(() => "**bold**")],
      }),
    });

    try {
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

      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="剪切 Markdown 源码"]'
        )
        ?.click();
      await flushClipboardTasks();

      expect(writeText).toHaveBeenCalledWith("**bold**");
      expect(view.state.doc.textContent).toBe("");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });
});

describe("diagram quick copy", () => {
  it("copies Mermaid source inside a Markdown code fence", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const diagram = schema.nodes.diagram.create({
      value: "graph TD\nA-->B",
    });
    const doc = schema.node("doc", null, [diagram]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      const target = view.dom.querySelector(".diagram")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 0, inside: -1 });
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const copy = document.querySelector<HTMLButtonElement>(
        '[aria-label="复制组件源码"]'
      );
      expect(copy?.disabled).toBe(false);
      copy?.click();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith(
        "```mermaid\ngraph TD\nA-->B\n```"
      );
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });
});

describe("alert quick copy", () => {
  it("copies the complete alert blockquote source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const alert = schema.nodes.alert.create(
      { alertType: "note", title: "提醒" },
      schema.node("paragraph", null, schema.text("正文"))
    );
    const doc = schema.node("doc", null, [alert]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      const target = view.dom.querySelector(".md-alert-title")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 });
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const copy = document.querySelector<HTMLButtonElement>(
        '[aria-label="复制组件源码"]'
      );
      expect(copy?.disabled).toBe(false);
      copy?.click();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith(
        "> [!NOTE] 提醒\n> 正文"
      );
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });

  it("cuts the entire alert when invoked from its body", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const alert = schema.nodes.alert.create(
      { alertType: "warning", title: "注意" },
      schema.node("paragraph", null, schema.text("正文"))
    );
    const doc = schema.node("doc", null, [alert]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      const target = view.dom.querySelector(".md-alert-content p")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 3, inside: -1 });
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="剪切 Alert 源码"]'
        )
        ?.click();
      await flushClipboardTasks();

      expect(writeText).toHaveBeenCalledWith(
        "> [!WARNING] 注意\n> 正文"
      );
      expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });
});

describe("blockquote quick cut", () => {
  it("cuts the complete blockquote source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const quote = schema.nodes.blockquote.create(
      null,
      schema.node("paragraph", null, schema.text("引用文字"))
    );
    const doc = schema.node("doc", null, [quote]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      const target = view.dom.querySelector("blockquote p")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 3, inside: -1 });
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="剪切引用源码"]'
        )
        ?.click();
      await flushClipboardTasks();

      expect(writeText).toHaveBeenCalledWith("> 引用文字");
      expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });
});

describe("blockquote quick copy", () => {
  it("preserves inline code in the copied Markdown source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });
    const quote = schema.nodes.blockquote.create(
      null,
      schema.node(
        "paragraph",
        null,
        schema.text("code", [schema.marks.inlineCode.create()])
      )
    );
    const doc = schema.node("doc", null, [quote]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [
          createFormatMenuProsePlugin((node) => {
            expect(node.type.name).toBe("doc");
            return "> `code`";
          }),
        ],
      }),
    });

    try {
      const target = view.dom.querySelector("blockquote code")!;
      vi.spyOn(view, "posAtCoords").mockReturnValue({
        pos: 3,
        inside: -1,
      });
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        })
      );

      const copy = document.querySelector<HTMLButtonElement>(
        '[aria-label="复制引用源码"]'
      );
      expect(copy?.disabled).toBe(false);
      copy?.click();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledWith("> `code`");
    } finally {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
      vi.unstubAllGlobals();
      view.destroy();
      host.remove();
    }
  });
});

describe("image source context menu", () => {
  it("opens the shared menu from the contenteditable image source", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("正文")),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({
        schema,
        doc,
        plugins: [createFormatMenuProsePlugin()],
      }),
    });

    try {
      vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 });
      const wrapper = document.createElement("span");
      wrapper.className = "mt-image-node";
      const image = document.createElement("img");
      const source = document.createElement("span");
      source.className = "mt-image-source";
      source.textContent = "![说明](image.png)";
      wrapper.append(image, source);
      view.dom.appendChild(wrapper);

      source.dispatchEvent(
        new CustomEvent(IMAGE_SOURCE_CONTEXTMENU_EVENT, {
          bubbles: true,
          cancelable: true,
          detail: { clientX: 12, clientY: 16 },
        })
      );

      const menu = document.querySelector<HTMLElement>(
        ".mt-context-menu--typora"
      );
      expect(menu).not.toBeNull();
      const labels = Array.from(
        menu!.querySelectorAll(".mt-context-menu__label")
      ).map((node) => node.textContent);
      expect(labels).toContain("复制为图片");
      expect(labels).toContain("复制为纯文本");
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("copies the source selection or the full image markdown", () => {
    const source = document.createElement("span");
    source.textContent = "![说明](image.png)";

    expect(contentEditableSourceCopyText(source)).toBe(
      "![说明](image.png)"
    );
    expect(
      contentEditableSourceCopyText(source, { start: 0, end: 5 })
    ).toBe("![说明]");
  });
});

describe("plain-text clipboard line endings", () => {
  it("uses CRLF for Windows CF_UNICODETEXT", () => {
    expect(
      normalizeClipboardPlainText("title: Test\n\nbody\r\nlast\rend", true)
    ).toBe("title: Test\r\n\r\nbody\r\nlast\r\nend");
  });

  it("leaves line endings unchanged on non-Windows platforms", () => {
    const source = "title: Test\n\nbody";
    expect(normalizeClipboardPlainText(source, false)).toBe(source);
  });
});

describe("HTML block clipboard semantics", () => {
  it("copies the source selection or the full source when nothing is selected", () => {
    const editor = document.createElement("textarea");
    editor.value = "第一行\n第二行";

    editor.setSelectionRange(0, 0);
    expect(htmlSourceCopyText(editor)).toBe("第一行\n第二行");

    editor.setSelectionRange(0, 3);
    expect(htmlSourceCopyText(editor)).toBe("第一行");
  });

  it("copies rendered preview text without the HTML toolbar", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button class="mt-html-block-edit">HTML &lt;/&gt;</button>
      <div class="mt-html-block-preview"><p>可见文字</p></div>
    `;

    expect(htmlBlockVisibleText(root)).toBe("可见文字");
  });

  it("replaces the HTML source in place", () => {
    const htmlBlock = schema.nodes.htmlBlock.create({ value: "<p>旧</p>" });
    const doc = schema.node("doc", null, [htmlBlock]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
    });

    try {
      const context = {
        kind: "html-block",
        element: document.createElement("div"),
        container: document.createElement("div"),
        node: doc.firstChild,
        pos: 0,
        source: "<p>旧</p>",
      } satisfies ObjectMenuContext;

      expect(
        replaceHtmlBlockSource(view, context, "<p>新内容</p>")
      ).toBe(true);
      expect(view.state.doc.firstChild?.attrs.value).toBe("<p>新内容</p>");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
