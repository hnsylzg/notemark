/*
 * index.ts — Milkdown 编辑器入口（配置层，不在此调用 create()）
 *
 * 职责：
 * - 引入 prosemirror 基础样式（@milkdown/kit 自带）
 * - 提供 createEditor() 工厂：配置 root 节点、默认值（dark/light 由外层控制）
 * - 注册 plugins.ts 中的插件集合
 * - 由 App.vue 在 onMounted 中调用并自行 .create()
 */
import { Editor } from "@milkdown/kit/core";
// defaultValueCtx 由 @milkdown/core 内部插件注册（随 @milkdown/kit/core 导出），
// 用于设置编辑器初始内容，不能用字符串 "defaultValue" 直接 set。
import { defaultValueCtx } from "@milkdown/kit/core";
// rootAttrsCtx：注入到 Milkdown 自动创建的 .milkdown 根节点的 HTML 属性，
// 用于承载 data-theme，使 tokens.css 的 [data-theme] 变量切换生效。
import { rootAttrsCtx } from "@milkdown/kit/core";
// codeBlockConfig：代码块组件（@milkdown/components/code-block）的配置 slice。
// 默认 languages 为空数组，导致语言选择器搜不到任何语言、也无法确定，
// 因此必须注入 @codemirror/language-data 提供的常见语言列表。
import { codeBlockConfig } from "@milkdown/kit/component/code-block";
// listItemBlockConfig：列表项 NodeView（list-item-block）的配置 slice。
// renderLabel 决定列表项“图标区”渲染什么：普通无序列表用圆点 SVG、
// 有序列表用数字文本、任务列表用勾选/未勾选 SVG 方块（list-item.ts）。
import { listItemBlockConfig } from "@milkdown/kit/component/list-item-block";
import { renderListItemLabel } from "./list-item";
import { languages } from "@codemirror/language-data";
// CM6 语法高亮：
// 关键①：@milkdown/components/code-block 默认不启用 syntaxHighlighting，
// 代码块一直以纯色（--mt-code-fg）渲染，tokens.css 的 --mt-token-* 变量
// 从未被消费——这就是“导入主题后代码颜色不变”的根因，必须先启用。
// 关键②：不能直接用 defaultHighlightStyle——它不生成 .tok-* 类名，而是
// style-mod 混淆类名（.ͼb 等），CSS 侧无法按类名覆盖。因此这里用
// HighlightStyle.define + CSS 变量（var(--mt-token-*)）自定义，使 CM 生成
// 的高亮规则直接消费主题变量，用户改主题即改代码配色。
// 注意：tags 由 @lezer/highlight 提供，@codemirror/language 不重新导出。
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const mtHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--mt-token-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--mt-token-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--mt-token-number)" },
  // GitHub 官方观感：注释不上斜体
  { tag: [t.comment, t.meta], color: "var(--mt-token-comment)" },
  {
    tag: [t.function(t.variableName), t.definition(t.variableName)],
    color: "var(--mt-token-function)",
  },
  // GitHub 官方观感：运算符不上色（继承 --mt-code-fg）
  { tag: [t.variableName], color: "var(--mt-token-variable)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--mt-token-type)" },
  // GitHub 官方观感：属性名蓝色、HTML 标签绿色，两者分开
  { tag: [t.propertyName], color: "var(--mt-token-property)" },
  { tag: [t.tagName], color: "var(--mt-token-tag)" },
]);

// remark-stringify 的默认转义表（mdast-util-to-markdown 的 unsafe 规则）会把文本
// 中的 [、] 转义成 \[、\]（因它们可能是链接/图片/引用语法前缀），导致 [toc]、
// > [!NOTE]（Obsidian Callout）等被序列化成 \[toc]、\[!NOTE]，外部编辑器无法识别。
// 同理，文本中的 * 也会被转义成 \*：CommonMark 的强调规则要求闭合分隔符前不能是
// 标点（全角括号（ ）属于 Unicode 标点），因此「**映射（Mapping）**类型」这类写法
// 中 ** 无法配对成 strong，整段退化为普通文本节点；序列化时 remark-stringify 为了
// round-trip 再把文本里的 ** 转义成 \*\*，把未编辑的原样内容污染掉。
// 注意：mdast-util-to-markdown 对 options.unsafe 是"追加"而非替换，无法通过选项
// 清掉默认表，因此这里改为在 text handler 内调用 state.safe 前临时过滤 [ ] * 规则。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore mdast-util-to-markdown 导出的 Handle 类型
const customTextHandler: Handle = (node, _, state, info) => {
  const value = (node as { value?: string }).value ?? "";
  if (!value) return value;
  // 短路：文本里没有需要保护的字符时，过滤 unsafe 表与否结果完全相同，
  // 直接走默认 safe。避免对文档里每个文本节点都 filter 一遍整张 unsafe 表
  // （长文档上这是纯浪费，且反复改 state.unsafe 这种共享状态风险很高）。
  if (!/[\[\]*]/.test(value)) {
    return state.safe(value, { ...info, encode: [] });
  }
  const original = state.unsafe;
  state.unsafe = original.filter(
    (u) => !(u.character === "[" || u.character === "]" || u.character === "*")
  );
  try {
    return state.safe(value, { ...info, encode: [] });
  } finally {
    state.unsafe = original;
  }
};

// mdast-util-to-markdown 的默认 list handler 有个「相邻列表换 bullet」机制：
// 同一容器下两个紧邻的 list 节点若使用相同 bullet，第二个会被替换成
// bulletOther（默认 *）——避免 `- -`、`- ---` 这类结构在解析时产生歧义。
// 但可视化编辑器里，用户在既有列表（如含代码块的列表）后新增列表项时，
// 新列表与旧列表恰好构成「相邻 list」，于是用户输入的 `-` 保存后被改写成
// `*`（实测：`- abc` 变成 `* abc`）。
// 这里包装默认 handler：处理完每个 list 后清空 bulletLastUsed，使所有列表
// 始终使用配置的 bullet（跟随文件探测风格），与 Typora 行为一致。
// 注：bulletOther 与 bullet 不允许相同（check-bullet-other 强制校验），
// 因此无法用「设置 bulletOther」的方式解决，只能从 handler 层抑制。
const customListHandler: Handle = (node, parent, state, info) => {
  const result = defaultHandlers.list(node, parent, state, info);
  state.bulletLastUsed = undefined;
  return result;
};

// mdast-util-to-markdown 的 attention（strong/emphasis）序列化器在
// 「内容首/尾字符是标点、外侧紧跟字母」时，会把外侧字符转义成 HTML 实体
// （如 `）**类型` 中 strong 之后的「类」→ `&#x7C7B;`），以保证 round-trip
// 解析一致。但含括号的加粗（`**映射（Mapping）**`）本就无法被 CommonMark
// 解析（见 strong-parens.ts），该转义既救不回 round-trip（解析端仍失败），
// 又会把 `&#x7C7B;` 这类实体写进用户文件。
// 解析端已由 strong-parens 插件修复，因此序列化时清除该标志、原样输出。
const customStrongHandler: Handle = (node, parent, state, info) => {
  const result = defaultHandlers.strong(node, parent, state, info);
  state.attentionEncodeSurroundingInfo = undefined;
  return result;
};

