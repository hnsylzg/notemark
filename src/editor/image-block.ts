/*
 * image-block.ts — 标记「独占一个段落的图片」
 *
 * 目的：让主题能区分两种图片并分别排版
 *   - 单独成行的图片（插图）   → 水平居中
 *   - 与文字同排的图片（行内） → 保持行内、与文字垂直居中
 *
 * 本模块只打标记，不写任何样式 —— 是否居中、居中成什么样由主题决定。
 * 没有这个标记，主题只能「一刀切」：CSS 选择器看不到文本节点，
 * 区分不了「只有图片」和「文字 + 图片」；且 ProseMirror 会往段落里插入
 * <img class="ProseMirror-separator"> 与 <br class="ProseMirror-trailingBreak">
 * 两个辅助元素，导致 :only-child / :only-of-type 全部失效（实测段落内
 * img 数量至少是 2）。
 *
 * 为什么用 Decoration 而不是 NodeView：
 * NodeView 的 update 只在该节点自身变化时触发 —— 在图片前面打几个字
 * （父节点结构变了，但图片本身没变）不会刷新标记；
 * Decoration 则随每次文档变化由 decorations(state) 重算，标记始终与文档一致。
 */
import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";

/** 打在「独占段落的图片」上的标记 class（主题据此写样式） */
export const IMAGE_BLOCK_CLASS = "mt-image-block";

export const imageBlockPlugin = $prose(
  () =>
    new Plugin({
      props: {
        decorations(state) {
          const decos: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "image") return true;
            // pos 是图片节点前的位置，resolve 后 parent 即所在的文本块（段落/标题）
            const parent = state.doc.resolve(pos).parent;
            const alone =
              parent.childCount === 1 && parent.firstChild?.type.name === "image";
            if (alone) {
              decos.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  class: IMAGE_BLOCK_CLASS,
                })
              );
            }
            return false; // image 是叶子节点，无需下钻
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })
);
