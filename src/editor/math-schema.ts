import { $inputRule, $nodeSchema, $remark } from "@milkdown/utils";
import { Fragment } from "@milkdown/prose/model";
import { expectDomTypeError } from "@milkdown/exception";
import { nodeRule } from "@milkdown/prose";
import remarkMath from "remark-math";

/** remark-math 负责 Markdown 数学语法，具体渲染由 MathJax NodeView 接管。 */
export const remarkMathPlugin = $remark<"remarkMath", undefined>(
  "remarkMath",
  () => remarkMath
);

const MATH_INLINE_ID = "math_inline";

export const mathInlineSchema = $nodeSchema(MATH_INLINE_ID, () => ({
  group: "inline",
  content: "text*",
  inline: true,
  atom: true,
  parseDOM: [
    {
      tag: `span[data-type="${MATH_INLINE_ID}"]`,
      getContent: (dom, schema) => {
        if (!(dom instanceof HTMLElement)) throw expectDomTypeError(dom);
        return Fragment.from(schema.text(dom.dataset.value ?? ""));
      },
    },
  ],
  // schema 只提供可序列化的数据容器，公式渲染由 mathInlineView 异步完成。
  toDOM: (node) => [
    "span",
    {
      "data-type": MATH_INLINE_ID,
      "data-value": node.textContent,
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === "inlineMath",
    runner: (state, node, type) => {
      state
        .openNode(type)
        .addText(node.value as string)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === MATH_INLINE_ID,
    runner: (state, node) => {
      state.addNode("inlineMath", undefined, node.textContent);
    },
  },
}));

export const mathInlineInputRule = $inputRule((ctx) =>
  nodeRule(/(?:\$)([^$]+)(?:\$)$/, mathInlineSchema.type(ctx), {
    beforeDispatch: ({ tr, match, start }) => {
      tr.insertText(match[1] ?? "", start + 1);
    },
  })
);
