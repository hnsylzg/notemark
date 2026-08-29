/*
 * html-merge.ts — 修复行内 HTML 标签被拆散的问题
 *
 * remark(micromark) 解析行内 HTML 时按“单个标签”处理，`<u>underline</u>`
 * 会被拆成三个节点：html("<u>") + text("underline") + html("</u>")。
 * 于是渲染层得到空的 <u></u>，文本在标签外，下划线不可见；
 * 同理 `<mark>` 等自定义行内标签也会被拆散。
 *
 * 这里在解析阶段把“开始标签 + 中间节点 + 结束标签”合并回一个完整的
 * html 节点（value 为原始 HTML 片段），交给 html 节点渲染层输出真实标签。
 * 序列化输出原始 value，导入导出往返无损。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { MarkdownNode, RemarkPluginRaw } from "@milkdown/transformer";
import { $remark } from "@milkdown/kit/utils";

/** 匹配开始标签：<tag ...>（排除 </...> 结束标签与 <br/> 自闭标签） */
const OPEN_TAG_RE = /^<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>$/;

function getOpenTag(value: string): string | null {
  if (value.startsWith("</") || value.endsWith("/>")) return null;
  const match = OPEN_TAG_RE.exec(value);
  return match ? match[1] : null;
}

/** 把一段 inline 节点中拆散的标签合并回完整 html 节点 */
function mergeInlineHtml(children: MarkdownNode[]): MarkdownNode[] {
  const merged: MarkdownNode[] = [];
  for (let i = 0; i < children.length; i += 1) {
    const node = children[i];
    if (node.type !== "html") {
      merged.push(node);
      continue;
    }
    const tag = getOpenTag(String(node.value ?? ""));
    if (!tag) {
      merged.push(node);
      continue;
    }
    const closeTag = `</${tag}>`;
    let closeIdx = -1;
    for (let j = i + 1; j < children.length; j += 1) {
      const cand = children[j];
      if (cand.type === "html" && cand.value === closeTag) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx === -1) {
      merged.push(node);
      continue;
    }
    const inner = children
      .slice(i + 1, closeIdx)
      .map((child) => String(child.value ?? ""))
      .join("");
    merged.push({ type: "html", value: `${node.value}${inner}${closeTag}` });
    i = closeIdx;
  }
  return merged;
}

const htmlMergeTransform: RemarkPluginRaw<never[]> = () => (tree) => {
  const visit = (node: MarkdownNode): void => {
    if (!Array.isArray(node.children)) return;
    for (const child of node.children) visit(child);
    if (node.type === "paragraph") {
      node.children = mergeInlineHtml(node.children);
    }
  };
  visit(tree as unknown as MarkdownNode);
};

export const htmlMergeRemark = $remark("milktypo-html-merge", () => htmlMergeTransform);

export const htmlMergePlugins: MilkdownPlugin[] = [...htmlMergeRemark];
