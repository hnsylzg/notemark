/*
 * script.ts — 上标 ^上标^ 与下标 ~下标~ 支持
 *
 * 背景：remark-gfm 的删除线默认 singleTilde: true，单个 ~ 也会被解析成
 * 删除线，导致「~下标~」渲染成删除线。本项目把 ~ 让给下标，删除线只保留
 * GFM 双波浪（与 Typora 一致）：
 *
 *   ~~删除线~~ → 仍为删除线（preset-gfm 的 strike schema 渲染）
 *   ~下标~     → subscript mark（<sub>）
 *   ^上标^     → superscript mark（<sup>）
 *
 * 实现：
 * - 解析：preset-gfm 自带的 remark-gfm（singleTilde: true）与它的
 *   strikethroughInputRule（认单波浪）已在 plugins.ts 中被剔除，本文件
 *   提供 gfmRemark（singleTilde: false）与只认 ~~ 的删除线输入规则；
 * - scriptRemark：markdown 解析阶段把 text 节点里的 ^...^ / ~...~
 *   拆成自定义 mdast 节点 superscript / subscript（与 highlight.ts
 *   同思路）。须注册在高亮等同样拆 text 的 remark 之后，使
 *   ==a^b^== 这类嵌套先成高亮、再在高亮内拆出上标；
 * - $mark：渲染为 <sup>/<sub>，parseDOM 同时认 <sup>/<sub>，
 *   粘贴富文本里的上下标也能被识别；round-trip 由 index.ts 注册的
 *   remark-stringify handler 还原成 ^x^ / ~x~；
 * - $inputRule：输入 ^x^ / ~x~ 即时应用对应 mark（x^2^ 前是字母也能
 *   触发，因此上下标规则不设字母 lookbehind），删除线规则只认 ~~。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { MarkdownNode, RemarkPluginRaw } from "@milkdown/transformer";
import { $inputRule, $mark, $remark } from "@milkdown/kit/utils";
import { markRule } from "@milkdown/kit/prose";
import { strikethroughSchema } from "@milkdown/kit/preset/gfm";
import remarkGFM from "remark-gfm";
import type { Options as RemarkGfmOptions } from "remark-gfm";

/** 替换 preset-gfm 的 remark-gfm：删除线只认双波浪 ~~（singleTilde: false） */
export const gfmRemark = $remark<
  "notemark-gfm",
  RemarkGfmOptions | null | undefined
>("notemark-gfm", () => remarkGFM, { singleTilde: false });

/** 上标 / 下标拆分正则（内容不含自身分隔符与换行） */
const SUP_RE = /\^([^\^\n]+)\^/g;
// 下标加防误拆：不匹配前/后紧贴 ~ 的（~~x~ 这类删除线输入到一半的残留）
const SUB_RE = /(?<![~])~([^~\n]+)~(?!~)/g;

type ScriptType = "superscript" | "subscript";

/** 把文本按指定正则拆成 text 与自定义标记节点 */
function splitWith(
  value: string,
  type: ScriptType,
  regex: RegExp
): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value))) {
    if (match.index > last) {
      nodes.push({ type: "text", value: value.slice(last, match.index) });
    }
    nodes.push({ type, children: [{ type: "text", value: match[1] }] });
    last = match.index + match[0].length;
  }
  if (last < value.length) {
    nodes.push({ type: "text", value: value.slice(last) });
  }
  return nodes;
}

/** 依次拆分上标、下标（下标只作用于上标拆分后剩下的 text） */
function splitScriptText(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  const afterSup = splitWith(value, "superscript", SUP_RE);
  for (const node of afterSup) {
    if (
      node.type === "text" &&
      typeof node.value === "string" &&
      node.value.includes("~")
    ) {
      nodes.push(...splitWith(node.value, "subscript", SUB_RE));
    } else {
      nodes.push(node);
    }
  }
  return nodes;
}

const scriptRemarkTransform: RemarkPluginRaw<never[]> = () => (tree) => {
  const visit = (node: MarkdownNode): void => {
    if (!Array.isArray(node.children)) return;
    const newChildren: MarkdownNode[] = [];
    for (const child of node.children) {
      if (
        child.type === "text" &&
        typeof child.value === "string" &&
        (child.value.includes("^") || child.value.includes("~"))
      ) {
        newChildren.push(...splitScriptText(child.value));
      } else {
        newChildren.push(child);
      }
      if (Array.isArray(child.children)) visit(child);
    }
    node.children = newChildren;
  };
  visit(tree as unknown as MarkdownNode);
};

/** 文本拆分：须注册在高亮等同样拆分 text 的 remark 之后 */
export const scriptRemark = $remark("notemark-script", () => scriptRemarkTransform);

export const superscriptSchema = $mark("superscript", () => ({
  inclusive: true,
  parseDOM: [{ tag: "sup" }],
  toDOM: () => ["sup"],
  parseMarkdown: {
    match: (node) => node.type === "superscript",
    runner: (state, node, markType) => {
      state.openMark(markType, {}).next(node.children).closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "superscript",
    runner: (state, mark) => {
      state.withMark(mark, "superscript");
    },
  },
}));

export const subscriptSchema = $mark("subscript", () => ({
  inclusive: true,
  parseDOM: [{ tag: "sub" }],
  toDOM: () => ["sub"],
  parseMarkdown: {
    match: (node) => node.type === "subscript",
    runner: (state, node, markType) => {
      state.openMark(markType, {}).next(node.children).closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "subscript",
    runner: (state, mark) => {
      state.withMark(mark, "subscript");
    },
  },
}));

/** 上标输入：输入 x^2^ 即时应用上标（前导字母不设限制） */
export const superscriptInputRule = $inputRule((ctx) =>
  markRule(/\^([^\^\n]+)\^$/, superscriptSchema.type(ctx))
);

/** 下标输入：输入 H~2~O 即时应用下标（单波浪不再触发删除线） */
export const subscriptInputRule = $inputRule((ctx) =>
  markRule(/~([^~\n]+)~$/, subscriptSchema.type(ctx))
);

/** 删除线输入规则只认双波浪 ~~（preset-gfm 原规则认单波浪，已剔除） */
export const strikethroughInputRule = $inputRule((ctx) =>
  markRule(
    /(?<![\w:/])~~([^~\n]+)~~(?!\w|\/)$/,
    strikethroughSchema.type(ctx)
  )
);

/** 注册给 getEditorPlugins() 的插件集合 */
export const scriptPlugins: MilkdownPlugin[] = [
  ...gfmRemark,
  ...scriptRemark,
  superscriptSchema,
  subscriptSchema,
  superscriptInputRule,
  subscriptInputRule,
  strikethroughInputRule,
];
