/*
 * format-menu.ts — 编辑区右键格式菜单
 *
 * 背景：行内格式（加粗/斜体/删除线/行内代码/高亮）从斜杠命令移到了本菜单——
 * 选中要改的文字点右键即可转换，不再需要行首 "/"；上标/下标/下划线没有斜杠
 * 入口，也在这里；图片、链接是插入操作，与 "/" 里的入口并存。
 * 行内公式、脚注只在【本菜单】：它们要插在正文光标处，而斜杠菜单只在段落
 * 开头触发（见 slash-menu.ts），写到一半想插时弹不出来，故不放斜杠入口。
 *
 * 交互（与 / 命令行为一致）：
 * - 有选中文字（且右键落在选区上）→ 菜单项对选区做格式 toggle；
 *   链接 = 给选中的文字加链接（只输地址，不替换文字）。
 * - 没有选中文字 → 点格式项把光标移到右键处并「开启输入」，后续输入的字
 *   自动带该格式，按 Esc 退出；点「链接」则与 /链接 完全一致：先补上占位
 *   文字「链接文本」再弹地址框（占位处于选中状态，直接打字即可替换）——
 *   空光标处没有文字，link 这个 mark 无处可挂，不补占位就建不出链接。
 *
 * 实现：用 ProseMirror 插件的 handleDOMEvents.contextmenu 拦截编辑器右键。
 * 格式 toggle 与「持续输入状态机」都复用 slash-menu 的 applyFormatMark——
 * 菜单本身只是启动器，逐字符补 mark、Esc 退出仍由 slash-menu 的插件托管，
 * 保证两边行为完全一致。菜单 UI 复用斜杠菜单的 DOM 结构与样式类。
 *
 * 协调：
 * - 表格单元格内右键默认交给表格菜单；仅当右键落在已有文字选区上时，
 *   格式菜单优先（给单元格里选中的文字套格式）。
 * - 图片、代码块、frontmatter/html 编辑块等区域不接管，保留各自右键行为。
 */
import { $prose } from "@milkdown/utils";
import { Plugin, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import {
  applyFormatMark,
  openImagePicker,
  promptLinkUrlDialog,
} from "./slash-menu";
import { insertFootnote } from "./footnote";
import { insertInlineMath } from "./math-view";

/** 这些宿主区域有自己的右键行为（图片、代码块、textarea 编辑块等），不接管 */
function isForeignTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (target.closest("img")) return true;
  if (target.closest(".cm-content, .cm-editor")) return true; // 代码块（CodeMirror）
  if (target.closest(".mt-frontmatter, .mt-html-block")) return true;
  if (target.closest(".diagram, .katex, .katex-display, .md-iframe-wrap")) return true;
  return false;
}

interface Def {
  kind: "mark" | "link" | "image";
  markName?: string;
  label: string;
  icon?: string;
  hint?: string;
}

/** markName 为 PM schema marks 名；hint 显示在菜单右侧帮助记忆语法 */
const DEFS: Def[] = [
  { kind: "mark", markName: "strong", label: "加粗", icon: "B", hint: "**" },
  { kind: "mark", markName: "emphasis", label: "斜体", icon: "I", hint: "*" },
  { kind: "mark", markName: "strike_through", label: "删除线", icon: "S", hint: "~~" },
  { kind: "mark", markName: "inlineCode", label: "行内代码", icon: "`", hint: "`" },
  { kind: "mark", markName: "highlight", label: "高亮", icon: "▬", hint: "==" },
  { kind: "mark", markName: "underline", label: "下划线", icon: "U", hint: "<u>" },
  { kind: "mark", markName: "superscript", label: "上标", icon: "A²", hint: "^x^" },
  { kind: "mark", markName: "subscript", label: "下标", icon: "A₂", hint: "~x~" },
];

let menuEl: HTMLDivElement | null = null;
let cleanupFns: Array<() => void> = [];
let activeView: EditorView | null = null;
/** 右键命中（posAtCoords）的文档位置 */
let hitPos = -1;

function closeMenu(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
  menuEl?.remove();
  menuEl = null;
  activeView = null;
  hitPos = -1;
}

/** 把光标移到 pos（右键处），用于「无选区时从此处开启输入」 */
function placeCaretAt(view: EditorView, pos: number): void {
  const max = view.state.doc.content.size;
  const safe = Math.max(0, Math.min(pos, max));
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, safe, safe))
  );
}

/** 右键是否落在当前文字选区上（决定「转换选区」还是「光标处开启输入」） */
function hitOnSelection(view: EditorView, pos: number): boolean {
  const sel = view.state.selection;
  return !sel.empty && pos >= sel.from && pos <= sel.to;
}

