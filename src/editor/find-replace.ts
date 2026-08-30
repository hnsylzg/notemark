/*
 * find-replace.ts — 查找 / 替换
 *
 * 组成：
 * - searchText()：纯文本搜索（WYSIWYG 与源码模式共用）。查询词按字面量转义，
 *   「全字匹配」用 Unicode 前后瞻实现，中英文混排同样有效。
 * - findReplacePlugin：ProseMirror 插件，负责在文档中收集匹配并高亮
 *   （Decoration.inline），同时维护「当前匹配」下标。
 * - 一组命令函数（openFind / setFindQuery / stepMatch / replaceCurrent …）：
 *   统一通过「事务 meta」驱动插件状态，外部不直接读写插件内部状态。
 *
 * 设计要点：
 * - 匹配只在单个文本节点内部进行。ProseMirror 的 inline Decoration 不能跨节点，
 *   而跨 mark 的连续文本（如 "hel" + "lo"）本就是两个文本节点，
 *   这类跨节点匹配无法命中 —— 与多数基于 PM 的编辑器一致，属已知限制。
 * - 文档被编辑时（docChanged）自动重算匹配，保证高亮位置始终有效；
 *   未激活时完全不参与计算，零开销。
 * - 替换走 ProseMirror 事务，因此可撤销（Ctrl+Z）；「全部替换」是单个事务，
 *   一次撤销即可全部回退。
 * - 替换后用于定位的选区调整事务带 addToHistory:false，不会额外产生撤销步骤。
 *
 * 已知限制：
 * - 代码块内容由 CodeMirror 6 渲染，其中的匹配可正常跳转，但高亮可能被
 *   CodeMirror 的重绘覆盖（查找/替换功能本身不受影响）。
 * - 数学公式 / Mermaid 图表等原子节点内部的文本不参与搜索。
 */
import { $prose } from "@milkdown/utils";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/prose/state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { Editor } from "@milkdown/kit/core";
// editorViewCtx 在运行时由 @milkdown/kit/core 导出（d.ts 遗漏声明），同 index.ts。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore editorViewCtx 运行时可用（d.ts 未声明）
import { editorViewCtx } from "@milkdown/kit/core";

/** 一处匹配（绝对位置，恒有 from < to） */
export interface FindMatch {
  from: number;
  to: number;
}

/** 查找选项 */
export interface FindOptions {
  /** 区分大小写 */
  caseSensitive: boolean;
  /** 全字匹配（匹配项两侧不能紧邻字母/数字/下划线） */
  wholeWord: boolean;
}

/** 查找插件的完整状态 */
export interface FindState extends FindOptions {
  /** 查找面板是否开启（关闭时不做任何计算） */
  active: boolean;
  /** 当前查询词 */
  query: string;
  /** 全部匹配，按文档顺序 */
  matches: FindMatch[];
  /** 当前匹配下标；-1 表示无匹配 */
  index: number;
}

/** 关闭态（唯一的初始状态，避免每次 close 都新建对象） */
const CLOSED: FindState = {
  active: false,
  query: "",
  caseSensitive: false,
  wholeWord: false,
  matches: [],
  index: -1,
};

/** 插件状态迁移指令 */
type FindMeta =
  | { type: "open"; query: string; options: FindOptions }
  | { type: "close" }
  | { type: "query"; query: string }
  | { type: "options"; options: FindOptions }
  /** 仅移动下标（文档未变，无需重算） */
  | { type: "go"; index: number }
  /** 替换了下标 index 处的匹配，需重算并保持下标记住「下一个」 */
  | { type: "replaced"; index: number }
  /** 全部替换 */
  | { type: "replacedAll" };

/** 查找插件的 PluginKey（命令函数与插件通过它通信） */
export const findReplaceKey = new PluginKey<FindState>("mtFindReplace");

/* ============ 文本搜索（纯函数，两种模式共用） ============ */

/**
 * 在一段文本中查找全部匹配。
 * @param text 被搜索的文本
 * @param query 查询词（按字面量处理，正则元字符会被转义）
 */
export function searchText(
  text: string,
  query: string,
  options: FindOptions
): FindMatch[] {
  if (!query) return [];
  const re = buildRegExp(query, options);
  if (!re) return [];
  const out: FindMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // 极端情况下（如查询词被全部转义为空）正则可能匹配零长度，手动推进避免死循环
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    out.push({ from: m.index, to: m.index + m[0].length });
  }
  return out;
}

/**
 * 构造搜索正则。
 * - 转义元字符：用户输入的 . * ( ) [ ] 等一律按字面量匹配；
 * - 全字匹配：用 Unicode 属性前后瞻 \p{L}（含中文）/ \p{N} / _ 判定词边界，
 *   需要 u 标志，WebView2 / WebKit 均支持。
 */