const customEmphasisHandler: Handle = (node, parent, state, info) => {
  const result = defaultHandlers.emphasis(node, parent, state, info);
  state.attentionEncodeSurroundingInfo = undefined;
  return result;
};
// listenerCtx：注册内容变化监听，用于追踪“未保存修改”状态。
// 该 SliceType 由 listener 插件提供，必须在 .use(listener) 注册后生效。
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
// Milkdown v7 的 Markdown 读写通过两个内部上下文实现：
// - serializerCtx: 把 ProseMirror Node 序列化为 Markdown 字符串
// - parserCtx:     把 Markdown 字符串解析为 ProseMirror Node
// - editorViewCtx: 拿 ProseMirror 视图，用于派发文档替换事务
// 注意：editorViewCtx 在 @milkdown/kit/core 的运行时 JS 中确实导出（见 core 源码
// ctx.set(editorViewCtx, view)），但本安装版本的 .d.ts 遗漏了该声明，
// 因此用 @ts-ignore 抑制类型检查，运行时完全可用。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore editorViewCtx 在运行时由 @milkdown/kit/core 导出（d.ts 遗漏声明）
import { serializerCtx, parserCtx, editorViewCtx, remarkCtx } from "@milkdown/kit/core";
// remarkStringifyOptionsCtx：Milkdown 序列化 Markdown 时传给 remark-stringify 的
// 选项 slice，可在 config 阶段改写（init 在 ConfigReady 后才读取它创建 remark 实例）。
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
// 重建序列化器：milkdown 的 serializerCtx 默认是 SerializerState.create(schema, remark)，
// 其中 remark 就是 unified().use(remarkParse).use(remarkStringify, options)。
// 打开老文件时需按文件风格重建（bullet/rule 跟随原文），依赖这三个包在顶层
// node_modules 可直接解析（同为 @milkdown/core 的直接依赖）。
import { unified } from "unified";
import remarkParse from "remark-parse";
// 重建序列化器必须带上与 milkdown 默认 remark 一致的「全部 stringify 扩展」：
// 1. remark-gfm：gfm 预设（删除线/脚注/表格对齐/任务列表）的 stringify 扩展
//    挂在 remark 处理器上。若重建时不加，凡探测出的 bullet/rule 风格与默认值
//    不同（如 + 列表文件）就会触发重建，序列化时遇到 ~~删除线~~ 产生的
//    delete 节点即抛 "Cannot handle unknown node `delete`"。
// 2. remark-frontmatter：yaml 元数据节点的 toMarkdown 输出 mdast yaml 节点，
//    需要它的 stringify 扩展才能写回 --- 块；漏掉则序列化含 frontmatter 的
//    文档抛 "Cannot handle unknown node `yaml`"（曾漏加，见 delete 同源事故）。
// 3. remark-math：行内/块级公式（inlineMath / math）的 stringify 扩展。
// 其余项目内 $remark（alert/toc/highlight/html-merge/strong-parens/diagram）
// 只做「解析期 mdast 变换」，序列化端由各自 schema 的 toMarkdown runner 输出
// 标准节点（blockquote/paragraph/html/code），无需在重建链里追加。
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import remarkStringify, { type Options as RemarkStringifyOptions } from "remark-stringify";
import { FRONTMATTER_OPTIONS } from "./frontmatter";
import { SerializerState } from "@milkdown/kit/transformer";
// defaultHandlers：序列化时包装 mdast-util-to-markdown 的默认 list handler，
// 抑制「相邻列表自动换 bullet」的行为（详见 customListHandler 注释）。
import { defaultHandlers } from "mdast-util-to-markdown";
// 仅用于类型标注（type-only，不参与打包）
import type { Handle } from "mdast-util-to-markdown";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
/** editor.action 回调注入的上下文类型（由 Editor API 推导，不依赖具体导出名） */
type EditorCtx = Parameters<Parameters<Editor["action"]>[0]>[0];
import { TextSelection } from "@milkdown/kit/prose/state";
import "@milkdown/kit/prose/view/style/prosemirror.css";

import { getEditorPlugins } from "./plugins";

/** 当前编辑器文档导出为 Markdown 文本 */
export function getMarkdown(editor: Editor): string {
  return editor.action((ctx) => {
    const serializer = ctx.get(serializerCtx);
    const view = ctx.get(editorViewCtx);
    // milkdown 用 <br /> 占位序列化空段落，表格空单元格会被误填；GFM 空单元格
    // 本就是合法语法，统一清掉占位，避免写进用户文件（导出/保存/脏检查一致）。
    return cleanMarkdownTableBr(serializer(view.state.doc));
  });
}

/**
 * remark-frontmatter（marker: '-'）的已知缺陷防护。
 *
 * micromark-extension-frontmatter@2 的 tokenizer 只要文档开头第 1 行第 1 列是
 * `---` 就进入 frontmatter，把后续所有行当作 value 贪婪消费；直到 EOF 都找不到
 * 闭合 `---` 才 nok 回滚，但换行已被消费，回滚不彻底——于是「文档开头的分割线
 * `---` 后面接列表」时，`- a\n- b\n- c` 会被并成一个段落（保存→重开即复现：
 * 列表渲染成一行、复制出 `\- a`）。而 `---` 在文档中部（前面有内容）不受影响，
 * 因为 frontmatter 只在第 1 行触发。
 *
 * 防护：若开头的 `---` 不是闭合完整的 frontmatter 块（后面不存在 `---` 闭合行），
 * 就把开头 3 个字符临时换成 `***` 再交给解析器。`***` 与 `---` 同为合法
 * thematicBreak、长度相同（mdast position offset 不变），且不会触发 frontmatter
 * 开界。这仅影响解析输入；源文件文本不变，保存时仍按 rule: '-' 输出 `---`。
 * 真正的 frontmatter（`---\n...\n---\n`）不命中，行为不变。
 */
function guardUnclosedFrontmatter(md: string): string {
  // 只有「开头一行就是 ---（可带尾随空格）」才是 frontmatter 的触发形态；
  // `----`（4+ 个 -）不是 frontmatter 围栏，也不属于此场景。
  if (!/^---[ \t]*\r?\n/.test(md)) return md;
  const rest = md.slice(md.indexOf("\n") + 1);
  // 第一行之后存在闭合围栏行（行首 ---、可带尾随空格，后接换行或结尾）→ 真 frontmatter
  if (/^---[ \t]*(\r?\n|$)/m.test(rest)) return md;
  return "***" + md.slice(3);
}

// ==================== 最小化修改保存（模仿 Typora） ====================
// milkdown 的 serializerCtx 只有「整棵文档树 → markdown 字符串」一个入口，
// 序列化时按全局配置（bullet/rule 等）重排全文——老文件只要在可视化模式
// 编辑过一次，保存就会把列表符号、分割线写法、空行等排版整体改写。
// 这里模仿 Typora 的「最小化修改」保存，两步配合：
// 1. 打开文件时探测原文的列表/分割线风格并重建序列化器，使序列化输出
//    与原文风格一致（被改的行重写后风格不跑调，diff 时才不会把未改动的
//    行也判定为「修改」而全量重写）；
// 2. 保存时把序列化结果与磁盘原文做行级 diff（mergeMarkdown），未变化的
//    行全部保留原文（符号/空行/缩进/排版一字不动），只有发生变化的行
//    用序列化结果替换。

export type BulletChar = "-" | "*" | "+";
export type RuleChar = "-" | "*" | "_";

export interface MarkdownStyle {
  /** 无序列表符号；未检测到时为 null（回退默认 "-"） */
  bullet: BulletChar | null;
  /** 分割线符号；未检测到时为 null（回退默认 "-"） */
  rule: RuleChar | null;
}

/**
 * frontmatter 块的行区间 [首行, 闭合行]；非 frontmatter 返回 null。
 * 与 remark-frontmatter 的判定一致：文档开头第一行是 `---` 即进入 frontmatter。
 * 未闭合的开头 `---` 也会触发该插件的贪婪消费，同样视为 frontmatter 跳过，
 * 避免它被误计为「分割线风格是 -」。
 */
function frontmatterLineRange(lines: string[]): [number, number] | null {
  if (lines.length < 2 || !/^---[ \t]*$/.test(lines[0])) return null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) return [0, i];
  }
  return [0, 0];
}

/** 从计数表取出现次数最多的符号；全部为 0 返回 null */
function pickMost<K extends string>(counts: Record<K, number>): K | null {
  let best: K | null = null;
  for (const key in counts) {
    if (counts[key] > 0 && (best == null || counts[key] > counts[best])) {
      best = key;
    }
  }
  return best;
}

/**
 * 探测 markdown 文本使用的无序列表符号与分割线符号。
 * 只统计「行首 0-3 空格 + 符号」的列表 marker 与「整行同一符号」的分割线；
 * 引用块（`> `）内的符号不参与统计，避免被块内内容干扰。
 */
