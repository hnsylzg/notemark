import { Schema, type Node as PMNode } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it } from "vitest";
import {
  canConvertBlockSourceToHeading,
  convertObjectBlockToTextblock,
  convertFrontmatterToParagraph,
  objectClipboardSource,
  objectPlainTextSource,
  resolveObjectMenuContext,
} from "./object-menu-context";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    blockquote: {
      group: "block",
      content: "block+",
      toDOM: () => ["blockquote", 0],
    },
    heading: {
      group: "block",
      content: "inline*",
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    horizontal_rule: {
      group: "block",
      toDOM: () => ["hr"],
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
        { "data-type": "footnote_reference" },
      ],
    },
    alert: {
      group: "block",
      content: "block+",
      attrs: {
        alertType: { default: "note" },
        title: { default: "" },
      },
      toDOM: () => [
        "blockquote",
        { class: "md-alert" },
        ["span", { class: "md-alert-title" }, "Note"],
        ["div", { class: "md-alert-content" }, 0],
      ],
    },
    image: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { src: { default: "" }, alt: { default: "" } },
      toDOM: (node) => [
        "span",
        { class: "mt-image-node" },
        [
          "img",
          {
            src: node.attrs.src,
            "data-md-src": node.attrs.src,
            alt: node.attrs.alt,
          },
        ],
      ],
    },
    hardbreak: {
      group: "inline",
      inline: true,
      selectable: false,
      toDOM: () => ["br"],
    },
    yaml: {
      group: "block",
      atom: true,
      attrs: { value: { default: "" } },
      toDOM: (node) => [
        "div",
        { class: "mt-frontmatter" },
        ["pre", node.attrs.value],
      ],
    },
    text: { group: "inline" },
  },
});

function mount(doc: PMNode): {
  view: EditorView;
  host: HTMLElement;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({ schema, doc }),
  });
  return { view, host };
}

