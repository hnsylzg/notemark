/*
 * underline.ts — 下划线 <u>…</u> 支持
 *
 * 背景：markdown 没有原生下划线语法。按「不引入新语法、跨工具兼容」的方针，
 * 下划线的 md 源码形态就是行内 HTML <u>text</u>（GitHub / Typora / Pandoc 等
 * 都能正常显示）；编辑器内把它做成真正的 mark，而不是 html-merge 合并出的
 * 行内 html 原子节点（atom，内容不可编辑、无法撤销）。
 *
 * 实现：
 * - 解析：html-merge.ts 在合并 <u>…</u> 时产出 mdast underline 节点，本文件
 *   $mark 的 parseMarkdown 把它解析成 underline mark；粘贴含 <u> 的富文本由
 *   parseDOM(tag: "u") 识别。
 * - 序列化：toMarkdown 输出 mdast underline 节点，index.ts 注册的
 *   remark-stringify handler 还原成 <u>text</u>，导入导出往返无损。
 * - 输入：不设 markdown 输入规则（<u> 逐字符输入交给常规文本），主要入口是
 *   右键菜单的「下划线」（toggle 选中文字 / 开启持续输入，见 format-menu.ts）。
 *
 * 取舍：内部嵌套 html 标签的 <u>（如 <u><b>xx</b></u>）无法转成纯 mark，
 * 仍走 html-merge 的原逻辑合并成行内 html 节点（html-view 渲染，内部不可
 * 编辑）；<u> 带属性（title/class 等）不阻止转 mark，属性随序列化丢弃——
 * u 标签实际很少带属性，可接受。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import { $mark } from "@milkdown/kit/utils";

export const underlineSchema = $mark("underline", () => ({
  inclusive: true,
  parseDOM: [{ tag: "u" }],
  toDOM: () => ["u"],
  parseMarkdown: {
    match: (node) => node.type === "underline",
    runner: (state, node, markType) => {
      state.openMark(markType, {}).next(node.children).closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "underline",
    runner: (state, mark) => {
      state.withMark(mark, "underline");
    },
  },
}));

/** 注册给 getEditorPlugins() 的插件集合 */
export const underlinePlugins: MilkdownPlugin[] = [underlineSchema];