function runMarkItem(view: EditorView, pos: number, def: Def): void {
  // 必须先聚焦：右键时编辑器往往还没焦点，若先 dispatch(placeCaretAt) 再 focus，
  // 浏览器会在之后异步派发 selectionchange，PM 据此做"选区同步事务"把
  // applyFormatMark 设好的 storedMarks 清掉 —— 导致无选区点右键后打字不带格式。
  // 先 focus 让后续 dispatch 能同步刷新 DOM 选区，就不会再有那次清空。
  view.focus();
  if (!hitOnSelection(view, pos)) placeCaretAt(view, pos);
  applyFormatMark(view, def.markName as string, def.label);
}

function runImageItem(view: EditorView, pos: number): void {
  if (!hitOnSelection(view, pos)) placeCaretAt(view, pos);
  // 与 /图片 一致：宿主(App.vue)打开文件选择，插图到当前光标处。
  // 用 selection.to（选区【末尾】）而不是 from：选中一段文字时图片追加在后面，
  // 与脚注 / 行内公式保持一致，不把图片挤到选中文字前面去。
  openImagePicker(view, view.state.selection.to);
}

function runLinkItem(view: EditorView, pos: number): void {
  if (!hitOnSelection(view, pos)) placeCaretAt(view, pos);
  const sel = view.state.selection;
  if (!sel.empty) {
    const $f = view.state.doc.resolve(sel.from);
    const $t = view.state.doc.resolve(sel.to);
    if ($f.parent === $t.parent) {
      // 选中文字在同段内：给这段文字加链接（只输地址，不替换文字）
      promptLinkForSelection(view, sel.from, sel.to);
      return;
    }
    // 跨段选区：退化为普通插入
  }
  // 无选区：与 /链接 一致，插入占位链接文本并弹地址输入框
  promptLinkUrlDialog(view, "链接文本");
}

function runDef(def: Def): void {
  const view = activeView;
  const pos = hitPos;
  closeMenu();
  if (!view || pos < 0) return;
  if (def.kind === "mark") {
    runMarkItem(view, pos, def);
  } else if (def.kind === "image") {
    runImageItem(view, pos);
  } else {
    runLinkItem(view, pos);
  }
}

/**
 * 脚注：在右键处（选中文字时在其末尾）插入上标引用，同时在文末建一条定义，
 * 并把光标送进定义里直接输入内容。
 *
 * 与格式项一样，右键没落在选区上就先把光标挪过去；落在选区上则【保留选区】，
 * 由 insertFootnote 把引用插到选区末尾（选中文字不会被吞掉）。
 */
function runFootnote(): void {
  const view = activeView;
  const pos = hitPos;
  closeMenu();
  if (!view || pos < 0) return;
  if (!hitOnSelection(view, pos)) placeCaretAt(view, pos);
  insertFootnote(view);
}

/**
 * 行内公式：在右键处（选中文字时在其末尾）插入一个空 math_inline 并进入编辑。
 *
 * 从斜杠菜单挪过来的原因同脚注：它是【行内】节点，要落在正文光标处，
 * 而斜杠菜单只在段落开头触发（见 slash-menu.ts 的 parentOffset === 0），
 * 一句话写到一半想插公式时根本弹不出来。
 */
function runInlineMath(): void {
  const view = activeView;
  const pos = hitPos;
  closeMenu();
  if (!view || pos < 0) return;
  if (!hitOnSelection(view, pos)) placeCaretAt(view, pos);
  insertInlineMath(view);
}

/** 给选中文字加链接（与 /链接 的"插入占位"不同：保留并转换已有文字） */
function promptLinkForSelection(view: EditorView, from: number, to: number): void {
  const linkType = view.state.schema.marks["link"];
  if (!linkType) return;
  const host = document.querySelector<HTMLElement>(".milkdown") ?? document.body;
  const box = document.createElement("div");
  box.className = "mt-slash-linkbox";
  host.appendChild(box);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "mt-slash-linkbox__input";
  input.value = "https://";
  input.setAttribute("spellcheck", "false");
  box.appendChild(input);

  const tip = document.createElement("span");
  tip.className = "mt-slash-linkbox__tip";
  tip.textContent = "为选中文字加链接 · Enter 确认 · Esc 取消";
  box.appendChild(tip);

  // 定位到选区起点下方（与 /链接 的浮层一致；浮层期间文档不应变动）
  try {
    const coords = view.coordsAtPos(from);
    const maxLeft = Math.max(8, window.innerWidth - box.offsetWidth - 8);
    box.style.left = `${Math.max(8, Math.min(coords.left, maxLeft))}px`;
    box.style.top = `${coords.bottom + 6}px`;
  } catch {
    /* 位置失效时保持默认角落 */
  }

  const close = (): void => {
    box.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("scroll", onScroll, true);
  };
  const onDown = (e: MouseEvent): void => {
    if (!box.contains(e.target as Node)) {
      e.stopPropagation();
      close();
      view.focus();
    }
  };
  const onScroll = (): void => close();
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const href = input.value.trim();
      close();
      if (href) {
        const tr = view.state.tr
          .addMark(from, to, linkType.create({ href }))
          .scrollIntoView();
        view.dispatch(tr);
      }
      view.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      view.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);
  window.addEventListener("scroll", onScroll, true);

  input.focus();
  input.select();
}