export function detectMarkdownStyle(markdown: string): MarkdownStyle {
  const bulletCounts: Record<BulletChar, number> = { "-": 0, "*": 0, "+": 0 };
  const ruleCounts: Record<RuleChar, number> = { "-": 0, "*": 0, "_": 0 };
  const lines = markdown.split(/\r?\n/);
  const fm = frontmatterLineRange(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fm && i >= fm[0] && i <= fm[1]) continue;
    const line = lines[i];
    // 分割线：整行由同一符号（可夹空格/tab）构成，至少 3 个。
    // 注意 `- - -`、`***`、`___` 都符合；`----` 也是合法分割线。
    const ruleMatch = line.match(/^ {0,3}([-_*])(?:[ \t]*\1){2,}[ \t]*$/);
    if (ruleMatch) {
      ruleCounts[ruleMatch[1] as RuleChar]++;
      continue;
    }
    // 列表 marker：符号后必须跟空白（否则是 `*foo` 之类普通文本）。
    // 表格分隔行（`|---|---|`）行首是 `|`，不会命中。
    const bulletMatch = line.match(/^ {0,3}([-*+])(?=[ \t])/);
    if (bulletMatch) bulletCounts[bulletMatch[1] as BulletChar]++;
  }
  return { bullet: pickMost(bulletCounts), rule: pickMost(ruleCounts) };
}

/** 当前已应用的序列化风格（初始与 config 默认一致，避免无谓重建） */
let appliedStyle: { bullet: BulletChar; rule: RuleChar } = { bullet: "-", rule: "-" };

/**
 * 按探测到的风格重建序列化器。
 * milkdown 默认 serializer 就是 `SerializerState.create(schema, remark)`，其中
 * remark = unified().use(remarkParse).use(remarkStringify, remarkStringifyOptionsCtx)。
 * 这里构造等价实例、仅改写 bullet/rule，其余选项（handlers 等）原样保留，
 * 保证序列化输出与原文风格一致。风格未变化时跳过，避免每次 setMarkdown 重建。
 */
function applySerializationStyle(
  ctx: EditorCtx,
  view: EditorView,
  style: MarkdownStyle
): void {
  const bullet = style.bullet ?? "-";
  const rule = style.rule ?? "-";
  if (bullet === appliedStyle.bullet && rule === appliedStyle.rule) return;
  const remark = unified()
    .use(remarkParse)
    // 与编辑器解析链保持一致的 strict 删除线（~ 让给下标，删除线只认 ~~）
    .use(remarkGfm, { singleTilde: false })
    .use(remarkFrontmatter, FRONTMATTER_OPTIONS)
    .use(remarkMath)
    .use(remarkStringify, {
      ...ctx.get(remarkStringifyOptionsCtx),
      bullet,
      rule,
    });
  ctx.set(serializerCtx, SerializerState.create(view.state.schema, remark));
  appliedStyle = { bullet, rule };
}


import { mergeMarkdown, cleanMarkdownTableBr } from "./md-merge";
export { mergeMarkdown, cleanMarkdownTableBr };


/** 用新的 Markdown 文本整体替换编辑器内容 */
export function setMarkdown(editor: Editor, markdown: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const parser = ctx.get(parserCtx);
    // 探测原文风格并重建序列化器：使保存时序列化输出与原文风格一致，
    // 这是 mergeMarkdown 行级合并「未改动行能被原样保留」的前提。
    applySerializationStyle(ctx, view, detectMarkdownStyle(markdown));
    // 统一行尾为 LF：CRLF 源码解析后代码块等内容会保留 \r，而 CodeMirror
    // 内部把 \r\n 规范化为 \n，两侧长度不一致会导致选区转发给 CM 时
    // 越界抛 RangeError（CRLF 文件专有，LF 下不暴露）。
    // 源码模式展示的仍是原始 CRLF 文本（rawContent），映射层负责两侧换算。
    const source = markdown.replace(/\r\n?/g, "\n");
    const doc = parser(guardUnclosedFrontmatter(source));
    // 用新 doc 替换整棵文档树，保持 schema 合法
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content)
    );
  });
}

// ==================== WYSIWYG ⇄ 源码 光标块级锚点映射 ====================
// 原理：Markdown 与解析后的文档存在语法损耗（**加粗**、![](图)、列表符号等），
// 逐字符精确映射不可行。但「叶子块」（段落/标题/代码块/表格单元格等不含子块的
// 块级节点）在两侧按文档顺序一一对应，且块内文本（纯文本）两侧一致。
// 因此以「光标所在叶子块的序号 + 块内文本偏移比例」为锚点双向映射，
// 切到源码后光标落在同一块对应行的文本处（块级精准、块内近似）。

/** mdast 节点（本项目用到的最小结构） */
interface MdNode {
  type: string;
  value?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: MdNode[];
}

/** mdast 叶子块（与 ProseMirror 叶子块对称的结构信息） */
interface MdLeafBlock {
  /** 块内聚合纯文本（去除全部 markdown 语法后的文本） */
  text: string;
  /** 块起始字符 offset（含语法标记，如 **bold** 的 *） */
  start: number;
  /** 块结束字符 offset（不含） */
  end: number;
  /** 块内首个纯文本的字符 offset（用于块内光标定位） */
  textStart: number;
  /** 原始 mdast 节点（行内级映射需要读其子节点 position） */
  node: MdNode;
}

/** ProseMirror 叶子块（含文档位置信息） */
interface DocLeafBlock {
  text: string;
  /** 节点起始 pos */
  pos: number;
  /** 节点整体大小（nodeSize），用于判断光标是否落在块内 */
  size: number;
  node: PMNode;
}

/** mdast 中会渲染成 ProseMirror 叶子块的节点类型（两侧结构对称） */
const MD_LEAF_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "code",
  "math",
  "tableCell",
]);

/** 判断 mdast 节点是否为叶子块：是块级类型且不含块级子节点 */
function isMdLeafBlock(node: MdNode): boolean {
  if (!MD_LEAF_BLOCK_TYPES.has(node.type)) return false;
  return !(node.children ?? []).some((c) => MD_LEAF_BLOCK_TYPES.has(c.type));
}

/**
 * 聚合 mdast 子树内的全部文本。
 * mdast 中带 value 的节点（text/inlineCode/code/html/break 等）内容直接存于
 * value，无 children；若只遍历 children 会导致 code、inlineCode 等文本全部丢失，
 * 使两侧「同文本序」配对失败并错误降级。故先取 value，再聚合 children。
 */
function mdSubtreeText(node: MdNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.value != null) return node.value;
  return (node.children ?? []).map(mdSubtreeText).join("");
}

/** 找到子树内首个文本节点的字符 offset（块内光标定位用） */
function mdFirstTextOffset(node: MdNode): number | null {
  if (node.type === "text") return node.position?.start?.offset ?? null;
  for (const c of node.children ?? []) {
    const o = mdFirstTextOffset(c);
    if (o != null) return o;
  }
  return null;
}

/**
 * 围栏块（code / math）在 ProseMirror 侧没有围栏语法，
 * 光标内容起点是「内容第一行」，而 position.start 指向围栏行。
 * 这里跳过围栏行，返回内容开头的字符 offset。
 * 兼容 3+ 反引号 / 波浪线围栏，以及独立成行的 $$ 数学块围栏。
 *
 * remark 解析围栏块时，会把「围栏行前导空格」作为公共缩进从内容行移除，
 * 因此内容首字符可能不在围栏行换行后的第一个位置（缩进围栏场景）。
 * 这里按 CommonMark 规则取 contentStart + min(围栏缩进, 内容行缩进)。
 */
