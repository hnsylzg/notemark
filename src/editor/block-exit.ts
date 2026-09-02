/*
 * block-exit.ts — 「Ctrl/Cmd + Enter 退出到下一行」
 *
 * 背景：表格、代码块这类可编辑块自带「Ctrl+Enter 跳到块后新行」的快捷键，而
 * 斜杠命令插入的这几类块没有：
 *   - yaml（元数据）、toc（目录）、hr（分割线）
 *   - math_block（公式块）、diagram（流程图）、htmlBlock（HTML 块）
 * 它们都是原子块：要么完全不可编辑（toc / hr），要么内容由 NodeView 自管的
 * textarea 接管（元数据 / 公式 / 流程 / HTML）——后者的按键被 stopPropagation
 * 拦下，ProseMirror 的 keymap 根本收不到。所以原实现里 Ctrl+Enter 只做
 * 「保存并关闭编辑框」，光标留在原地，用户还得手动点下一行才能继续写。
 *
 * 本模块提供两半能力，合起来才覆盖两种状态：
 *   - exitToNextLine()：把光标移到块之后，供各 NodeView 在【编辑态】调用；
 *   - blockExitPlugin：接管【非编辑态】的 Ctrl+Enter，覆盖 toc / hr 这类
 *     没有编辑态的块，以及光标停在块前后（gapcursor）的情况。
 */
import { $prose } from "@milkdown/utils";
import {
  NodeSelection,
  Plugin,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/prose/state";
import { GapCursor } from "@milkdown/prose/gapcursor";
import type { EditorView } from "@milkdown/prose/view";

/** 支持 Ctrl+Enter 退出到下一行的块（对应斜杠菜单里的那几项） */
export const EXITABLE_BLOCKS = new Set([
  "yaml", // 元数据
  "toc", // 目录
  "hr", // 分割线
  "math_block", // 公式块
  "diagram", // 流程图
  "htmlBlock", // HTML 块
]);

/**
 * 在指定块之后新起一行，并把光标放进去（「退出到下一行」）。
 *
 * 空行是否出现由本函数（即 Ctrl+Enter）决定，插入块时【不】自动加——
 * 这正是用户要的「用快捷键控制在不在后面加空行」：不按就不留空行，
 * 按了才在块后补一个（源码里对应一行空行）。
 *
 * 唯一的复用：紧邻的下一个节点已经是【空】段落时直接进它，不再插一个，
 * 否则连按 Ctrl+Enter 会堆出一串空段落。
 */
export function exitToNextLine(
  view: EditorView,
  nodePos: number,
  nodeSize: number
): boolean {
  const { state } = view;
  const paraType = state.schema.nodes.paragraph;
  if (!paraType) return false;

  const after = nodePos + nodeSize;
  const next = state.doc.resolve(after).nodeAfter;
  const tr = state.tr;
  const reuseEmpty =
    next != null && next.type === paraType && next.content.size === 0;
  if (!reuseEmpty) {
    // 后面是内容 / 其他块 / 文末：新开一个空段落
    tr.insert(after, paraType.create());
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/**
 * 插入块之后把光标放到块【后面】（insertAtom / insertHtmlBlock 用）。
 *
 * ★ 不能直接 `Selection.near(resolve(blockEnd))`：它向后找不到可落脚的文本
 *   位置时会自动【向前】找，光标于是跳到上一个块的末尾——表现为"插入后光标
 *   跑到上面那个对象后面"。
 *
 * 这里只接受向后的结果；后方确实没位置（块在文末、或后面紧挨着另一个原子
 * 块）时退到块后的 gapcursor：光标确实停在块后面，又不产生多余空段落
 * （gapcursor 由 plugins.ts 里的 gapcursorPlugin 提供）。
 */
export function setSelectionAfterBlock(
  tr: Transaction,
  blockEnd: number
): void {
  const $end = tr.doc.resolve(blockEnd);
  const sel = Selection.near($end, 1);
  if (sel && sel.from >= blockEnd) {
    tr.setSelection(sel);
    return;
  }
  try {
    tr.setSelection(new GapCursor($end));
  } catch {
    // gapcursor 也放不下（极罕见）：退回 near 的结果，至少不留下无效选区
    if (sel) tr.setSelection(sel);
  }
}

/** 找出光标所在 / 紧邻的可退出块 */
function findExitTarget(
  state: EditorState
): { pos: number; size: number } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection) {
    const n = sel.node;
    if (EXITABLE_BLOCKS.has(n.type.name)) {
      return { pos: sel.from, size: n.nodeSize };
    }
  }

  const $from = sel.$from;
  // 光标落在块内部（math_block 带 content，光标可能进去）
  for (let d = $from.depth; d > 0; d -= 1) {
    const n = $from.node(d);
    if (EXITABLE_BLOCKS.has(n.type.name)) {
      return { pos: $from.before(d), size: n.nodeSize };
    }
  }
  // 光标紧邻块（gapcursor 让光标能停在原子块的前后）
  const before = $from.nodeBefore;
  if (before && EXITABLE_BLOCKS.has(before.type.name)) {
    return { pos: $from.pos - before.nodeSize, size: before.nodeSize };
  }
  const after = $from.nodeAfter;
  if (after && EXITABLE_BLOCKS.has(after.type.name)) {
    return { pos: $from.pos, size: after.nodeSize };
  }
  return null;
}

/**
 * 非编辑态的 Ctrl/Cmd + Enter：光标在可退出块上 / 旁边时，跳到块后的下一行。
 * 编辑态的按键被 NodeView 的 textarea 拦下，由各 NodeView 自己调用
 * exitToNextLine()；其余情况（表格 / 代码块等）一律返回 false，
 * 交回它们自带的快捷键处理。
 */
export const blockExitPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (event.key !== "Enter") return false;
          if (!event.ctrlKey && !event.metaKey) return false;
          const target = findExitTarget(view.state);
          if (!target) return false;
          return exitToNextLine(view, target.pos, target.size);
        },
      },
    })
);

/**
 * 代码块「鼠标点下方空白出来」：
 * 当文档最后一个块是 code_block、且鼠标点在其下方（页尾、没有后续内容）时，
 * 自动在代码块后补一个空段落并把光标放进去。否则点下方空白只会把光标落到
 * 代码块最后一行，无法在块后继续输入——原子块靠 gapcursor（横线）能点出来，
 * 代码块是普通可编辑块，没有这个待遇，这里单独补上。仅点在其 DOM 底边之下
 * 才生效，点代码块内部仍正常编辑。
 */
export const codeBlockExitClickPlugin = $prose(() =>
  new Plugin({
    props: {
      handleClick(view, _pos, event) {
        const { state } = view;
        const last = state.doc.lastChild;
        if (!last || last.type.name !== "code_block") return false;
        const paraType = state.schema.nodes.paragraph;
        if (!paraType) return false;

        // 找最后一个 code_block 的 DOM，判断是否点在它下方
        const lastPos = state.doc.content.size - last.nodeSize;
        const dom = view.nodeDOM(lastPos);
        if (!(dom instanceof HTMLElement)) return false;
        const rect = dom.getBoundingClientRect();
        if (event.clientY <= rect.bottom) return false; // 点在块内 / 边上，交回默认

        // 在文档末尾（code_block 之后）补一个空段落并进入
        const after = state.doc.content.size;
        const tr = state.tr.insert(after, paraType.create());
        tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return true;
      },
    },
  })
);
