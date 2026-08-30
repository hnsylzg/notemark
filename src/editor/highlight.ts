/*
 * highlight.ts — Obsidian 风格 ==高亮== 支持
 *
 * 语法：==text==（内容不含 = 与换行），渲染为 <mark class="md-highlight">。
 *
 * 实现：
 * - $remark：markdown 解析阶段把 text 节点中的 ==...== 拆分为自定义
 *   mdast 节点 highlight（行内，children 为 text），避免与默认 text
 *   schema 抢占（text schema 的 match 匹配所有 text 节点且排在 marks 前）；
 * - $mark：highlight mark 渲染为 <mark>；parseMarkdown 匹配 highlight 节点，
 *   toMarkdown 输出回 `==text==`（配合 index.ts 注册的 remark-stringify
 *   highlight handler）；
 * - $inputRule：输入 `==text==` 时即时应用高亮 mark。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { MarkdownNode, RemarkPluginRaw } from "@milkdown/transformer";
import { $inputRule, $mark, $remark } from "@milkdown/kit/utils";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { TextSelection } from "@milkdown/kit/prose/state";

/** 拆分文本中的 ==高亮== 片段（内容不含 = 与换行） */
function splitHighlight(value: string): MarkdownNode[] {
  const regex = /==([^=\n]+)==/g;
  const nodes: MarkdownNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value))) {
    if (match.index > last) {
      nodes.push({ type: "text", value: value.slice(last, match.index) });
    }
    nodes.push({ type: "highlight", children: [{ type: "text", value: match[1] }] });
    last = match.index + match[0].length;
  }
  if (last < value.length) {
    nodes.push({ type: "text", value: value.slice(last) });
  }
  return nodes;
}

const highlightRemarkTransform: RemarkPluginRaw<never[]> = () => (tree) => {
  const visit = (node: MarkdownNode): void => {
    if (!Array.isArray(node.children)) return;
    const newChildren: MarkdownNode[] = [];
    for (const child of node.children) {
      if (
        child.type === "text" &&
        typeof child.value === "string" &&
        child.value.includes("==")
      ) {
        newChildren.push(...splitHighlight(child.value));
      } else {
        newChildren.push(child);
      }
      if (Array.isArray(child.children)) visit(child);
    }
    node.children = newChildren;
  };
  visit(tree as unknown as MarkdownNode);
};

export const highlightRemark = $remark(
  "notemark-highlight",
  () => highlightRemarkTransform
);

export const highlightSchema = $mark("highlight", () => ({
  inclusive: true,
  parseDOM: [{ tag: "mark" }],
  toDOM: () => ["mark", { class: "md-highlight" }],
  parseMarkdown: {
    match: (node) => node.type === "highlight",
    runner: (state, node, markType) => {
      state.openMark(markType, {}).next(node.children).closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "highlight",
    runner: (state, mark) => {
      state.withMark(mark, "highlight");
    },
  },
}));

/** 输入规则：输入 ==text== 后即时应用高亮 mark */
export const highlightInputRule = $inputRule((ctx) => {
  const highlightMarkType = highlightSchema.type(ctx);
  return new InputRule(/==([^=\n]+)==$/, (state, match, start, end) => {
    const content = match[1];
    if (!content) return null;
    const tr = state.tr;
    const textStart = start + match[0].indexOf(content);
    const textEnd = textStart + content.length;
    // 两端的 == 都要删掉。原先只删了结尾那对，开头那对被当成正文留下，
    // 于是输入 ==abc== 会得到「字面 == + 高亮的 abc」。
    // 顺序上先删尾部、再删头部：删除尾部不影响头部坐标，
    // 删完头部后 content 正好落在 [start, start+content.length)。
    if (textEnd < end) tr.delete(textEnd, end);
    if (start < textStart) tr.delete(start, textStart);
    tr.replaceWith(
      start,
      start + content.length,
      state.schema.text(content, [highlightMarkType.create()])
    );
    tr.setSelection(TextSelection.near(tr.doc.resolve(start + content.length)));
    tr.scrollIntoView();
    return tr;
  });
});

/** 注册给 getEditorPlugins() 的插件集合 */
export const highlightPlugins: MilkdownPlugin[] = [
  highlightSchema,
  ...highlightRemark,
  highlightInputRule,
];
