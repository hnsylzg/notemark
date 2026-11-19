/*
 * Simple paired inline HTML is represented as a mark, following the same
 * architecture as underline (<u>). The mark keeps the original opening and
 * closing source in attrs so tag names and attributes round-trip unchanged.
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import { $mark } from "@milkdown/kit/utils";
import { sanitizeHtml } from "./html-view";

export const INLINE_HTML_MARK_NAME = "inlineHtmlMarkup";

export const EDITABLE_INLINE_HTML_MARK_TAGS = new Set([
  "abbr",
  "b",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
]);

function safeInlineHtmlDom(
  open: string,
  close: string
): ["span", Record<string, string>, 0] | [string, Record<string, string>, 0] {
  const template = document.createElement("template");
  template.innerHTML = sanitizeHtml(`${open}content${close}`);
  const element = template.content.firstElementChild;
  if (!element) {
    return ["span", { "data-inline-html-mark": "true" }, 0];
  }
  const attrs: Record<string, string> = {
    "data-inline-html-mark": "true",
  };
  for (const attr of Array.from(element.attributes)) {
    attrs[attr.name] = attr.value;
  }
  return [element.tagName.toLowerCase(), attrs, 0];
}

export const inlineHtmlMarkSchema = $mark(INLINE_HTML_MARK_NAME, () => ({
  inclusive: true,
  attrs: {
    open: { default: "" },
    close: { default: "" },
  },
  parseDOM: [{ tag: "[data-inline-html-mark]" }],
  toDOM: (mark) =>
    safeInlineHtmlDom(
      String(mark.attrs.open ?? ""),
      String(mark.attrs.close ?? "")
    ),
  parseMarkdown: {
    match: (node) => node.type === INLINE_HTML_MARK_NAME,
    runner: (state, node, markType) => {
      const data = (node.data ?? {}) as {
        open?: string;
        close?: string;
      };
      state
        .openMark(markType, {
          open: String(data.open ?? ""),
          close: String(data.close ?? ""),
        })
        .next(node.children)
        .closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === INLINE_HTML_MARK_NAME,
    runner: (state, mark) => {
      state.withMark(mark, INLINE_HTML_MARK_NAME, undefined, {
        open: String(mark.attrs.open ?? ""),
        close: String(mark.attrs.close ?? ""),
      });
    },
  },
}));

export const inlineHtmlMarkPlugins: MilkdownPlugin[] = [
  inlineHtmlMarkSchema,
];
