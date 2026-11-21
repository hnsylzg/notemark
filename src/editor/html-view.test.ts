import { Schema } from "@milkdown/prose/model";
import { undoDepth } from "@milkdown/prose/history";
import { EditorState, NodeSelection, TextSelection } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it, vi } from "vitest";
import {
  createInlineHtmlNodeView,
  sanitizeHtml,
  sanitizeHtmlBlock,
} from "./html-view";

describe("HTML sanitizer", () => {
  it("removes scripts, event handlers and dangerous URL protocols", () => {
    const result = sanitizeHtml(
      '<span onclick="alert(1)">safe</span><script>alert(1)</script><a href="javascript:alert(1)">bad</a>'
    );
    expect(result).toContain("safe");
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("<script");
    expect(result).not.toContain("javascript:");
  });

  it("forces remote iframes into an opaque sandbox", () => {
    const result = sanitizeHtml(
      '<iframe src="https://example.com/embed" sandbox="allow-top-navigation" allow="camera; fullscreen"></iframe>'
    );
    expect(result).toContain('sandbox="allow-scripts allow-presentation allow-popups');
    expect(result).not.toContain("allow-top-navigation");
    expect(result).not.toContain("camera");
    expect(result).toContain("referrerpolicy=\"no-referrer\"");
    expect(result).toContain("allowfullscreen");
    expect(result).toContain("autoplay");
    expect(result).toContain("encrypted-media");
    expect(result).toContain("picture-in-picture");
    expect(result).not.toContain("allow-same-origin");
  });

  it("allows same-origin requests only for Python Tutor embeds", () => {
    const pythonTutor = sanitizeHtml(
      '<iframe src="https://pythontutor.com/iframe-embed.html#code=print(1)" height="620"></iframe>'
    );
    const untrusted = sanitizeHtml(
      '<iframe src="https://example.com/embed"></iframe>'
    );

    expect(pythonTutor).toContain("allow-same-origin");
    expect(pythonTutor).toContain('data-md-embed-provider="pythontutor"');
    expect(pythonTutor).toContain('height="620"');
    expect(untrusted).not.toContain("allow-same-origin");
  });

  it("grants explicit media hosts the permissions required for playback", () => {
    const youtube = sanitizeHtml(
      '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>'
    );
    const bilibili = sanitizeHtmlBlock(
      '<iframe src="https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7" width="480" height="270"></iframe>'
    );

    for (const result of [youtube, bilibili]) {
      expect(result).toContain("allow-scripts");
      expect(result).toContain("allow-same-origin");
      expect(result).toContain(
        'referrerpolicy="strict-origin-when-cross-origin"'
      );
      expect(result).toContain('data-md-embed-provider="media"');
      expect(result).toContain("allowfullscreen");
      expect(result).toContain("encrypted-media");
      expect(result).not.toContain("no-referrer");
    }
  });

  it("sanitizes block HTML with the same frame policy", () => {
    const result = sanitizeHtmlBlock(
      '<div><iframe src="https://example.com" allow="top-navigation"></iframe></div>'
    );
    expect(result).toContain("md-iframe-wrap");
    expect(result).not.toContain("top-navigation");
  });

  it("normalizes HTML table cells to the Markdown table paragraph structure", () => {
    const result = sanitizeHtmlBlock(
      "<table><tbody><tr><td>张三</td><td><strong>20</strong></td></tr></tbody></table>"
    );

    expect(result).toContain("<td><p>张三</p></td>");
    expect(result).toContain("<td><p><strong>20</strong></p></td>");
  });

  it("normalizes inline HTML blockquote content without changing block structure", () => {
    const result = sanitizeHtmlBlock(
      "<blockquote>普通引用</blockquote><blockquote><p>已有段落</p></blockquote>"
    );

    expect(result).toContain("<blockquote><p>普通引用</p></blockquote>");
    expect(result).toContain("<blockquote><p>已有段落</p></blockquote>");
  });
});

