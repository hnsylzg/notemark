/*
 * inline-mark-escape.ts — 按 Esc 跳出光标所在的行内格式
 *
 * 问题：
 * 加粗 / 斜体 / 高亮这类 mark 是「包含型」的（inclusive: true），
 * 光标停在格式内容末尾时，ProseMirror 认为光标仍在格式区域内，
 * 后续输入会一直继承该 mark —— 表现为"加了粗就关不掉"。
 * 标准做法是按一次 Ctrl+B 再关一次，但很多人不知道，Esc 才是更直觉的出口。
 *
 * 解决：
 * 按 Esc 时记下光标当前的 marks，下一次输入强制插入【不带任何 mark】的
 * 字符，打断这次继承；此后光标位于无 mark 的字符之后，自然恢复普通文字。
 *
 * 注意：
 * - 只有 Esc 参与，Ctrl / Shift / Alt 等修饰键一律不处理——切换输入法时
 *   会发出这些键，若参与判定会导致"切个输入法格式就没了"。
 * - 中文输入法上屏不走 handleTextInput（走 DOM 观察），需要在
 *   compositionend 后把继承来的 mark 反向移除。
 */
import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { MarkType } from "@milkdown/prose/model";

/** 最近一次 Esc 要跳出的 mark 类型 */
let escapedMarks: MarkType[] = [];
/** 下一次输入需要"吃掉"继承 mark 的标志 */
let skipOnce = false;

/** 输入法合成开始位置（合成结束后据此移除继承来的 mark） */
let compositionStart = -1;
/** 当前编辑器视图（供 composition 事件回调使用） */
let activeView: EditorView | null = null;

export const inlineMarkEscapePlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          // 只认 Esc：修饰键（切输入法用）与 Backspace/Delete 都不参与
          if (event.key !== "Escape") return false;
          const marks = view.state.selection.$from.marks();
          if (marks.length === 0) return false; // 本来就没格式，交给其他逻辑
          escapedMarks = marks.map((m) => m.type);
          skipOnce = true;
          return true;
        },
        handleTextInput(view, from, to, text) {
          if (!skipOnce || text.length !== 1) return false;
          skipOnce = false;
          escapedMarks = [];
          // 插入一个不带任何 mark 的字符：打断 mark 的自动继承
          const tr = view.state.tr.replaceWith(
            from,
            to,
            view.state.schema.text(text)
          );
          view.dispatch(tr.scrollIntoView());
          return true;
        },
      },
      view(view) {
        activeView = view;
        return {
          destroy() {
            activeView = null;
          },
        };
      },
    })
);

if (typeof window !== "undefined") {
  window.addEventListener("compositionstart", () => {
    if (activeView) compositionStart = activeView.state.selection.from;
  });
  window.addEventListener("compositionend", () => {
    const view = activeView;
    if (!view || compositionStart < 0) return;
    const start = compositionStart;
    compositionStart = -1;
    if (!skipOnce) return;
    skipOnce = false;
    const types = escapedMarks;
    escapedMarks = [];
    // 上屏是异步的，等一帧再处理
    setTimeout(() => {
      try {
        const end = view.state.selection.from;
        if (end <= start) return;
        let tr = view.state.tr;
        for (const t of types) tr = tr.removeMark(start, end, t);
        view.dispatch(tr);
      } catch {
        /* 视图已销毁，忽略 */
      }
    }, 0);
  });
}