describe("object menu context", () => {
  it("only offers heading conversion for non-empty single-line source", () => {
    expect(canConvertBlockSourceToHeading("title: Test")).toBe(true);
    expect(canConvertBlockSourceToHeading("title: Test\ntags: note")).toBe(
      false
    );
    expect(canConvertBlockSourceToHeading("   ")).toBe(false);
  });

  it("leaves inline images to the containing textblock menu", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node("paragraph", null, [
          schema.node("image", { src: "assets/a.png", alt: "A" }),
        ]),
      ])
    );

    try {
      const target = view.dom.querySelector("img")!;
      expect(resolveObjectMenuContext(view, target)).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("resolves horizontal rules as atomic objects", () => {
    const { view, host } = mount(
      schema.node("doc", null, [schema.node("horizontal_rule")])
    );

    try {
      const target = view.dom.querySelector("hr")!;
      expect(resolveObjectMenuContext(view, target)?.kind).toBe(
        "horizontal-rule"
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("resolves link reference definitions and preserves their source", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node("link_reference_definition", {
          identifier: "site",
          label: "site",
          url: "https://example.com",
          title: "Example",
        }),
      ])
    );

    try {
      const target = view.dom.querySelector(
        ".mt-link-reference-definition"
      )!;
      const context = resolveObjectMenuContext(view, target);
      expect(context?.kind).toBe("link-reference-definition");
      expect(context && objectClipboardSource(context)).toBe(
        '[site]: https://example.com "Example"'
      );
      expect(context && objectPlainTextSource(context)).toBe(
        '[site]: https://example.com "Example"'
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("resolves footnote references as objects", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node("paragraph", null, [
          schema.text("正文"),
          schema.node("footnote_reference", { label: "1" }),
        ]),
      ])
    );

    try {
      const target = view.dom.querySelector(
        '[data-type="footnote_reference"]'
      )!;
      const context = resolveObjectMenuContext(view, target);
      expect(context?.kind).toBe("footnote-reference");
      expect(context && objectClipboardSource(context)).toBe("[^1]");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("resolves the alert marker separately from its content paragraphs", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node("alert", null, [
          schema.node("paragraph", null, schema.text("Alert 正文")),
        ]),
      ])
    );

    try {
      const body = view.dom.querySelector(".md-alert-content p")!;
      expect(resolveObjectMenuContext(view, body)).toBeNull();

      const marker = view.dom.querySelector(".md-alert-title")!;
      const context = resolveObjectMenuContext(view, marker);
      expect(context?.kind).toBe("alert-title");
      expect(context?.element.className).toBe("md-alert-title");
      expect(context?.container.className).toBe("md-alert");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("converts a multiline alert into a heading while preserving lines", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node("alert", null, [
          schema.node("paragraph", null, schema.text("第一行")),
          schema.node("paragraph", null, schema.text("第二行")),
        ]),
      ])
    );

    try {
      const marker = view.dom.querySelector(".md-alert-title")!;
      const context = resolveObjectMenuContext(view, marker)!;
      expect(
        convertObjectBlockToTextblock(view, context, {
          type: "heading",
          level: 2,
        })
      ).toBe(true);

      const quote = view.state.doc.child(0);
      expect(quote.type.name).toBe("blockquote");
      expect(quote.child(0).type.name).toBe("heading");
      expect(quote.child(0).attrs.level).toBe(2);
      expect(quote.child(0).textContent).toBe("[!NOTE]");
      expect(quote.child(1).textContent).toBe("第一行");
      expect(quote.child(2).textContent).toBe("第二行");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("keeps the Important marker separate from the converted heading", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node(
          "alert",
          { alertType: "important", title: "关键说明" },
          [schema.node("paragraph", null, schema.text("正文内容"))]
        ),
      ])
    );

    try {
      const marker = view.dom.querySelector(".md-alert-title")!;
      const context = resolveObjectMenuContext(view, marker)!;
      expect(
        convertObjectBlockToTextblock(view, context, {
          type: "heading",
          level: 1,
        })
      ).toBe(true);

      const quote = view.state.doc.child(0);
      expect(quote.type.name).toBe("blockquote");
      expect(quote.child(0).type.name).toBe("heading");
      expect(quote.child(0).textContent).toBe("[!IMPORTANT]");
      expect(quote.child(1).textContent).toBe("关键说明");
      expect(quote.child(2).textContent).toBe("正文内容");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("splits an Important alert into marker and content paragraphs", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node(
          "alert",
          { alertType: "important", title: "关键说明" },
          [schema.node("paragraph", null, schema.text("正文内容"))]
        ),
      ])
    );

    try {
      const marker = view.dom.querySelector(".md-alert-title")!;
      const context = resolveObjectMenuContext(view, marker)!;
      expect(
        convertObjectBlockToTextblock(view, context, { type: "paragraph" })
      ).toBe(true);

      const quote = view.state.doc.child(0);
      expect(quote.type.name).toBe("blockquote");
      expect(quote.child(0).type.name).toBe("paragraph");
      expect(quote.child(0).textContent).toBe("[!IMPORTANT]");
      expect(quote.child(1).textContent).toBe("关键说明");
      expect(quote.child(2).textContent).toBe("正文内容");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("converts Front Matter into a paragraph with its source preserved", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node("yaml", { value: "title: Test\n\ntags: note" }),
      ])
    );

    try {
      const target = view.dom.querySelector(".mt-frontmatter")!;
      const context = resolveObjectMenuContext(view, target);
      expect(context?.kind).toBe("frontmatter");
      expect(context && objectClipboardSource(context)).toBe(
        "---\ntitle: Test\n\ntags: note\n---"
      );
      expect(context && objectPlainTextSource(context)).toBe(
        "title: Test\n\ntags: note"
      );
      expect(context && convertFrontmatterToParagraph(view, context)).toBe(
        true
      );

      const paragraph = view.state.doc.firstChild!;
      expect(paragraph.type.name).toBe("paragraph");
      expect(paragraph.textContent).toBe("title: Testtags: note");
      expect(
        paragraph.content.content.filter(
          (child) => child.type.name === "hardbreak"
        )
      ).toHaveLength(2);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("keeps Front Matter plain text free of delimiters and trailing-data loss", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node("yaml", { value: "title: Test\r\n\r\n" }),
      ])
    );

    try {
      const target = view.dom.querySelector(".mt-frontmatter")!;
      const context = resolveObjectMenuContext(view, target)!;
      expect(objectPlainTextSource(context)).toBe("title: Test\n\n");
      expect(objectClipboardSource(context)).toBe("---\ntitle: Test\n---");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("converts Front Matter into a heading without losing its source", () => {
    const { view, host } = mount(
      schema.node("doc", null, [
        schema.node("yaml", { value: "title: Test\ntags: note" }),
      ])
    );

    try {
      const target = view.dom.querySelector(".mt-frontmatter")!;
      const context = resolveObjectMenuContext(view, target)!;
      expect(
        convertObjectBlockToTextblock(view, context, {
          type: "heading",
          level: 2,
        })
      ).toBe(true);

      const heading = view.state.doc.firstChild!;
      expect(heading.type.name).toBe("heading");
      expect(heading.attrs.level).toBe(2);
      expect(heading.textContent).toBe("title: Testtags: note");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
