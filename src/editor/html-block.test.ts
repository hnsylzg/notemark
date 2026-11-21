import { Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { GapCursor } from "@milkdown/prose/gapcursor";
import { describe, expect, it, vi } from "vitest";
import {
  HTML_SOURCE_CONTEXTMENU_EVENT,
  createHtmlBlockGapGuardPlugin,
  createHtmlBlockNodeView,
  isBlockHtmlStart,
} from "./html-block";

describe("block HTML detection", () => {
  it.each([
    '<img src="https://example.com/a.png" alt="小图">',
    '<iframe src="https://example.com/embed"></iframe>',
    "<canvas>画布</canvas>",
  ])("keeps inline-capable HTML inline: %s", (value) => {
    expect(isBlockHtmlStart(value)).toBe(false);
  });

  it("still recognizes block-level containers", () => {
    expect(isBlockHtmlStart("<div>内容</div>")).toBe(true);
    expect(isBlockHtmlStart("<table><tr><td>内容</td></tr></table>")).toBe(true);
    expect(isBlockHtmlStart("<blockquote>引用</blockquote>")).toBe(true);
  });
});

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    htmlBlock: {
      group: "block",
      atom: true,
      selectable: false,
      attrs: { value: { default: "" } },
      toDOM: () => ["div", { "data-type": "htmlblock" }],
    },
    text: { group: "inline" },
  },
});

describe("HTML block GapCursor guard", () => {
  it("rejects a GapCursor before a block-level HTML node", () => {
    const html = schema.nodes.htmlBlock.create({ value: "<div>x</div>" });
    const paragraph = schema.node("paragraph");
    const doc = schema.node("doc", null, [html, paragraph]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
      plugins: [createHtmlBlockGapGuardPlugin()],
    });

    const next = state.applyTransaction(
      state.tr.setSelection(new GapCursor(doc.resolve(0)))
    ).state;
    expect(next.selection).not.toBeInstanceOf(GapCursor);
  });
});

describe("HTML block editing affordance", () => {
  it("opens source editing from the dedicated button", () => {
    const html = schema.nodes.htmlBlock.create({
      value: '<iframe src="https://example.com"></iframe>',
    });
    const doc = schema.node("doc", null, [html]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: { htmlBlock: createHtmlBlockNodeView },
    });

    try {
      const button = view.dom.querySelector<HTMLButtonElement>(
        ".mt-html-block-edit"
      );
      const textarea = view.dom.querySelector<HTMLTextAreaElement>(
        ".mt-html-block-body"
      );
      const toolbar = view.dom.querySelector<HTMLElement>(
        ".mt-html-block-toolbar"
      );
      expect(button).not.toBeNull();
      expect(button!.textContent).toBe("HTML </>");
      expect(button!.getAttribute("aria-label")).toBe("编辑 HTML 源码");
      expect(textarea!.style.display).toBe("none");

      view.dom.querySelector(".mt-html-block-preview")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      expect(textarea!.style.display).toBe("none");

      button!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );

      expect(textarea!.style.display).toBe("");
      expect(textarea!.value).toContain("<iframe");
      expect(toolbar!.hidden).toBe(true);

      const sourceContextMenu = vi.fn((event: Event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      textarea!.addEventListener(
        HTML_SOURCE_CONTEXTMENU_EVENT,
        sourceContextMenu,
        { once: true }
      );
      const contextMenuEvent = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      });
      textarea!.dispatchEvent(contextMenuEvent);

      expect(contextMenuEvent.defaultPrevented).toBe(true);
      expect(sourceContextMenu).toHaveBeenCalledTimes(1);
      const sourceEvent = sourceContextMenu.mock
        .calls[0][0] as CustomEvent<{
        clientX: number;
        clientY: number;
      }>;
      expect(sourceEvent.detail).toEqual({ clientX: 20, clientY: 20 });
      expect(document.querySelector(".mt-context-menu")).toBeNull();

      textarea!.value = "<div>更新后的 HTML</div>";
      textarea!.dispatchEvent(new FocusEvent("blur"));

      expect(toolbar!.hidden).toBe(false);
      expect(button!.isConnected).toBe(true);
      expect(view.dom.textContent).toContain("更新后的 HTML");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
