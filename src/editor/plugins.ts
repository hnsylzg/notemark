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
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
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
import { findReplacePlugin } from "./find-replace";
import { inlineMarkEscapePlugin } from "./inline-mark-escape";
import { imagePastePlugin } from "./image-paste";
import { imageDropPlugin } from "./image-drop";
import { imageBlockPlugin } from "./image-block";
import "@milkdown/prose/gapcursor/style/gapcursor.css";

const gapcursorPlugin = $prose(() => gapCursor());

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
    ...commonmark,
    // 删除线（~ / ~~）保持 @milkdown/preset-gfm 的默认规则，不做任何改动
    ...gfm,
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
