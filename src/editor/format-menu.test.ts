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
import type { ObjectMenuContext } from "./object-menu-context";

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
  },
});

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
      await Promise.resolve();
      await Promise.resolve();

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
      await Promise.resolve();
      await Promise.resolve();

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
      await Promise.resolve();
      await Promise.resolve();

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
      await Promise.resolve();
      await Promise.resolve();

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