function buildRegExp(query: string, options: FindOptions): RegExp | null {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return null;
  const body = options.wholeWord
    ? `(?<![\\p{L}\\p{N}_])(?:${escaped})(?![\\p{L}\\p{N}_])`
    : escaped;
  return new RegExp(body, options.caseSensitive ? "gu" : "giu");
}

/** 在整个文档中收集匹配（按文档顺序） */
function findMatches(
  doc: PMNode,
  query: string,
  options: FindOptions
): FindMatch[] {
  if (!query) return [];
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    // 非文本节点继续下钻；文本节点收集完后不再进入（它没有子节点）
    if (!node.isText) return true;
    for (const hit of searchText(node.text ?? "", query, options)) {
      out.push({ from: pos + hit.from, to: pos + hit.to });
    }
    return false;
  });
  return out;
}

/**
 * 基于新文档重算匹配。
 * @param anchor 给定的锚点位置；优先选中其后的第一个匹配（默认取第一个）
 * @param forcedIndex 指定下标（替换后保持位置用），优先级高于 anchor
 */
function withMatches(
  state: FindState,
  doc: PMNode,
  anchor?: number,
  forcedIndex?: number
): FindState {
  const matches = findMatches(doc, state.query, state);
  if (matches.length === 0) return { ...state, matches: [], index: -1 };
  let index = forcedIndex ?? 0;
  if (forcedIndex == null && anchor != null) {
    const found = matches.findIndex((m) => m.from >= anchor);
    if (found > 0) index = found;
  }
  return {
    ...state,
    matches,
    index: Math.min(Math.max(index, 0), matches.length - 1),
  };
}

/* ============ 插件 ============ */

export const findReplacePlugin = $prose(
  () =>
    new Plugin<FindState>({
      key: findReplaceKey,
      state: {
        init: () => CLOSED,
        apply(tr: Transaction, prev: FindState, _old: EditorState, next: EditorState) {
          const meta = tr.getMeta(findReplaceKey) as FindMeta | undefined;
          if (meta) {
            switch (meta.type) {
              case "open":
                return withMatches(
                  { ...CLOSED, ...meta.options, active: true, query: meta.query },
                  next.doc,
                  next.selection.head
                );
              case "close":
                return CLOSED;
              case "query":
                return withMatches(
                  { ...prev, query: meta.query },
                  next.doc,
                  next.selection.head
                );
              case "options":
                return withMatches(
                  { ...prev, ...meta.options },
                  next.doc,
                  next.selection.head
                );
              case "go":
                return { ...prev, index: meta.index };
              case "replaced":
                // 下标保持不变：原来的第 n 个已被替换掉，
                // 重算后同一个下标正好指向「下一个」匹配
                return withMatches(prev, next.doc, undefined, meta.index);
              case "replacedAll":
                return withMatches(prev, next.doc);
            }
          }
          // 编辑导致文档变化：激活时重算，保证高亮位置有效
          if (prev.active && tr.docChanged) return withMatches(prev, next.doc);
          return prev;
        },
      },
      props: {
        decorations(state) {
          const st = findReplaceKey.getState(state);
          if (!st?.active || st.matches.length === 0) return null;
          try {
            return DecorationSet.create(
              state.doc,
              st.matches.map((m, i) =>
                Decoration.inline(m.from, m.to, {
                  class:
                    i === st.index
                      ? "mt-find-match mt-find-match--current"
                      : "mt-find-match",
                })
              )
            );
          } catch (err) {
            // 高亮只是视觉增强，任何位置异常都不能影响编辑
            // （例如匹配落在自定义 NodeView 管理的 DOM 中）
            console.warn("[NoteMark] build find decorations failed:", err);
            return null;
          }
        },
      },
    })
);

/* ============ 命令 ============ */

/** 派发一条只带 meta 的事务，返回生效后的状态 */
function dispatchMeta(
  view: EditorView,
  meta: FindMeta
): FindState | undefined {
  view.dispatch(view.state.tr.setMeta(findReplaceKey, meta));
  return findReplaceKey.getState(view.state);
}

/**
 * 把匹配滚动到编辑区中部。
 * 不用 tr.scrollIntoView()：它只做「最小滚动」，匹配常贴在视口边缘；
 * 这里按视口坐标换算成滚动容器的 scrollTop，统一居中。
 */