function mdContentStart(node: MdNode, source: string): number | null {
  if (node.type !== "code" && node.type !== "math") return null;
  const start = node.position?.start?.offset;
  if (start == null) return null;
  const lineEnd = source.indexOf("\n", start);
  const line = lineEnd < 0 ? source.slice(start) : source.slice(start, lineEnd);
  if (/^\s*(`{3,}|~{3,}|\$\$\s*$)/.test(line)) {
    if (lineEnd < 0) return start;
    const contentStart = lineEnd + 1;
    // 围栏行前导空格数（position.start 指向 "```" 本身，需回溯到行首）
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const fenceIndent = start - lineStart;
    // 内容第一行的前导空白（remark 与内容行公共缩进比较后取较小者）
    const nl2 = source.indexOf("\n", contentStart);
    const first =
      nl2 < 0 ? source.slice(contentStart) : source.slice(contentStart, nl2);
    const contentIndent = (first.match(/^\s*/) || [""])[0].length;
    return contentStart + Math.min(fenceIndent, contentIndent);
  }
  return null;
}

/** 按文档顺序收集 mdast 中的全部叶子块 */
function collectMdLeafBlocks(
  node: MdNode,
  out: MdLeafBlock[],
  source: string
): void {
  if (isMdLeafBlock(node)) {
    const pos = node.position;
    if (pos?.start?.offset != null && pos?.end?.offset != null) {
      out.push({
        text: mdSubtreeText(node),
        start: pos.start.offset,
        end: pos.end.offset,
        node,
        textStart:
          mdContentStart(node, source) ??
          mdFirstTextOffset(node) ??
          pos.start.offset,
      });
    }
    return; // 叶子块不再下钻（inline 子节点无需处理）
  }
  for (const c of node.children ?? []) collectMdLeafBlocks(c, out, source);
}

/**
 * 去掉 \r（CRLF 行尾符）后的文本。
 * 源码侧（remark 解析 CRLF 原文件）会保留 \r，而 Milkdown 解析时剥掉 \r，
 * 两侧代码块文本因此不一致导致配对失败。配对与比例计算统一按「可视文本」比较。
 */
const normText = (s: string) => s.replace(/\r/g, "");

/** 统计 raw 文本 [from, to) 区间内的 \r 数量 */
function crCountIn(raw: string, from: number, to: number): number {
  const hi = Math.min(to, raw.length);
  let n = 0;
  for (let i = from; i < hi; i++) {
    if (raw.charCodeAt(i) === 13) n++;
  }
  return n;
}

/** 从 raw 文本 from 位置前进 visible 个「可视字符」（\r 不计），返回目标 offset */
function advanceVisible(raw: string, from: number, visible: number): number {
  let i = from;
  let left = visible;
  while (left > 0 && i < raw.length) {
    if (raw.charCodeAt(i) !== 13) left--;
    i++;
  }
  return i;
}

/**
 * 返回 text 中前 visible 个「可视字符」（\r 不计）占用的原始字符数（含 \r）。
 * 用于把「可视偏移」换算回含 \r 的原始文本坐标（PM 文档侧）。
 */
function visibleSpanRaw(text: string, visible: number): number {
  let left = visible;
  let i = 0;
  while (left > 0 && i < text.length) {
    if (text.charCodeAt(i) !== 13) left--;
    i++;
  }
  return i;
}

/**
 * md 源码区间 ↔ PM 块内偏移 的对应关系（行内级）。
 *
 * mdast 的行内叶子节点（text / inlineCode）自带精确 position，且与 PM 侧的文本
 * 节点逐字符 1:1。据此建表后语法标记（**、`、[]()）自然被跳过，块内偏移无需
 * 再按比例估算——比例估算在「源码含标记、PM 是渲染后文本」时误差会随块长放大。
 */
interface InlineSpan {
  /** md 源码区间起点（原始 offset，含 \r） */
  mdStart: number;
  /** md 源码区间终点（不含） */
  mdEnd: number;
  /** 该片段在 PM 块内的起始偏移（PM 坐标，块内容开头为 0） */
  docOffset: number;
  /** 该片段的可视文本长度 */
  docLen: number;
  /** 该片段在 PM 侧的原始长度（含 \r），用于判断位置是否落在片段末尾 */
  docRawLen: number;
  /** 语法外框起点（含 ** 等标记）；无外框时为 null */
  frameStart: number | null;
  /** 语法外框终点（不含）；无外框时为 null */
  frameEnd: number | null;
}

/** mdast 叶子块中「会渲染成 PM 文本」的节点类型 */
const MD_TEXT_LEAF_TYPES = new Set(["text", "inlineCode"]);

/** 包裹文本的行内标记类型：其 position 含语法标记本身（如 **bold** 的 `**`） */
const MD_MARK_TYPES = new Set([
  "strong",
  "emphasis",
  "link",
  "delete",
  // ^上标^ / ~下标~ 的 ^ ~ 也要算进外框，反向映射时才能把标记还原回去
  "superscript",
  "subscript",
]);

/** mdast 文本叶子 + 其语法外框（含语法标记的范围，供选区边界吸附使用） */
interface MdTextLeaf {
  node: MdNode;
  frameStart: number | null;
  frameEnd: number | null;
}

/**
 * 收集 mdast 子树中会渲染成 PM 文本的叶子节点，同时记录「语法外框」。
 *
 * 外框是包含语法标记的范围：inlineCode 自身的 position 含反引号，
 * strong / emphasis / link 的 position 含 `**`、`*`、`[]()`，而它们子节点
 * （text）的 position 不含标记。反向映射时靠外框把标记还原回去，否则
 * 「选中 **bold** 整段」映射回源码会丢掉 `**`，只剩 `bold`。
 */
function collectMdTextLeaves(
  node: MdNode,
  out: MdTextLeaf[],
  frame: { start: number | null; end: number | null } = { start: null, end: null }
): void {
  if (MD_TEXT_LEAF_TYPES.has(node.type)) {
    const start = node.position?.start?.offset;
    if (start != null) {
      // inlineCode 自身即外框（position 含反引号、value 不含）
      const own =
        node.type === "inlineCode"
          ? { start, end: node.position?.end?.offset ?? null }
          : frame;
      out.push({ node, frameStart: own.start, frameEnd: own.end });
    }
    return;
  }
  // 进入标记节点：嵌套时以最外层标记为准
  const isMark = MD_MARK_TYPES.has(node.type);
  const next =
    isMark && frame.start == null
      ? {
          start: node.position?.start?.offset ?? null,
          end: node.position?.end?.offset ?? null,
        }
      : frame;
  for (const c of node.children ?? []) collectMdTextLeaves(c, out, next);
}

/**
 * 建立「md 叶子块 ↔ PM 叶子块」的行内级映射表。
 *
 * 两侧文本片段严格 1:1 且逐段一致时返回映射表；结构不对等（图片、内联公式、
 * 内联 HTML 等在 PM 侧没有文本对应物）时返回 null，由调用方降级到块级近似，
 * 保证任何情况下都不会映射失败或越界。
 */
function buildInlineMap(md: MdLeafBlock, doc: DocLeafBlock): InlineSpan[] | null {
  // 围栏块（代码 / 数学）整块是纯文本、没有行内节点，按整块直接对应
  if (md.node.type === "code" || md.node.type === "math") {
    const value = md.node.value ?? "";
    if (normText(value) !== normText(doc.text)) return null;
    return [
      {
        mdStart: md.textStart,
        mdEnd: md.end,
        docOffset: 0,
        docLen: normText(value).length,
        // 必须用 PM 侧实际长度：源码侧（remark 解析 CRLF）保留 \r，
        // PM 侧已被规范化掉 \r，用 value.length 会算出越界位置，
        // 代码块派发选区时抛 RangeError（CRLF 文件专有，LF 下两者相等故不暴露）
        docRawLen: doc.text.length,
        frameStart: null,
        frameEnd: null,
      },
    ];
  }
  // PM 侧：按块内偏移顺序收集文本片段（atom 节点无文本，仅推进偏移）
  const docSpans: { offset: number; size: number; text: string }[] = [];
  let offset = 0;
  doc.node.forEach((child) => {
    if (child.isText)
      docSpans.push({ offset, size: child.nodeSize, text: child.text ?? "" });
    offset += child.nodeSize;
  });
  const mdLeaves: MdTextLeaf[] = [];
  collectMdTextLeaves(md.node, mdLeaves);
  if (mdLeaves.length === 0 || mdLeaves.length !== docSpans.length) return null;
  const spans: InlineSpan[] = [];
  for (let i = 0; i < mdLeaves.length; i++) {
    const leaf = mdLeaves[i];
    const start = leaf.node.position?.start?.offset;
    const end = leaf.node.position?.end?.offset;
    if (start == null || end == null) return null;
    // 文本不一致（转义字符解码等）会让块内偏移失真，降级到块级
    if (normText(leaf.node.value ?? "") !== normText(docSpans[i].text)) return null;
    spans.push({
      mdStart: start,
      mdEnd: end,
      docOffset: docSpans[i].offset,
      docLen: normText(docSpans[i].text).length,
      docRawLen: docSpans[i].size,
      frameStart: leaf.frameStart,
      frameEnd: leaf.frameEnd,
    });
  }
  return spans;
}

/** 用行内映射表把 md 字符 offset 换算为 PM 文档位置（字符级） */
function mdOffsetToDocBySpans(
  spans: InlineSpan[],
  doc: DocLeafBlock,
  source: string,
  offset: number
): number {
  // 落在片段间隙时取最近的左侧片段，其后由片段长度收敛
  let span = spans[0];
  for (const s of spans) {
    if (offset >= s.mdStart) span = s;
  }
  const visDelta = Math.max(
    0,
    offset - span.mdStart - crCountIn(source, span.mdStart, offset)
  );
  const rest = doc.text.slice(span.docOffset);
  const adv = visibleSpanRaw(rest, Math.min(visDelta, normText(rest).length));
  return Math.max(
    doc.pos,
    Math.min(doc.pos + doc.size, doc.pos + 1 + span.docOffset + adv)
  );
}

/** 用行内映射表把 PM 文档位置换算为 md 字符 offset（字符级） */
function docPosToMdOffsetBySpans(
  spans: InlineSpan[],
  md: MdLeafBlock,
  doc: DocLeafBlock,
  source: string,
  pos: number,
  /** 是否把落在标记内容边界的位置吸附到含语法的外框 */
  snap: boolean
): number {
  const within = Math.max(0, pos - (doc.pos + 1));
  let span = spans[0];
  for (const s of spans) {
    if (within >= s.docOffset) span = s;
  }
  // 边界吸附：位置正好落在片段内容的首/尾时，把结果扩到语法外框。
  // 否则「选中 **bold** word」反向还原后会丢掉 **，只剩 bold** word。
  // 仅选区启用：光标停靠时吸附会改变输入语义（见 mapCaretToMdOffset 的 snap）
  if (snap && span.frameStart != null && within === span.docOffset) {
    return Math.min(md.end, Math.max(md.start, span.frameStart));
  }
  if (snap && span.frameEnd != null && within === span.docOffset + span.docRawLen) {
    return Math.min(md.end, Math.max(md.start, span.frameEnd));
  }
  const rest = doc.text.slice(span.docOffset);
  const rawDelta = Math.max(0, Math.min(within - span.docOffset, rest.length));
  const visDelta = Math.max(0, rawDelta - crCountIn(rest, 0, rawDelta));
  return Math.min(
    md.end,
    Math.max(md.start, advanceVisible(source, span.mdStart, visDelta))
  );
}

/** 在 blocks 中找出第 ordinal 个 text 相同的块（按去 \r 后的可视文本比较） */
function findBlockByOrdinal<T extends { text: string }>(
  blocks: T[],
  text: string,
  ordinal: number
): T | null {
  const key = normText(text);
  let n = 0;
  for (const b of blocks) {
    if (normText(b.text) === key && ++n === ordinal) return b;
  }
  return null;
}

/** 按文档顺序收集 ProseMirror 中的全部叶子块 */
function collectDocLeafBlocks(doc: PMNode): DocLeafBlock[] {
  const out: DocLeafBlock[] = [];
  doc.descendants((node, pos) => {
    let hasBlockChild = false;
    node.content.forEach((c) => {
      if (c.isBlock) hasBlockChild = true;
    });
    if (node.isBlock && !hasBlockChild) {
      out.push({ text: node.textContent, pos, size: node.nodeSize, node });
    }
    return true;
  });
  return out;
}

/**
 * 把 WYSIWYG 光标位置映射为 markdown 源码中的字符 offset（块级锚点）。
 * 配对优先按「同文本序」消歧重复内容，失败时降级按整体块序号对齐，
 * 保证绝大多数场景都能锚定到同一块所在行（而非返回 null 导致光标不动）。
 * 仅在空文档 / 空源码时返回 null。
 * @param markdown 将展示在源码 textarea 中的文本（与光标定位目标一致）
 */
/**
 * 把 WYSIWYG 中的单个文档位置 pos 映射为 markdown 源码字符 offset（块级锚点）。
 * 逻辑与 wysiwygCaretToMarkdownOffset 完全一致，抽成内部函数以便选区两端共用。
 */
function mapCaretToMdOffset(
  view: EditorView,
  ctx: EditorCtx,
  markdown: string,
  pos: number,
  /**
   * 是否把落在标记内容边界的位置吸附到含语法的外框。
   * 选区需要（保证还原后语法完整，选中 **bold** 而非 bold）；
   * 光标不能要——光标停在 bold 开头时，吸附前后输入 X 分别是
   * X**bold** 与 **Xbold**，语义完全不同。
   */
  snap = false
): number | null {
  const doc = view.state.doc;
  if (doc.content.size <= 0) return null;
  const docBlocks = collectDocLeafBlocks(doc);
  if (docBlocks.length === 0) return null;
  // 光标所在叶子块：优先取包含 pos 的块；
  // pos 落在块间/文档开头（不在任何块区间内）时，取「块中心」与 pos 最近的块
  const cursor = docBlocks.find((b) => pos >= b.pos && pos <= b.pos + b.size);
  let target: DocLeafBlock;
  if (cursor) {
    target = cursor;
  } else {
    target = docBlocks[0];
    let best = Infinity;
    for (const b of docBlocks) {
      const d = Math.abs(pos - (b.pos + b.size / 2));
      if (d < best) {
        best = d;
        target = b;
      }
    }
  }
  // 块整体序号（配对失败时的降级锚点）
  const index = docBlocks.indexOf(target);
  // 该块是文档中第几个「文本相同」的块（同文本序配对，消歧重复内容）
  let ordinal = 0;
  for (const b of docBlocks) {
    if (normText(b.text) === normText(target.text)) {
      ordinal++;
      if (b === target) break;
    }
  }
  // 块内文本偏移比例：以内容开头（pos + 1）为 0 点、可视内容长度为分母，
  // 与 mdast 侧 textStart（内容开头）+ 可视内容长度 对齐。
  // PM 位置按原始字符计数：CRLF 文件加载的代码块文本含 \r，
  // 直接相减会把 \r 也算进可视偏移导致比例偏大，需先换算为可视偏移。
  const textLen = normText(target.text).length;
  const rawWithin = Math.max(0, pos - (target.pos + 1));
  const within = Math.max(
    0,
    Math.min(
      textLen,
      rawWithin - crCountIn(target.text, 0, Math.min(rawWithin, target.text.length))
    )
  );
  const ratio = textLen > 0 ? within / textLen : 0;
  // mdast 侧定位：同文本序优先，整体序号降级
  // 无闭合围栏的开头 --- 会触发 remark-frontmatter 误吞后续块，解析前先防护；
  // *** 与 --- 等长，mdast position offset 不变，仍可用原始 markdown 做 offset 换算
  const remark = ctx.get(remarkCtx);
  const mdBlocks: MdLeafBlock[] = [];
  collectMdLeafBlocks(
    remark.parse(guardUnclosedFrontmatter(markdown)) as MdNode,
    mdBlocks,
    markdown
  );
  if (mdBlocks.length === 0) return null;
  const md =
    findBlockByOrdinal(mdBlocks, target.text, ordinal) ??
    mdBlocks[Math.min(index, mdBlocks.length - 1)];
  // 优先走行内级精确映射：mdast 行内节点 position 建表，语法标记天然跳过
  const spans = buildInlineMap(md, target);
  if (spans) return docPosToMdOffsetBySpans(spans, md, target, markdown, pos, snap);
  // 结构不对等（图片/公式/内联 HTML）时降级：块内按可视长度比例估算
  // 把可视偏移比例落到 mdast 块：从内容开头前进 ratio*normLen 个可视字符，
  // advanceVisible 跳过 \r，返回与 textarea 同一 offset 体系（含 \r）的位置
  const normLen = normText(md.text).length;
  return Math.min(
    md.end,
    Math.max(md.start, advanceVisible(markdown, md.textStart, Math.round(ratio * normLen)))
  );
}

/**
 * 把 WYSIWYG 光标位置映射为 markdown 源码中的字符 offset（块级锚点）。
 * 配对优先按「同文本序」消歧重复内容，失败时降级按整体块序号对齐，
 * 保证绝大多数场景都能锚定到同一块所在行（而非返回 null 导致光标不动）。
 * 仅在空文档 / 空源码时返回 null。
 * @param markdown 将展示在源码 textarea 中的文本（与光标定位目标一致）
 */
export function wysiwygCaretToMarkdownOffset(
  editor: Editor,
  markdown: string
): number | null {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    return mapCaretToMdOffset(view, ctx, markdown, view.state.selection.head);
  });
}