describe("inline HTML source editing", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: {
        group: "block",
        content: "inline*",
        toDOM: () => ["p", 0],
      },
      text: { group: "inline" },
      html: {
        group: "inline",
        inline: true,
        atom: true,
        attrs: { value: { default: "" } },
        toDOM: () => ["span", { "data-html-node": "true" }],
      },
    },
  });

  function createView(value: string) {
    const html = schema.nodes.html.create({ value });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, html),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: { html: createInlineHtmlNodeView },
    });
    return { view, host };
  }

  it("opens paired text HTML without dispatching when unchanged", () => {
    const { view, host } = createView("<mark>高亮</mark>");

    try {
      const preview = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-preview"
      )!;
      const source = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-source"
      )!;
      const dispatch = vi.spyOn(view, "dispatch");

      preview.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(source.hidden).toBe(false);
      source.dispatchEvent(new FocusEvent("blur"));

      expect(dispatch).not.toHaveBeenCalled();
      expect(view.state.doc.firstChild?.firstChild?.attrs.value).toBe(
        "<mark>高亮</mark>"
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("enters editing on mousedown without selecting the atom", () => {
    const { view, host } = createView("<mark>高亮</mark>");

    try {
      const preview = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-preview"
      )!;
      const source = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-source"
      )!;
      const selectionBefore = view.state.selection.toJSON();
      const docBefore = view.state.doc.toJSON();
      const depthBefore = undoDepth(view.state);
      const dispatch = vi.spyOn(view, "dispatch");

      preview.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        })
      );

      expect(source.hidden).toBe(false);
      expect(view.state.selection.toJSON()).toEqual(selectionBefore);
      expect(view.state.doc.toJSON()).toEqual(docBefore);
      expect(undoDepth(view.state)).toBe(depthBefore);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("converts an atom NodeSelection into inline source editing", async () => {
    const { view, host } = createView("<mark>高亮</mark>");

    try {
      const source = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-source"
      )!;
      view.dispatch(
        view.state.tr.setSelection(NodeSelection.create(view.state.doc, 1))
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      );

      expect(source.hidden).toBe(false);
      expect(view.state.selection).toBeInstanceOf(TextSelection);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("commits edited raw HTML as one node update", () => {
    const { view, host } = createView("<mark>高亮</mark>");

    try {
      const preview = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-preview"
      )!;
      const source = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-source"
      )!;

      preview.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      source.textContent = "<mark class=\"x\">已修改</mark>";
      source.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.firstChild?.firstChild?.attrs.value).toBe(
        "<mark class=\"x\">已修改</mark>"
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("keeps partial tag text visible and editable", () => {
    const { view, host } = createView("<mark>高亮</mark>");

    try {
      const preview = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-preview"
      )!;
      const source = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-source"
      )!;

      preview.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      source.textContent = "<mark";
      source.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.firstChild?.firstChild?.attrs.value).toBe("<mark");
      expect(preview.textContent).toBe("<mark");
      expect(preview.hidden).toBe(false);

      preview.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(source.hidden).toBe(false);
      expect(source.textContent).toBe("<mark");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it.each([
    "<br>",
    '<a href="https://example.com">链接</a>',
    '<img src="https://example.com/a.png">',
    '<iframe src="https://example.com/embed"></iframe>',
  ])("does not capture click editing for %s", (value) => {
    const { view, host } = createView(value);

    try {
      view.dom
        .querySelector<HTMLElement>(".mt-inline-html-preview")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(
        view.dom.querySelector<HTMLElement>(".mt-inline-html-source")!.hidden
      ).toBe(true);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("opens an inline iframe source through its floating edit button", () => {
    const value =
      '<iframe src="https://example.com/embed" width="480" height="270"></iframe>';
    const { view, host } = createView(value);

    try {
      const button = view.dom.querySelector<HTMLButtonElement>(
        ".mt-inline-html-edit"
      )!;
      const source = view.dom.querySelector<HTMLElement>(
        ".mt-inline-html-source"
      )!;
      expect(button.hidden).toBe(false);

      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      expect(source.hidden).toBe(false);
      expect(source.textContent).toBe(value);
      expect(button.hidden).toBe(true);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
