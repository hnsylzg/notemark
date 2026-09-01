/*
 * strong-parens.ts — 修复「加粗内容含括号」的解析失败
 *
 * CommonMark 规范规定 `*` 字符不能紧贴 `(` / `)`（兼容 Markdown.pl 的
 * 历史行为），micromark 严格遵循。于是 `**映射（Mapping）**类型` 这类
 * 写法中，闭合的 `**` 因紧贴 `）` 不再被当作强调分隔符，导致：
 *   - `**映射（Mapping）**` 解析成普通文本，`**` 泄漏进 text 节点；
 *   - 泄漏的 `**` 与后续强调符号错配，加粗范围张冠李戴。
 * 典型案例（用户教案）：
 *   `**概念**：**映射（Mapping）**类型，通过**键值对（key-value pair）**来组织数据。`
 *   被解析成 strong("概念") + text("：**映射（Mapping）") + strong("类型，通过") + ...
 * 可视化模式下加粗范围错乱，保存时序列化出多余的 `**`。
 *
 * 本插件在 mdast 生成后做启发式修复：
 *   - 仅当行内容器中出现「字面 `**` 泄漏」（text 节点含 `**`）
 *     且容器文本含括号（半角/全角）时才介入，其余情况原样不动；
 *   - 把 children 展开为 token 流（strong 拆成 `**`+内容+`**`，
 *     文本按 `**` 切分），`**` 总数成对（偶数）时重新配对为 strong。
 *   `**` 总数为奇数的场景（如 `**b（c）** 和 **d**`，泄漏符号无法配齐）
 *   保持不动，避免误伤。
 *
 * 修复只调整节点结构、不改变纯文本内容，因此光标映射（只走 .parse()，
 * 不运行本 transformer 插件）的文本聚合与 ProseMirror 文档保持一致。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { MarkdownNode, RemarkPluginRaw } from "@milkdown/transformer";
import { $remark } from "@milkdown/kit/utils";

/** 块级节点：其 children 是块内容，不参与行内 `**` 配对修复 */
const BLOCK_TYPES = new Set([
  "list",
  "blockquote",
  "code",
  "table",
  "yaml",
  "math",
  "thematicBreak",
  "definition",
  "footnoteDefinition",
]);

/** 聚合子树纯文本（与 mdSubtreeText 语义一致） */
function subtreeText(node: MarkdownNode): string {
  if (node.type === "text") return String(node.value ?? "");
  if (node.value != null) return String(node.value);
  return (node.children ?? []).map(subtreeText).join("");
}

/** 修复一个行内容器的 children；返回是否发生了修改 */
function repairInlineChildren(children: MarkdownNode[]): boolean {
  // 触发条件 1：text 节点中出现字面 `**`（micromark 没识别成强调）
  let loose = false;
  for (const c of children) {
    if (c.type === "text" && String(c.value ?? "").includes("**")) {
      loose = true;
      break;
    }
  }
  if (!loose) return false;
  // 触发条件 2：容器文本含括号（半角 / 全角）
  let hasParen = false;
  for (const c of children) {
    if (/[()（）]/.test(subtreeText(c))) {
      hasParen = true;
      break;
    }
  }
  if (!hasParen) return false;

  // 展开为 token 流：`**` 单独成 token，strong 拆开重配，其余节点整体保留
  type Token =
    | { star: true }
    | { text: string }
    | { nodes: MarkdownNode[] };
  const tokens: Token[] = [];
  for (const c of children) {
    if (c.type === "text") {
      const parts = String(c.value ?? "").split("**");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) tokens.push({ star: true });
        if (parts[i] !== "") tokens.push({ text: parts[i] });
      }
    } else if (c.type === "strong") {
      tokens.push({ star: true });
      if (c.children?.length) tokens.push({ nodes: c.children });
      tokens.push({ star: true });
    } else {
      tokens.push({ nodes: [c] });
    }
  }
  const starCount = tokens.filter((t) => "star" in t).length;
  if (starCount === 0 || starCount % 2 !== 0) return false;

  // 重新配对：遇 `**` 开组，遇下一个 `**` 收组为 strong
  const out: MarkdownNode[] = [];
  let pending: MarkdownNode[] | null = null;
  for (const t of tokens) {
    if ("star" in t) {
      if (pending === null) {
        pending = [];
      } else {
        out.push({ type: "strong", children: pending });
        pending = null;
      }
    } else if (pending !== null) {
      if ("text" in t) pending.push({ type: "text", value: t.text });
      else pending.push(...t.nodes);
    } else if ("text" in t) {
      out.push({ type: "text", value: t.text });
    } else {
      out.push(...t.nodes);
    }
  }
  // starCount 为偶数时 pending 必已闭合；防御性兜底
  if (pending !== null) out.push(...pending);
  children.splice(0, children.length, ...out);
  return true;
}

function fixTree(node: MarkdownNode): void {
  if (!Array.isArray(node.children)) return;
  // 深优先：先修子树（strong 内的嵌套容器等）
  for (const child of node.children) fixTree(child);
  if (node.children.some((c) => BLOCK_TYPES.has(c.type))) return;
  repairInlineChildren(node.children);
}

/** remark transformer：解析后修复含括号的加粗解析失败 */
const fixStrongParensTransform: RemarkPluginRaw<never[]> = () => (tree) => {
  fixTree(tree as unknown as MarkdownNode);
};

export const strongParensRemark = $remark(
  "notemark-strong-parens",
  () => fixStrongParensTransform
);

export const strongParensPlugins: MilkdownPlugin[] = [...strongParensRemark];
