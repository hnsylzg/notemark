/*
 * alert.ts — GitHub 风格 Alert 引用块（> [!NOTE] 等）支持
 *
 * 语法：引用块首行写 [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
 * （大小写不敏感，GitHub Alert 同款），渲染为带类型颜色/标题的提示盒子。
 *
 * 实现：
 * - $remark：markdown 解析阶段把「首段为 [!TYPE] 的 blockquote」改写为自定义
 *   mdast 节点 alert（携带 alertType），标题行不进入文档内容；
 * - $nodeSchema：alert 节点渲染为 <blockquote data-alert="note" class="md-alert md-alert-note">
 *   （内容仍是普通块，可正常编辑，无需 NodeView）；
 * - $inputRule：输入 `> [!TYPE]` 时即时把所在引用块转换为 alert 节点；
 * - 序列化：alert 输出回 `> [!TYPE]\n> 内容`，导入导出往返无损。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { MarkdownNode, RemarkPluginRaw } from "@milkdown/transformer";
import { $inputRule, $nodeSchema, $remark } from "@milkdown/kit/utils";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { Fragment } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";

export const ALERT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

const ALERT_TITLE_REGEX = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

/**
 * 若 blockquote 首段以独占一行的 [!TYPE] 开头，改写为 alert 节点；否则返回 null。
 *
 * 注意：`> [!NOTE]` 与 `> 内容` 会被 remark 解析进同一段落，软换行是 break 节点：
 *   paragraph: [text "[!NOTE]", break, text "内容"]
 */
function blockquoteToAlert(node: MarkdownNode): MarkdownNode | null {
  const first = node.children?.[0];
  if (first?.type !== "paragraph") return null;

  const kids = first.children ?? [];
  const titleNode = kids[0];
  if (titleNode?.type !== "text") return null;
  const match = ALERT_TITLE_REGEX.exec(String(titleNode.value));
  if (!match) return null;

  // 标题行必须独占一行：其后只能跟换行（break）或段落结束
  const after = kids.slice(1);
  if (after.length > 0 && after[0].type !== "break") return null;

  // 标题行之后的剩余 inline 内容重建为一个段落；
  // 跳过空段落（序列化多段落引用时会产生空的 `>` 行）
  const rest = after.slice(1);
  const newChildren: MarkdownNode[] = [];
  if (rest.length > 0) {
    newChildren.push({ type: "paragraph", children: rest });
  }
  for (const child of node.children?.slice(1) ?? []) {
    if (child.type === "paragraph" && !(child.children ?? []).length) continue;
    newChildren.push(child);
  }

  return {
    type: "alert",
    alertType: match[1].toLowerCase(),
    children: newChildren,
  };
}

const alertRemarkTransform: RemarkPluginRaw<never[]> = () => (tree) => {
  const visit = (node: MarkdownNode): void => {
    if (!Array.isArray(node.children)) return;
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i];
      if (child.type === "blockquote") {
        const alert = blockquoteToAlert(child);
        if (alert) {
          node.children[i] = alert;
          continue;
        }
      }
      visit(child);
    }
  };
  visit(tree as unknown as MarkdownNode);
};

export const alertRemark = $remark("notemark-alert", () => alertRemarkTransform);

export const alertSchema = $nodeSchema("alert", () => ({
  group: "block",
  content: "block+",
  defining: true,
  attrs: {
    alertType: { default: "note" },
  },
  parseDOM: [
    {
      tag: "blockquote[data-alert]",
      getAttrs: (dom) => ({
        alertType: (dom as HTMLElement).getAttribute("data-alert") ?? "note",
      }),
    },
  ],
  toDOM: (node) => [
    "blockquote",
    { class: `md-alert md-alert-${node.attrs.alertType}`, "data-alert": node.attrs.alertType },
    0,
  ],
  parseMarkdown: {
    match: (node) => node.type === "alert",
    runner: (state, node, type) => {
      const alertType =
        typeof node.alertType === "string" ? node.alertType.toLowerCase() : "note";
      state.openNode(type, { alertType }).next(node.children).closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "alert",
    runner: (state, node) => {
      const title = `[!${String(node.attrs.alertType).toUpperCase()}]`;
      state.openNode("blockquote");
      state.addNode("paragraph", [{ type: "text", value: title }]);
      state.next(node.content);
      state.closeNode();
    },
  },
}));

/** 输入规则：在引用块第一段输入 [!TYPE] 后即时转换为 alert 节点 */
export const alertInputRule = $inputRule((ctx) => {
  const alertNodeType = alertSchema.type(ctx);
  return new InputRule(ALERT_TITLE_REGEX, (state, match, start) => {
    const alertType = match[1]?.toLowerCase();
    if (!alertType) return null;

    // 仅在 blockquote 内生效
    const $start = state.doc.resolve(start);
    let depth = $start.depth;
    while (depth > 0 && $start.node(depth).type.name !== "blockquote") depth -= 1;
    if (depth <= 0) return null;

    const bqNode = $start.node(depth);
    if (bqNode.childCount === 0) return null;
    // 标题行必须是引用块的第一段，且是光标所在段落
    const titleParagraph = bqNode.child(0);
    if (titleParagraph.type.name !== "paragraph") return null;
    if ($start.parent !== titleParagraph) return null;

    // 移除标题段（第一个子节点）；空内容补一个空段落，保证 content: block+ 合法
    const firstSize = bqNode.content.child(0).nodeSize;
    let content = bqNode.content.cut(firstSize, bqNode.content.size);
    if (content.childCount === 0) {
      content = Fragment.from(state.schema.nodes.paragraph.create());
    }

    const alertNode = alertNodeType.create({ alertType }, content);
    const tr = state.tr.replaceWith($start.before(depth), $start.after(depth), alertNode);
    tr.setSelection(TextSelection.near(tr.doc.resolve($start.before(depth) + 1), 1));
    return tr;
  });
});

/** 注册给 getEditorPlugins() 的插件集合 */
export const alertPlugins: MilkdownPlugin[] = [
  ...alertSchema,
  ...alertRemark,
  alertInputRule,
];
