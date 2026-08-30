/*
 * atom-block-delete.ts — 让不可选的原子块能用退格 / Delete 删掉
 *
 * 问题：yaml（元数据）/ htmlBlock（块级 HTML）/ toc（目录）这类节点都声明了
 * atom + selectable:false。selectable:false 是刻意的（节点内部是 textarea 或只读
 * 渲染，交给 ProseMirror 选中会和 NodeView 的事件拦截打架），代价是标准退格链
 * 三步全部落空，光标停在块前后按退格毫无反应：
 *   - deleteSelection：空选区，无效；
 *   - joinBackward：atom 没有可合并的内容（toc 还带 isolating:true），失败；
 *   - selectNodeBackward：要求节点 selectable，直接跳过。
 *
 * 解决：接管 Backspace / Delete —— 光标紧邻这类块且为空选区时直接删掉整块。
 * 只认"块级 atom 且不可选"的节点，其余一律返回 false 交回默认行为。
 */
import { $prose } from "@milkdown/utils";
import {
  NodeSelection,
  Plugin,
  type Command,
} from "@milkdown/prose/state";
import type { Node as PMNode } from "@milkdown/prose/model";

/**
 * 是不是"标准退格链删不掉"的块级原子节点。
 *
 * 按特征判断而不是写死节点名，以后新增同类节点自动纳入，不用回来改名单。
 */
function isUnselectableAtomBlock(node: PMNode): boolean {
  return node.isAtom && node.isBlock && !NodeSelection.isSelectable(node);
}

/**
 * 删除光标紧邻的不可选原子块：
 * - backward（Backspace）：光标位于当前块开头，且前一个兄弟是目标块；
 * - forward（Delete）：光标位于当前块末尾，且后一个兄弟是目标块。
 *
 * ★ 层级要点（这里最容易写错）：
 *   $from.parent 是光标所在的【那个块本身】（比如 paragraph），兄弟节点在【上一层】，
 *   必须去 $from.node(depth - 1) 里取、用 $from.index(depth - 1) 取索引。
 *   直接在 $from.parent 里找只能拿到文本节点，永远匹配不到目标块。
 */
function deleteAdjacentAtomBlock(dir: "backward" | "forward"): Command {
  return (state, dispatch) => {
    const { empty, $from } = state.selection;
    if (!empty) return false;
    // depth 为 0 时光标直接落在 doc 上，没有"所在块"可参照
    if ($from.depth === 0) return false;

    const d = $from.depth;
    const container = $from.node(d - 1); // 兄弟节点所在的容器
    const idx = $from.index(d - 1); // 当前块在容器中的索引
    let target: PMNode | null = null;
    let start = -1;

    if (dir === "backward") {
      // 光标必须停在当前块的开头，且前面确实有兄弟
      if ($from.parentOffset !== 0 || idx === 0) return false;
      target = container.child(idx - 1);
      // 前一个兄弟紧贴当前块：它的结束位置就是当前块的起始位置
      start = $from.before(d) - target.nodeSize;
    } else {
      if ($from.parentOffset !== $from.parent.content.size) return false;
      if (idx >= container.childCount - 1) return false;
      target = container.child(idx + 1);
      start = $from.after(d); // 当前块之后即下一个兄弟的起点
    }

    if (!target || !isUnselectableAtomBlock(target)) return false;
    if (start < 0) return false;

    if (dispatch) {
      dispatch(state.tr.delete(start, start + target.nodeSize).scrollIntoView());
    }
    return true;
  };
}

export const atomBlockDeletePlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (event.key !== "Backspace" && event.key !== "Delete") return false;
          const dir = event.key === "Backspace" ? "backward" : "forward";
          return deleteAdjacentAtomBlock(dir)(view.state, view.dispatch);
        },
      },
    })
);
