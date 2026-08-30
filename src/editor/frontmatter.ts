/*
 * frontmatter.ts — YAML Front Matter 支持（只读块）
 *
 * 背景：Milkdown 默认完全不支持 front matter：
 *   - remark 层未注册 remark-frontmatter，文档开头的 `---\n...\n---` 被当作普通段落；
 *   - 即便注册，mdast 会产出 `yaml` 节点，而 milkdown 的 ParserState 对未知
 *     mdast 节点直接抛 parserMatchError（无兜底），导致整个文档解析崩溃。
 *
 * 本文件分三步补齐：
 *   - $remark：注册 remark-frontmatter。
 *     ★ 必须显式传 options `{ type: 'yaml', marker: '-' }`：
 *       remark-frontmatter@5 内部是 `options || 'yaml'`，而 milkdown 的 $remark
 *       默认 options 为 `{}`（truthy），会被原样传给 micromark-extension-frontmatter，
 *       抛出 `Missing type in matter {}`。
 *   - $nodeSchema('yaml')：注册 yaml 原子块节点（须声明 group: 'block'，否则
 *     prosemirror schema 校验失败），内容存于 attrs.value，提供
 *     parseMarkdown / toMarkdown 双向转换。
 *   - $view：NodeView 只读渲染，避免 ProseMirror 光标进入该原子节点。
 */
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import type { RemarkPluginRaw } from "@milkdown/transformer";
import remarkFrontmatter from "remark-frontmatter";

/** remark-frontmatter 配置：yaml 块、`---` 分隔 */
const FRONTMATTER_OPTIONS = { type: "yaml", marker: "-" };

export const frontmatterRemark = $remark(
  "notemark-frontmatter",
  () => remarkFrontmatter as RemarkPluginRaw<typeof FRONTMATTER_OPTIONS>,
  FRONTMATTER_OPTIONS
);

export const frontmatterSchema = $nodeSchema("yaml", () => ({
  group: "block",
  atom: true,
  selectable: false,
  attrs: {
    value: { default: "" },
  },
  parseDOM: [
    {
      tag: "div.mt-frontmatter",
      getAttrs: (dom) => ({ value: dom.textContent ?? "" }),
    },
  ],
  toDOM: (node) => [
    "div",
    { class: "mt-frontmatter", "data-type": "yaml" },
    ["pre", { class: "mt-frontmatter-body" }, node.attrs.value as string],
  ],
  parseMarkdown: {
    match: (node) => node.type === "yaml",
    runner: (state, node, type) => {
      state.openNode(type, { value: node.value as string }).closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "yaml",
    runner: (state, node) => {
      state.addNode("yaml", undefined, node.attrs.value as string);
    },
  },
}));

export const frontmatterView = $view(frontmatterSchema.node, () => {
  const nodeView: NodeViewConstructor = (node) => {
    const dom = document.createElement("div");
    dom.className = "mt-frontmatter";
    dom.dataset.type = "yaml";

    const body = document.createElement("pre");
    body.className = "mt-frontmatter-body";
    body.textContent = node.attrs.value as string;

    dom.append(body);

    // 只读块：拦截鼠标事件，防止点击在 PM 中产生选区/光标
    dom.addEventListener("mousedown", (e) => e.stopPropagation());
    dom.addEventListener("click", (e) => e.preventDefault());

    return {
      dom,
      update: (updatedNode) => {
        if (updatedNode.type !== node.type) return false;
        if (updatedNode.attrs.value !== node.attrs.value) {
          node = updatedNode;
          body.textContent = node.attrs.value as string;
        }
        return true;
      },
      // 只读节点的 DOM 变化不应触发 ProseMirror 重绘
      ignoreMutation: () => true,
      destroy: () => {},
    };
  };
  return nodeView;
});

export const frontmatterPlugins = [
  ...frontmatterRemark,
  ...frontmatterSchema,
  frontmatterView,
];