function revealMatch(view: EditorView, from: number): void {
  const scroller = view.dom.closest<HTMLElement>(".milkdown");
  if (!scroller) return;
  let top: number;
  try {
    top = view.coordsAtPos(from).top;
  } catch {
    return; // 位置已失效（文档刚被替换），忽略即可
  }
  const delta = top - scroller.getBoundingClientRect().top;
  const target = scroller.scrollTop + delta - scroller.clientHeight / 2;
  scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

/** 滚动到当前匹配（无匹配时静默返回） */
function revealCurrent(view: EditorView, st?: FindState): void {
  if (!st?.matches.length || st.index < 0) return;
  revealMatch(view, st.matches[Math.min(st.index, st.matches.length - 1)].from);
}

/** 读取当前查找状态（插件未挂载时返回 undefined） */
export function getFindState(editor: Editor): FindState | undefined {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    return findReplaceKey.getState(view.state);
  });
}

/** 打开查找面板：立即高亮全部匹配，并把光标之后的第一个匹配滚动到可见区域 */
export function openFind(
  editor: Editor,
  query: string,
  options: FindOptions
): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    revealCurrent(view, dispatchMeta(view, { type: "open", query, options }));
  });
}

/** 关闭查找面板：清除全部高亮 */
export function closeFind(editor: Editor): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!findReplaceKey.getState(view.state)?.active) return; // 未激活不必派发事务
    view.dispatch(view.state.tr.setMeta(findReplaceKey, { type: "close" }));
  });
}

/** 更新查询词（同时重算匹配并把当前匹配滚到可见区域） */
export function setFindQuery(editor: Editor, query: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    revealCurrent(view, dispatchMeta(view, { type: "query", query }));
  });
}

/** 更新查找选项（区分大小写 / 全字匹配） */
export function setFindOptions(editor: Editor, options: FindOptions): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    revealCurrent(view, dispatchMeta(view, { type: "options", options }));
  });
}

/**
 * 按步长移动当前匹配（+1 下一个 / -1 上一个，到头自动环绕）。
 * 会同时把选区移到该匹配上 —— 关闭查找面板后光标就停在最后查找的位置，
 * 可直接继续编辑。
 */
export function stepMatch(editor: Editor, delta: number): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const st = findReplaceKey.getState(view.state);
    if (!st?.active || st.matches.length === 0) return;
    const len = st.matches.length;
    // 尚无当前匹配时：正向从第一个开始，反向从最后一个开始
    const base = st.index < 0 ? (delta > 0 ? -1 : 0) : st.index;
    const index = (base + delta + len) % len;
    const m = st.matches[index];
    view.dispatch(
      view.state.tr
        .setMeta(findReplaceKey, { type: "go", index })
        .setSelection(TextSelection.create(view.state.doc, m.from, m.to))
    );
    revealMatch(view, m.from);
  });
}

/**
 * 替换当前匹配，并把当前匹配推进到下一个。
 * @param replacement 替换文本（空串表示删除）
 */
export function replaceCurrent(editor: Editor, replacement: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const st = findReplaceKey.getState(view.state);
    if (!st?.active || st.index < 0 || st.matches.length === 0) return;
    const m = st.matches[Math.min(st.index, st.matches.length - 1)];
    const tr = view.state.tr;
    // schema.text("") 会抛错（空文本节点不允许），删除必须走 delete
    if (replacement) {
      tr.replaceWith(m.from, m.to, view.state.schema.text(replacement));
    } else {
      tr.delete(m.from, m.to);
    }
    tr.setMeta(findReplaceKey, { type: "replaced", index: st.index });
    view.dispatch(tr);
    focusCurrentAfterReplace(view);
  });
}

/**
 * 替换全部匹配（单个事务，一次 Ctrl+Z 即可整体回退）。
 * @param replacement 替换文本（空串表示删除）
 */
export function replaceAllMatches(editor: Editor, replacement: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const st = findReplaceKey.getState(view.state);
    if (!st?.active || st.matches.length === 0) return;
    const tr = view.state.tr;
    // 必须从后往前替换：靠后的位置变化不会影响靠前匹配的下标
    for (let i = st.matches.length - 1; i >= 0; i -= 1) {
      const m = st.matches[i];
      if (replacement) {
        tr.replaceWith(m.from, m.to, view.state.schema.text(replacement));
      } else {
        tr.delete(m.from, m.to);
      }
    }
    tr.setMeta(findReplaceKey, { type: "replacedAll" });
    view.dispatch(tr);
    focusCurrentAfterReplace(view);
  });
}

/**
 * 替换后把选区移到新的当前匹配。
 * 单独一个事务 + addToHistory:false：既不污染撤销栈，
 * 也避免与替换事务合并成一次「替换 + 移动光标」的复合撤销。
 */
function focusCurrentAfterReplace(view: EditorView): void {
  const st = findReplaceKey.getState(view.state);
  if (!st?.matches.length || st.index < 0) return;
  const m = st.matches[Math.min(st.index, st.matches.length - 1)];
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, m.from, m.to))
      .setMeta("addToHistory", false)
  );
  revealMatch(view, m.from);
}
