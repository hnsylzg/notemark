/*
 * plugins.ts — Milkdown 插件集合（统一注册，不做 UI 配置）
 *
 * 注意：
 * - 使用 @milkdown/kit 的 preset，而非 crepe。
 * - code-block 来自 @milkdown/components/code-block（CM6 实现，根入口不导出）。
 * - diagram 来自 @milkdown/plugin-diagram（Mermaid）。
 * - math 来自 @milkdown/plugin-math（仅导出 math，内含 inline + block）。
 *
 * 这里只负责“声明”插件数组，不在本文件创建 editor 实例。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import { commonmark, inlineCodeSchema } from "@milkdown/kit/preset/commonmark";
import {
  gfm,
  remarkGFMPlugin,
  strikethroughInputRule as gfmStrikethroughInputRule,
} from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
// clipboard：粘贴纯文本时用 markdown parser 解析，从而把粘贴的
// markdown 表格 / ```mermaid / $$ 公式等转换为对应节点（默认未注册，
// 否则外部复制的 markdown 只会以纯文本插入）。
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import {
  mathInlineSchema,
  mathInlineInputRule,
  remarkMathPlugin,
  katexOptionsCtx,
} from "@milkdown/plugin-math";
import { diagram } from "@milkdown/plugin-diagram";
import { diagramView } from "./diagram-view";
import { mathBlockPlugins, mathInlineView } from "./math-view";
import { alertPlugins } from "./alert";
import { highlightPlugins } from "./highlight";
import { scriptPlugins } from "./script";
import { htmlView } from "./html-view";
import { htmlMergePlugins } from "./html-merge";
import { htmlBlockPlugins } from "./html-block";
import { imageView } from "./image-view";
import { listItemPlugins } from "./list-item";
import { frontmatterPlugins } from "./frontmatter";
import { tocPlugins } from "./toc";
import { strongParensPlugins } from "./strong-parens";
import { codeBlockComponent } from "@milkdown/components/code-block";
// gapcursor：让光标可以出现在 math_block / diagram 等块级原子节点的
// 前后（默认未注册，原子块周围放不进光标，也无法用箭头键跨越）。
import { $prose } from "@milkdown/utils";
import { gapCursor } from "@milkdown/prose/gapcursor";
import { tableMenuPlugin } from "./table-menu";
import { slashMenuPlugin } from "./slash-menu";
import { atomBlockDeletePlugin } from "./atom-block-delete";
import { blockExitPlugin, codeBlockExitClickPlugin } from "./block-exit";
import { findReplacePlugin } from "./find-replace";
import { inlineMarkEscapePlugin } from "./inline-mark-escape";
import { imagePastePlugin } from "./image-paste";
import { imageDropPlugin } from "./image-drop";
import { imageBlockPlugin } from "./image-block";
import "@milkdown/prose/gapcursor/style/gapcursor.css";

const gapcursorPlugin = $prose(() => gapCursor());

/**
 * preset-gfm 的 remark-gfm 默认 singleTilde: true（单个 ~ 也算删除线），
 * 且它的 strikethroughInputRule 也认单波浪——二者会抢占「~下标~」语法。
 * 这里从 gfm 集合中剔除它们，改由 script.ts 提供：
 *  - gfmRemark：remark-gfm + { singleTilde: false }（删除线只认 ~~）；
 *  - strikethroughInputRule：只匹配 ~~ 的删除线输入规则。
 * 注意 preset-gfm 的 plugins 是嵌套数组经 flat 摊平，remark-gfm 会以
 * options（$Ctx 插件）与 plugin 两个独立元素出现在 gfm 数组中，
 * 需用身份引用分别剔除，不能按数组剔除。
 */
const gfmPlugins = gfm.filter(
  (p) =>
    p !== remarkGFMPlugin.options &&
    p !== remarkGFMPlugin.plugin &&
    p !== gfmStrikethroughInputRule
);

/**
 * 行内代码改为「包含型」（inclusive: true）。
 *
 * milkdown 默认 inclusive: false——代码片段是闭合端，光标停在代码末尾时
 * ProseMirror 认为光标已在代码之外，后续输入不会继承 code mark，
 * 表现为"点代码尾部继续输入，字符进不去"。加粗 / 删除线 / 高亮都是包含型，
 * 末尾输入自然继承，这里把行内代码对齐到同样行为；
 * 退出交给 Esc（inline-mark-escape）或方向键，与加粗一致。
 */