/** WYSIWYG 选区在 markdown 源码中对应的字符区间（块级锚点近似） */
export interface MdSelectionRange {
  from: number;
  to: number;
}

/**
 * 把 WYSIWYG 选区（含单点光标）映射为 markdown 源码中的字符区间。
 * 选区两个端点各自独立做块级锚点映射，端点同块时字符级精准；
 * 跨块时两端各自落在本块对应行，整体是块级近似。无选区时返回单点区间。
 */
export function wysiwygSelectionToMarkdownOffsets(
  editor: Editor,
  markdown: string
): MdSelectionRange | null {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const sel = view.state.selection;
    // 仅真实选区吸附语法边界；退化成光标时保持位置保真
    const snap = sel.from !== sel.to;
    const from = mapCaretToMdOffset(view, ctx, markdown, sel.from, snap);
    if (from == null) return null;
    if (sel.from === sel.to) return { from, to: from };
    const to = mapCaretToMdOffset(view, ctx, markdown, sel.to, snap);
    if (to == null) return { from, to: from };
    return { from: Math.min(from, to), to: Math.max(from, to) };
  });
}

/**
 * 把 markdown 源码中的字符 offset 映射为 WYSIWYG 文档位置（块级锚点）。
 * 配对策略与 mapCaretToMdOffset 对称：同文本序优先、整体序号降级。
 */
