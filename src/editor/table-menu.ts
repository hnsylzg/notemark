/*
 * table-menu.ts — 表格右键菜单
 *
 * 在表格单元格上右键时弹出菜单，可：
 *  - 在上方/下方插入行、在左侧/右侧插入列
 *  - 删除行、删除列、删除整个表格
 *  - 单元格对齐（左 / 中 / 右）
 *
 * 实现：通过 ProseMirror 插件的 handleDOMEvents.contextmenu 拦截右键，
 * 先把光标移入右键的单元格，再用 prosemirror-tables 的命令
 * （均基于当前光标所在行/列）直接 dispatch。
 */
import { $prose } from "@milkdown/utils";
import {
  Plugin,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
  setCellAttr,
} from "@milkdown/prose/tables";

type Cmd = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void
) => boolean;

let menuEl: HTMLDivElement | null = null;
let currentView: EditorView | null = null;
let cleanupFns: Array<() => void> = [];

function closeMenu() {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
  menuEl?.remove();
  menuEl = null;
  currentView = null;
}

function runCmd(cmd: Cmd) {
  if (!currentView) return;
  cmd(currentView.state, currentView.dispatch);
}

function showMenu(view: EditorView, x: number, y: number) {
  closeMenu();
  currentView = view;

  const menu = document.createElement("div");
  menu.className = "mt-table-menu";
  menu.style.left = "0px";
  menu.style.top = "0px";

  // 菜单必须挂在 .milkdown 容器内，否则取不到主题变量
  // （--mt-* 只在 .milkdown 根节点上声明），背景会变透明。
  const host = document.querySelector<HTMLElement>(".milkdown") ?? document.body;
  host.appendChild(menu);

  const items: Array<{ label?: string; sep?: boolean; run?: () => void }> = [
    { label: "在上方插入行", run: () => runCmd(addRowBefore) },
    { label: "在下方插入行", run: () => runCmd(addRowAfter) },
    { label: "在左侧插入列", run: () => runCmd(addColumnBefore) },
    { label: "在右侧插入列", run: () => runCmd(addColumnAfter) },
    { sep: true },
    { label: "删除行", run: () => runCmd(deleteRow) },
    { label: "删除列", run: () => runCmd(deleteColumn) },
    { label: "删除表格", run: () => runCmd(deleteTable) },
    { sep: true },
    { label: "左对齐", run: () => runCmd(setCellAttr("alignment", "left")) },
    { label: "居中对齐", run: () => runCmd(setCellAttr("alignment", "center")) },
    { label: "右对齐", run: () => runCmd(setCellAttr("alignment", "right")) },
  ];

  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement("div");
      sep.className = "mt-table-menu__sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "mt-table-menu__item";
    btn.type = "button";
    btn.textContent = it.label ?? "";
    btn.addEventListener("click", () => {
      it.run?.();
      closeMenu();
    });
    menu.appendChild(btn);
  }

  // 定位：贴边时收敛进视口
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - mw - 8))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - mh - 8))}px`;

  // 点击菜单本身不干扰编辑器光标
  menu.addEventListener("mousedown", (e) => e.preventDefault());

  // 点菜单外部 / 滚动 / Esc 关闭
  const onDown = (e: MouseEvent) => {
    if (!menuEl || !menuEl.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMenu();
  };
  const onScroll = () => closeMenu();

  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);

  cleanupFns = [
    () => document.removeEventListener("mousedown", onDown, true),
    () => document.removeEventListener("keydown", onKey, true),
    () => window.removeEventListener("scroll", onScroll, true),
    () => window.removeEventListener("resize", onScroll),
  ];

  menuEl = menu;
}

export const tableMenuPlugin = $prose(() =>
  new Plugin({
    props: {
      handleDOMEvents: {
        contextmenu(view, event) {
          const target = event.target as HTMLElement | null;
          const cell = target?.closest?.("td, th");
          if (!cell) return false; // 非表格区域，交给默认行为
          event.preventDefault();
          // 光标移入右键的单元格，让增删行/列作用于这一行/列
          const pos = view.posAtDOM(cell, 0);
          if (pos != null && pos >= 0) {
            view.dispatch(
              view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))
            );
          }
          showMenu(view, event.clientX, event.clientY);
          return true;
        },
      },
    },
  })
);
