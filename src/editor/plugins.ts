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
import { mathBlockPlugins } from "./math-view";
import { alertPlugins } from "./alert";
import { highlightPlugins } from "./highlight";
import { htmlView } from "./html-view";
import { htmlMergePlugins } from "./html-merge";
import { imageView } from "./image-view";
import { listItemPlugins } from "./list-item";
import { frontmatterPlugins } from "./frontmatter";
import { tocPlugins } from "./toc";
import { codeBlockComponent } from "@milkdown/components/code-block";
// gapcursor：让光标可以出现在 math_block / diagram 等块级原子节点的
// 前后（默认未注册，原子块周围放不进光标，也无法用箭头键跨越）。
import { $prose } from "@milkdown/utils";
import { gapCursor } from "@milkdown/prose/gapcursor";
import { tableMenuPlugin } from "./table-menu";
import { findReplacePlugin } from "./find-replace";
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
    ...commonmark,
    ...gfm,
    ...history,
    // 只取 @milkdown/plugin-math 的 inline 部分（remark-math + katex 配置 + 行内公式 schema/输入规则），
    // block 公式完全由本项目自定义的 mathBlockPlugins 接管，避免官方 schema.toDOM 自带 KaTeX 导致的双重渲染。
    ...remarkMathPlugin,
    katexOptionsCtx,
    ...mathInlineSchema,
    mathInlineInputRule,
    ...mathBlockPlugins,
    ...diagram,
    diagramView,
    gapcursorPlugin,
    tableMenuPlugin,
    findReplacePlugin,
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
    ...listItemPlugins,
    ...frontmatterPlugins,
    ...tocPlugins,
    ...codeBlockComponent,
  ];
}