function mapMdOffsetToDocPos(
  view: EditorView,
  ctx: EditorCtx,
  markdown: string,
  offset: number
): number | null {
  const doc = view.state.doc;
  if (doc.content.size <= 0) return null;
  const docBlocks = collectDocLeafBlocks(doc);
  if (docBlocks.length === 0) return null;
  // mdast 侧找包含 offset 的块；落在块间/末尾空行取最近的左侧块；落在最前取第一块
  // 同 mapCaretToMdOffset：解析前先防无闭合围栏的开头 --- 误吞（*** 与 --- 等长）
  const remark = ctx.get(remarkCtx);
  const mdBlocks: MdLeafBlock[] = [];
  collectMdLeafBlocks(
    remark.parse(guardUnclosedFrontmatter(markdown)) as MdNode,
    mdBlocks,
    markdown
  );
  if (mdBlocks.length === 0) return null;
  let target: MdLeafBlock = mdBlocks[mdBlocks.length - 1];
  for (const b of mdBlocks) {
    if (offset >= b.start && offset <= b.end) {
      target = b;
      break;
    }
    if (offset >= b.start) target = b;
  }
  if (offset < mdBlocks[0].start) target = mdBlocks[0];
  // 块整体序号（配对失败时的降级锚点）
  const index = mdBlocks.indexOf(target);
  // 该块是 mdast 中第几个「文本相同」的块（同文本序配对，消歧重复内容）
  let ordinal = 0;
  for (const b of mdBlocks) {
    if (normText(b.text) === normText(target.text)) {
      ordinal++;
      if (b === target) break;
    }
  }
  // 块内文本偏移比例：offset 到内容开头之间的可视偏移（跳过 \r）÷ 可视内容长度
  const normLen = normText(target.text).length;
  const rawWithin = Math.max(0, offset - target.textStart);
  const visWithin = Math.max(
    0,
    rawWithin - crCountIn(markdown, target.textStart, offset)
  );
  const ratio = normLen > 0 ? Math.min(1, visWithin / normLen) : 0;
  // doc 侧定位：同文本序优先，整体序号降级
  const docBlock =
    findBlockByOrdinal(docBlocks, target.text, ordinal) ??
    docBlocks[Math.min(index, docBlocks.length - 1)];
  // 优先走行内级精确映射：mdast 行内节点 position 建表，语法标记天然跳过
  const spans = buildInlineMap(target, docBlock);
  if (spans) return mdOffsetToDocBySpans(spans, docBlock, markdown, offset);
  // 结构不对等（图片/公式/内联 HTML）时降级：块内按可视长度比例估算
  // 内容开头（docBlock.pos + 1）为 0 点、可视内容长度为分母，与 mdast 侧对齐。
  // PM 位置按原始字符计数：可视偏移换算回 PM 坐标时要把块内 \r 加回
  // （CRLF 文件加载的代码块文本含 \r，直接加可视偏移会少算）。
  const docTextLen = normText(docBlock.text).length;
  const docRawWithin = visibleSpanRaw(docBlock.text, Math.round(docTextLen * ratio));
  return Math.max(
    docBlock.pos,
    Math.min(docBlock.pos + docBlock.size, docBlock.pos + 1 + docRawWithin)
  );
}

/** 安全地派发选区：位置按当前文档长度收敛并兜底异常，避免越界抛错 */
function dispatchSelectionSafely(
  view: EditorView,
  start: number,
  end: number,
  /** 是否把选区滚动到可见。仅首次设置时需要；stabilize 的重放不带滚动，否则连续多次滚动会抖 */
  scroll = false
): boolean {
  try {
    const doc = view.state.doc;
    const size = doc.content.size;
    const f = Math.min(Math.max(start, 0), size);
    const t = Math.min(Math.max(end, 0), size);
    const tr = view.state.tr.setSelection(TextSelection.create(doc, f, t));
    view.dispatch(scroll ? tr.scrollIntoView() : tr);
    return true;
  } catch {
    /* 文档已变动导致位置失效，忽略 */
    return false;
  }
}

/** 请求把当前选区滚动到可见（不改变选区本身） */
function scrollSelectionIntoView(view: EditorView): void {
  try {
    if ((view as unknown as { isDestroyed?: boolean }).isDestroyed) return;
    view.dispatch(view.state.tr.scrollIntoView());
  } catch {
    /* 文档已销毁或状态已变，忽略 */
  }
}

/**
 * 把光标所在块滚动到指定的视口位置。
 *
 * ProseMirror 的 scrollIntoView 只保证「刚好可见」，光标会贴着视口顶部或底部。
 * 切换模式时传入切换前光标在屏幕上的位置，即可让光标停在原处（视线不动）；
 * targetY 为 null 时退化为居中。已在目标附近时不调整，避免无谓滚动。
 */
function alignCaretInScroller(view: EditorView, targetY: number | null): void {
  try {
    if ((view as unknown as { isDestroyed?: boolean }).isDestroyed) return;
    const at = view.domAtPos(view.state.selection.head);
    const node = at.node;
    const el: HTMLElement | null =
      node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    if (!el) return;
    // 光标所在的可视块：代码块的 CM 行 / 段落 / 标题 / 列表项
    const block =
      el.closest?.(".cm-line") ??
      el.closest?.("p, h1, h2, h3, h4, h5, h6, li") ??
      el;
    // 向上找滚动容器
    let p = block.parentElement;
    let scroller: HTMLElement | null = null;
    while (p) {
      const ov = getComputedStyle(p).overflowY;
      if (ov === "auto" || ov === "scroll") {
        scroller = p;
        break;
      }
      p = p.parentElement;
    }
    if (!scroller) return;
    const blockRect = block.getBoundingClientRect();
    const scRect = scroller.getBoundingClientRect();
    // 未指定目标位置时退化为居中
    const desired = targetY != null ? targetY : (scRect.height - blockRect.height) / 2;
    const delta = blockRect.top - (scRect.top + desired);
    if (Math.abs(delta) < scRect.height * 0.12) return; // 已在目标附近
    scroller.scrollTop += delta;
  } catch {
    /* 布局异常（节点已移除等）时忽略 */
  }
}