const inlineCodeInclusiveSchema = inlineCodeSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  inclusive: true,
}));

/**
 * 返回一组可直接传给 Milkdown 的扩展（插件）集合。
 * 各 preset/组件导出可能是单个 MilkdownPlugin 或 MilkdownPlugin[]，
 * 统一展开成扁平的 MilkdownPlugin[] 后，整体传给 Editor.use()。
 */
export function getEditorPlugins(): MilkdownPlugin[] {
  return [
    // 退格 / Delete 删除不可选原子块（yaml 元数据 / htmlBlock）。
    // 刻意排在最前面：基础 keymap 的 Backspace 链（deleteSelection → joinBackward
    // → selectNodeBackward）对 selectable:false 的 atom 落空，但链中某一步也可能
    // 返回 true 却什么都没做，那样排在后面的插件就永远没机会执行。
    // 本插件只在光标紧邻这两类块时才返回 true，其余一律交回默认行为。
    atomBlockDeletePlugin,
    // 元数据 / 目录 / 分割线 / 公式块 / 流程图 / HTML 块的 Ctrl+Enter
    // 「退出到下一行」。刻意排在最前面：这些块都是原子块，光标停在它们前后时
    // 基础 keymap 的 Enter 链（splitBlock 等）可能先返回 true 却什么都没做，
    // 排在后面就永远轮不到。插件只认上述几类节点，其余（表格 / 代码块等）
    // 一律返回 false，交回它们自带的快捷键。
    blockExitPlugin,
    // 代码块在文末时，鼠标点其下方空白自动补空段落并进入（对齐原子块的点出来行为）
    codeBlockExitClickPlugin,
    ...commonmark,
    // 行内代码改为包含型（点尾部能继续输入），须在 commonmark 之后注册以覆盖
    ...inlineCodeInclusiveSchema,
    // 表格 / 任务列表 / 脚注 / 删除线等 GFM 支持（remark-gfm 与删除线输入
    // 规则已替换为只认 ~~ 的严格版，单波浪 ~ 让给下标，见 script.ts）
    ...gfmPlugins,
    ...history,
    // 只取 @milkdown/plugin-math 的 inline 部分（remark-math + katex 配置 + 行内公式 schema/输入规则），
    // block 公式完全由本项目自定义的 mathBlockPlugins 接管，避免官方 schema.toDOM 自带 KaTeX 导致的双重渲染。
    ...remarkMathPlugin,
    katexOptionsCtx,
    ...mathInlineSchema,
    mathInlineInputRule,
    mathInlineView,
    ...mathBlockPlugins,
    ...diagram,
    diagramView,
    gapcursorPlugin,
    tableMenuPlugin,
    findReplacePlugin,
    // 必须排在 findReplacePlugin 之后：查找栏打开时 Esc 先用于关闭查找栏，
    // 查找栏关闭状态下 Esc 才轮到"跳出加粗等行内格式"（见 inline-mark-escape.ts）
    inlineMarkEscapePlugin,
    // 必须排在 clipboard 之前：ProseMirror 的 handlePaste 按注册顺序取第一个
    // 返回 true 的插件，纯图片粘贴没有 text/html 与 text/plain，
    // 交给 clipboard 解析只会得到空内容（图片丢失），这里先接管。
    imagePastePlugin,
    imageDropPlugin,
    imageBlockPlugin,
    clipboard,
    ...alertPlugins,
    ...highlightPlugins,
    // 上标 ^x^ / 下标 ~x~：拆分 text 的 scriptRemark 须排在高亮等同样拆分
    // text 的 remark 之后（==a^b^== 才能先成高亮再拆上标）
    ...scriptPlugins,
    htmlView,
    imageView,
    ...htmlMergePlugins,
    ...htmlBlockPlugins,
    ...listItemPlugins,
    ...frontmatterPlugins,
    ...tocPlugins,
    ...strongParensPlugins,
    ...codeBlockComponent,
    // 斜杠命令菜单放最后：它依赖上面所有自定义节点（math/alert/toc/yaml 等）
    // 的 schema，注册顺序靠后可确保类型都能取到。
    slashMenuPlugin,
  ];
}