/** 在右键坐标处弹出菜单 */
function openMenu(view: EditorView, clientX: number, clientY: number, pos: number): void {
  closeMenu();
  activeView = view;
  hitPos = pos;

  const host = document.querySelector<HTMLElement>(".milkdown") ?? document.body;
  const menu = document.createElement("div");
  menu.className = "mt-slash-menu";
  menu.style.maxHeight = `${Math.max(200, window.innerHeight - 48)}px`;
  host.appendChild(menu);

  const addItem = (icon: string, label: string, hint?: string): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mt-slash-menu__item";
    const iconSpan = document.createElement("span");
    iconSpan.className = "mt-slash-menu__icon";
    iconSpan.textContent = icon;
    const textSpan = document.createElement("span");
    textSpan.className = "mt-slash-menu__text";
    textSpan.textContent = label;
    btn.appendChild(iconSpan);
    btn.appendChild(textSpan);
    if (hint) {
      const hintSpan = document.createElement("span");
      hintSpan.className = "mt-slash-menu__hint";
      hintSpan.textContent = hint;
      btn.appendChild(hintSpan);
    }
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    menu.appendChild(btn);
    return btn;
  };

  const addSep = (): void => {
    const sep = document.createElement("div");
    sep.style.cssText =
      "height:1px;margin:4px 10px;background:var(--mt-color-border, rgba(128,128,128,.35))";
    menu.appendChild(sep);
  };

  /**
   * 分组标题（复用斜杠菜单的样式类）。
   *
   * 菜单项已经排到 12 个，只靠一条分隔线看不出上下两组的区别：
   * 上面一组是「改已有文字」，下面一组是「往文档里加东西」——
   * 这两类操作对选区的处理完全不同（套格式 vs 追加），点名才不容易点错。
   */
  const addGroupTitle = (text: string): void => {
    const title = document.createElement("div");
    title.className = "mt-slash-menu__group-title";
    title.textContent = text;
    menu.appendChild(title);
  };

  addGroupTitle("格式");
  DEFS.forEach((def) => {
    const btn = addItem(def.icon ?? "", def.label, def.hint);
    btn.addEventListener("click", () => runDef(def));
  });
  addSep();
  addGroupTitle("插入");
  const linkBtn = addItem("⛓", "链接", "[]()");
  linkBtn.addEventListener("click", () => runDef({ kind: "link", label: "链接" }));
  const imageBtn = addItem("❒", "图片");
  imageBtn.addEventListener("click", () => runDef({ kind: "image", label: "图片" }));
  const mathBtn = addItem("∑", "行内公式", "$");
  mathBtn.addEventListener("click", () => runInlineMath());
  // 脚注移到插入组最后
  const footnoteBtn = addItem("¹", "脚注", "[^1]");
  footnoteBtn.addEventListener("click", () => runFootnote());

  // 先挂到文档上量尺寸，再定位（尽量不超出视口，菜单打开前鼠标已移开 -> 不偏移）
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = Math.max(4, Math.min(clientX, window.innerWidth - mw - 4));
  const top = Math.max(4, Math.min(clientY, window.innerHeight - mh - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onDown = (e: MouseEvent): void => {
    if (menu && !menu.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }
  };
  const onScroll = (): void => closeMenu();
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

export const formatMenuPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          contextmenu(view, event) {
            const target = event.target as HTMLElement | null;
            // 命中位置；posAtCoords 与 clientX/Y 同属窗口坐标
            const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!hit) return false;
            const onSelection = hitOnSelection(view, hit.pos);
            // 表格单元格内：默认交给表格右键菜单；右键落在已有文字选区上时
            // 格式菜单优先（给选中的单元格文字套格式）
            if (target?.closest?.("td, th") && !onSelection) return false;
            // 图片/代码块/编辑块等区域不接管
            if (isForeignTarget(target)) return false;
            event.preventDefault();
            openMenu(view, event.clientX, event.clientY, hit.pos);
            return true;
          },
        },
      },
    })
);