/** pos 是否落在某个 code_block 的开头（forwardUpdate 钳住选区的特征） */
function isCodeBlockStart(view: EditorView, pos: number): boolean {
  let found = false;
  view.state.doc.nodesBetween(0, view.state.doc.content.size, (node, p) => {
    // forwardUpdate 推送的位置是 node.pos + 1 + main.from，main.from=0 时为内容开头
    if (node.type.name === "code_block" && (p === pos || p + 1 === pos)) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

/**
 * 延迟重放选区直到稳定。
 *
 * 背景：setMarkdown 重建文档后，交互式代码块的 node-view 是新建的。PM 派发
 * 选区时 node-view 的 setSelection 内部 initializeCodeMirror 创建 CM，但 CM 的
 * DOM 要等 Vue 组件 onMounted 后才挂载（isConnected）；未挂载时 setSelection
 * 会提前 return、丢弃 anchor/head，CM 保持初始选区 [0,0]。随后 CM 挂载并获得
 * 焦点后，code-block 插件的 forwardUpdate 会把 [0,0] 推回 PM，把刚恢复的选区
 * 钳到代码块起点。
 *
 * 对策：等 CM 挂载完成后重放同一选区。此时 node-view 的 setSelection 能真正把
 * 选区同步进 CM，CM 与 PM 一致后 forwardUpdate 不再破坏，选区自然稳定。
 * 重放只在选区仍停留在某个代码块起点（被钳住的标志）时进行，避免覆盖用户
 * 已做的任何调整。
 */
function stabilizeSelection(view: EditorView, start: number, end: number): void {
  let attempts = 8;
  const tick = () => {
    if (attempts-- <= 0) return;
    if ((view as unknown as { isDestroyed?: boolean }).isDestroyed) return;
    const sel = view.state.selection;
    if (sel.from === start && sel.to === end) return; // 已就位
    if (sel.from !== sel.to) return; // 用户已另选区间，尊重
    if (!isCodeBlockStart(view, sel.from)) return; // 非被钳住，尊重用户
    dispatchSelectionSafely(view, start, end);
    setTimeout(tick, 40);
  };
  setTimeout(tick, 40);
}

/**
 * 把 markdown 源码中的字符 offset 映射为 WYSIWYG 光标位置（块级锚点），
 * 并设置光标、聚焦编辑器。配对策略与 wysiwygCaretToMarkdownOffset 对称：
 * 同文本序优先、整体序号降级，失败时保持原光标位置不变。
 * @param markdown 源码 textarea 中的文本（与编辑器当前内容一致）
 */
export function setCaretByMarkdownOffset(
  editor: Editor,
  markdown: string,
  offset: number,
  /**
   * 期望光标停留的视口位置（相对滚动容器顶部的像素）。
   * 切换模式时传入切换前光标在屏幕上的位置，做到「视线不动」；
   * 不传时退化为居中。
   */
  targetViewY: number | null = null
): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const doc = view.state.doc;
    const docSize = doc.content.size;
    if (docSize <= 0) return;
    const pos = mapMdOffsetToDocPos(view, ctx, markdown, offset);
    if (pos == null) return;
    dispatchSelectionSafely(view, pos, pos, true);
    view.focus();
    // 可视化容器可能刚从 display:none 恢复（退出源码模式），首帧布局尚未稳定，
    // scrollIntoView 算不出位置，下一帧补一次滚动
    requestAnimationFrame(() => {
      scrollSelectionIntoView(view);
      alignCaretInScroller(view, targetViewY);
    });
    stabilizeSelection(view, pos, pos);
  });
}

/**
 * 把 markdown 源码中的字符区间映射为 WYSIWYG 选区（块级锚点），
 * 并设置选区、聚焦编辑器。from === to 时等价于设置单点光标。
 * 两个端点各自独立映射，端点同块时字符级精准，跨块时块级近似。
 */
export function setSelectionByMarkdownOffsets(
  editor: Editor,
  markdown: string,
  from: number,
  to: number,
  /** 期望光标停留的视口位置，语义同 setCaretByMarkdownOffset */
  targetViewY: number | null = null
): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const doc = view.state.doc;
    const docSize = doc.content.size;
    if (docSize <= 0) return;
    const a = mapMdOffsetToDocPos(view, ctx, markdown, from);
    if (a == null) return;
    let b = a;
    if (to !== from) {
      const m = mapMdOffsetToDocPos(view, ctx, markdown, to);
      if (m != null) b = m;
    }
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    dispatchSelectionSafely(view, start, end, true);
    view.focus();
    // 同上：容器刚恢复显示时首帧滚不动，下一帧补一次
    requestAnimationFrame(() => {
      scrollSelectionIntoView(view);
      alignCaretInScroller(view, targetViewY);
    });
    stabilizeSelection(view, start, end);
  });
}

/**
 * 测量当前光标在屏幕上的位置（相对滚动容器顶部的像素）。
 * 切换模式前调用，把结果传给另一侧，即可让光标停在原处（视线不动）。
 */
export function getCaretViewY(editor: Editor): number | null {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    try {
      const at = view.domAtPos(view.state.selection.head);
      const node = at.node;
      const el: HTMLElement | null =
        node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
      if (!el) return null;
      const block =
        el.closest?.(".cm-line") ??
        el.closest?.("p, h1, h2, h3, h4, h5, h6, li") ??
        el;
      let p = block.parentElement;
      let scroller: HTMLElement | null = null;
      while (p) {
        const ov = getComputedStyle(p).overflowY;
        if (ov === "auto" || ov === "scroll") {
          scroller = p;
          break;
        }
        p = p.parentElement;
      }
      const scRect = scroller
        ? scroller.getBoundingClientRect()
        : { top: 0, height: window.innerHeight };
      return block.getBoundingClientRect().top - scRect.top;
    } catch {
      return null;
    }
  });
}

/** 大纲条目（侧边栏「大纲」面板的数据源） */
export interface HeadingItem {
  /** 标题层级（1~6） */
  level: number;
  /** 标题文本；空标题显示为占位文案 */
  text: string;
  /** 标题节点在文档中的位置，用于点击跳转 */
  pos: number;
}

/**
 * 收集当前文档中全部标题，供侧边栏大纲展示。
 * 按文档顺序返回（descendants 为深度优先前序，天然有序）。
 */
export function getHeadings(editor: Editor): HeadingItem[] {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const out: HeadingItem[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== "heading") return true;
      out.push({
        level: Number(node.attrs.level) || 1,
        text: node.textContent || "（无标题）",
        pos,
      });
      return false; // heading 内部不再下钻
    });
    return out;
  });
}

/** 跳转到文档中指定位置（大纲点击：选中 + 平滑滚动 + 聚焦编辑器） */
export function scrollToPos(editor: Editor, pos: number): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const docSize = view.state.doc.content.size;
    const safePos = Math.min(Math.max(pos, 0), docSize);
    // 落点取节点内部（pos + 1），避免光标停在节点边界上
    const target = view.state.doc.resolve(Math.min(safePos + 1, docSize));
    view.dispatch(view.state.tr.setSelection(TextSelection.near(target)));
    // 滚动到该标题：优先用节点 DOM，回退到坐标位置
    const dom = view.nodeDOM(safePos) as HTMLElement | null;
    if (dom?.scrollIntoView) {
      dom.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      const coords = view.coordsAtPos(Math.min(safePos + 1, docSize));
      view.dom.parentElement?.scrollTo?.({ top: coords.top, behavior: "smooth" });
    }
    view.focus();
  });
}

/**
 * 屏幕坐标 → 文档位置（原生拖放的落点定位）。
 * 坐标落在编辑区之外时回退到当前光标位置，保证一定返回合法位置。
 */
export function posAtCoords(editor: Editor, x: number, y: number): number {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    return view.posAtCoords({ left: x, top: y })?.pos ?? view.state.selection.from;
  });
}

/**
 * 文档位置 → 屏幕坐标（拖拽落点指示线的定位）。
 * 返回视口坐标系下的 left / top / bottom，用于在拖图片的过程中
 * 画一条跟随鼠标的插入位置竖线。
 */
export function coordsAtPos(
  editor: Editor,
  pos: number
): { left: number; top: number; bottom: number } {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const safe = Math.max(0, Math.min(pos, view.state.doc.content.size));
    const c = view.coordsAtPos(safe);
    return { left: c.left, top: c.top, bottom: c.bottom };
  });
}

/**
 * 聚焦编辑器并把光标放到文档开头。
 *
 * 新建文档后调用：否则焦点还留在工具栏按钮上，用户必须再用鼠标点一下
 * 编辑区才能开始打字。
 */
export function focusEditorStart(editor: Editor): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    // 空文档时内容尺寸为 2（一个空段落），光标收敛到 1 即段落内容起始，
    // 直接用 1 在极端情况下（文档被清空到 0）会解析越界。
    const size = view.state.doc.content.size;
    const pos = Math.min(1, Math.max(0, size));
    try {
      const $pos = view.state.doc.resolve(pos);
      view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
    } catch {
      /* 文档结构异常时退化为仅聚焦，不影响主流程 */
    }
    view.focus();
  });
}

/**
 * 创建一个已配置插件、但未 create 的 Milkdown Editor 实例。
 * @param root 挂载的 DOM 容器（必须是带 .milkdown 类的元素）
 * @param defaultValue 初始 Markdown / HTML 内容（默认空）
 * @param onChange 内容变化回调（markdownUpdated 事件，参数为当前 Markdown 文本）
 */
export function createEditor(
  root: HTMLElement,
  defaultValue: string = "",
  onChange?: (markdown: string) => void
): Editor {
  const editor = Editor.make()
    .config((ctx) => {
      // 挂载根节点
      ctx.set("root", root);
      // 默认值：空文档（使用 defaultValueCtx，而非字符串 key）
      ctx.set(defaultValueCtx, defaultValue);
      // 给 Milkdown 自动生成的 .milkdown 根节点注入 data-theme，
      // 让 tokens.css 的 [data-theme] 变量切换生效。
      ctx.set(rootAttrsCtx, { "data-theme": "light" });
      // 覆盖 text handler：序列化文本时不再转义 [ 和 ]，
      // 使 [toc]、> [!NOTE]（Obsidian Callout）等语法能原样导出，
      // 外部编辑器（Typora/Obsidian 等）可以正常识别。
      // highlight handler：把 highlight mark（==高亮==）序列化回 ==text==。
      const extraHandlers: Record<string, Handle> = {
        text: customTextHandler,
        highlight: (node, _parent, state, info) =>
          `==${state.containerPhrasing(node, info)}==`,
        // 上标 ^x^ / 下标 ~x~（script.ts）：序列化回自定义语法。
        // 下标 handler 输出 ~...~，能被编辑器自己解析成下标的前提是
        // remark-gfm 以 singleTilde: false 运行（plugins.ts / script.ts 已配置）。
        superscript: (node, _parent, state, info) =>
          `^${state.containerPhrasing(node, info)}^`,
        subscript: (node, _parent, state, info) =>
          `~${state.containerPhrasing(node, info)}~`,
        list: customListHandler,
        strong: customStrongHandler,
        emphasis: customEmphasisHandler,
      };
      ctx.update(remarkStringifyOptionsCtx, (options): RemarkStringifyOptions => ({
        ...options,
        // 无序列表用「-」而非默认的「*」：与多数编辑器（Typora/Obsidian/VSCode）
        // 导出的源码一致，避免混用 * / - 两种风格。
        bullet: "-",
        // 分割线用「---」而非默认的「***」：mdast-util-to-markdown 的分割线
        // 选项键是 `rule`（不是 thematicBreak），默认 '*' → 输出 `***`，
        // 改成 '-' 即输出 `---`。
        rule: "-",
        handlers: {
          ...options.handlers,
          ...extraHandlers,
        },
      }));
      // 代码块配置：注入语言列表 + 启用语法高亮。
      // - languages：让语言选择器可搜索/选择 160+ 种语言。
      // - extensions: [syntaxHighlighting(mtHighlightStyle)]：启用 CM6 语法高亮，
      //   高亮颜色直接引用 --mt-token-* / --mt-color-primary 变量，
      //   用户主题改变量即改代码配色。
      // 注意：codeBlockConfig 是 $Ctx（createSlice 的封装），
      // 必须通过 .key（SliceType）传给 ctx.get/set，直接传 $Ctx 会抛 contextNotFound。
      ctx.set(codeBlockConfig.key, {
        ...ctx.get(codeBlockConfig.key),
        extensions: [syntaxHighlighting(mtHighlightStyle)],
        languages,
        // 扁平化现代图标（Lucide 线性风格，stroke 跟随文字颜色）
        copyIcon:
          `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        searchIcon:
          `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
        clearSearchIcon:
          `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        expandIcon:
          `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
      });
      // 列表项 NodeView 配置：任务列表渲染为 SVG 复选框（点击切换由组件内置）
      ctx.set(listItemBlockConfig.key, {
        ...ctx.get(listItemBlockConfig.key),
        renderLabel: renderListItemLabel,
      });
      // 内容变化监听：供外层做“未保存修改”追踪
      if (onChange) {
        // 不用 markdownUpdated：listener 插件在 SerializerReady 时把 serializer
        // 缓存成闭包常量，之后所有回调都用这份旧 serializer 序列化；而本项目
        // 打开文件时会按原文风格重建 serializerCtx（applySerializationStyle），
        // 重建后 markdownUpdated 仍用旧风格序列化 → 与 getMarkdown / normalize
        // Markdown（当前 serializerCtx）口径不一致 → 打开 + 列表等非默认风格
        // 的文件会被误报“未保存修改”（打开即脏）。
        // 改用 updated(doc) 事件：回调内每次取当前 serializerCtx 序列化，
        // 与 getMarkdown 走同一清理逻辑，口径统一。
        ctx.get(listenerCtx).updated((ctx, doc) => {
          try {
            onChange(cleanMarkdownTableBr(ctx.get(serializerCtx)(doc)));
          } catch {
            /* 极端结构序列化失败时跳过本次回调，避免脏检查被拖垮 */
          }
        });
      }
    })
    // 注册所有插件（commonmark/gfm/history/math/diagram/code-block/listener）
    .use(getEditorPlugins())
    .use(listener);

  return editor;
}

/**
 * 编辑区“周围留白”点击防失焦（对齐 Typora：点周围不丢焦、光标还在、可继续输入）。
 *
 * 布局上 .milkdown 是滚动/根容器，正文列 .ProseMirror 仅 860px 居中，
 * 左右大片留白与顶/底 padding 落在 .ProseMirror 之外。点这些“不可编辑留白”
 * 默认会让 .ProseMirror 失焦（光标消失、无法继续输入）。本函数在捕获阶段
 * 拦截这些 mousedown：阻止默认（避免失焦），保持已有选区；
 * 若当前未聚焦则把焦点交还 .ProseMirror。
 *
 * 不拦截：编辑区内部点击（走 ProseMirror 正常逻辑）、浮层（斜杠菜单/表格菜单/
 * 提示气泡，它们是 .milkdown 的子节点但不应被吞掉）、滚动条拖拽。
 */
let surroundGuardInstalled = false;
export function installSurroundFocusGuard(): void {
  if (surroundGuardInstalled) return;
  surroundGuardInstalled = true;

  document.addEventListener(
    "mousedown",
    (e: MouseEvent) => {
      if (e.button !== 0) return; // 仅处理左键
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const milkdown = target.closest(".milkdown") as HTMLElement | null;
      if (!milkdown) return;

      const pm = milkdown.querySelector(".ProseMirror") as HTMLElement | null;
      if (!pm) return;

      // 点中可编辑区内部：正常交给 ProseMirror 处理
      if (pm.contains(target)) return;

      // 浮层（斜杠菜单 / 表格菜单 / 提示 / 链接框）：放行，否则点不到菜单项
      if (target.closest(".mt-slash-menu, .mt-table-menu, .mt-slash-hint, .mt-slash-linkbox")) {
        return;
      }

      // 滚动条区域：放行，否则无法拖拽滚动
      const rect = milkdown.getBoundingClientRect();
      const sbW = milkdown.offsetWidth - milkdown.clientWidth;
      const sbH = milkdown.offsetHeight - milkdown.clientHeight;
      if (sbW > 0 && e.clientX >= rect.right - sbW) return;
      if (sbH > 0 && e.clientY >= rect.bottom - sbH) return;

      // 命中“不可编辑留白”：阻止默认以避免 .ProseMirror 失焦，保持现有选区。
      e.preventDefault();
      if (!pm.contains(document.activeElement)) {
        // 当前未聚焦则把焦点交还编辑区（光标落到最近一次选区 / 文末）
        pm.focus();
      }
    },
    true,
  );
}
