/*
 * footnote.ts — 脚注（GFM footnote）的「添加」与「跳转」
 *
 * 前提：preset-gfm 已内置脚注的两个节点（见 plugins.ts 里注册的 gfmPlugins）：
 *   - footnote_reference：行内原子节点 → <sup data-type="footnote_reference">label</sup>
 *   - footnote_definition：块节点     → <dl data-type="footnote_definition"><dt>label</dt><dd>…</dd></dl>
 * 即「解析 Markdown → 渲染 DOM → 序列化回 [^label] / [^label]: 内容」这条链路
 * 已经打通（打开带脚注的文件能正常显示、保存也不丢）。
 *
 * 本模块只补两件预设没做的事：
 *   1. 添加：光标处插引用 + 文末建定义，并把光标送进定义里，可直接打字；
 *   2. 跳转：点正文上标 → 跳到文末对应定义；点定义编号 → 跳回正文首个引用。
 *
 * label 就是编号：预设把同一个 label 同时当 identifier 与显示文本用
 *（见 preset-gfm/src/node/footnote/{definition,reference}.ts），
 * 所以 label 既是用户看到的 [^1] 里的 1，也是引用与定义配对的依据。
 * 预设没有做 label 同步插件（官方源码里的 TODO），因此编号不随增删自动
 * 重排——插入时按「全文最大编号 + 1」分配，天然不与已有脚注重复。
 */
import { $prose } from "@milkdown/utils";
import { Plugin, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";

/** preset-gfm 内置脚注节点在 ProseMirror schema 里的名字 */
const REF = "footnote_reference";
const DEF = "footnote_definition";

/** 查找到的脚注节点（文档位置 + 节点本身） */
interface FootnoteHit {
  pos: number;
  node: PMNode;
}

/**
 * 下一个可用编号：全文已有脚注里最大的【数字】编号 + 1。
 *
 * 非数字 label（手打的 [^note] 之类）不参与计算：它们本来就与数字编号
 * 不会撞车，硬要统一反而会把用户的自定义 label 改掉。
 * 一个数字脚注都没有时从 1 开始（max 初值 0）。
 */
function nextLabel(doc: PMNode): string {
  let max = 0;
  doc.descendants((node) => {
    if (node.type.name !== REF && node.type.name !== DEF) return true;
    const n = Number.parseInt(String(node.attrs.label ?? ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
    // 定义内部还可能嵌引用，继续往下遍历
    return true;
  });
  return String(max + 1);
}

/** 按类型 + label 找脚注节点（引用或定义），返回第一个命中的 */
function findFootnote(doc: PMNode, typeName: string, label: string): FootnoteHit | null {
  let found: FootnoteHit | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === typeName && String(node.attrs.label ?? "") === label) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  // TS 的控制流分析看不到回调里的赋值，这里显式收窄（同 slash-menu 的写法）
  return found as FootnoteHit | null;
}

/**
 * 节点内部第一个可输入位置（+1 是为了跨过节点自身的开标记）。
 *
 * 定义节点在 PM 里的结构只有 dd 的内容（dt 是 toDOM 渲染出来的装饰，
 * 不占文档位置），所以这里拿到的就是 dd 内那个空段落的内容起点。
 */
function firstTextPos(doc: PMNode, from: number, size: number): number | null {
  let found: number | null = null;
  doc.nodesBetween(from, from + size, (node, pos) => {
    if (found != null) return false;
    if (node.isTextblock) {
      found = pos + 1;
      return false;
    }
    return true;
  });
  return found as number | null;
}

/**
 * 一次性提示气泡：2.6 秒后自动消失，点击或按键立即消失。
 *
 * 为什么要它：插入脚注后光标会跳到文末，长文档里页面一滚，用户很容易
 * 不知道自己到了哪、要干什么。一句话说清「直接输入内容、点正文继续」。
 * 样式复用斜杠菜单的 mt-slash-hint，视觉保持一致。
 */
function flashHint(view: EditorView, text: string): void {
  if (typeof document === "undefined") return;
  const host = document.querySelector<HTMLElement>(".milkdown") ?? document.body;
  const el = document.createElement("div");
  el.className = "mt-slash-hint";
  el.textContent = text;
  host.appendChild(el);

  try {
    const coords = view.coordsAtPos(view.state.selection.from);
    const maxLeft = Math.max(8, window.innerWidth - el.offsetWidth - 8);
    el.style.left = `${Math.max(8, Math.min(coords.left, maxLeft))}px`;
    el.style.top = `${coords.bottom + 6}px`;
  } catch {
    /* 位置失效时留在默认角落，不影响功能 */
  }

  const remove = (): void => {
    window.clearTimeout(timer);
    el.remove();
    document.removeEventListener("mousedown", remove, true);
    document.removeEventListener("keydown", remove, true);
  };
  const timer = window.setTimeout(remove, 2600);
  document.addEventListener("mousedown", remove, true);
  document.addEventListener("keydown", remove, true);
}

/**
 * 插入一对脚注：正文光标处插上标引用，文末建定义，光标落进定义里。
 *
 * 两次插入共用一个事务：正文引用落在定义【之前】，插完引用后「文档末尾」
 * 这个坐标会整体后移，所以定义的落点必须过一遍 mapping 换算——否则光标会
 * 停在正文段落开头而不是跳进定义（详见 insertFootnote 里的注释）。
 */
export function insertFootnote(view: EditorView): boolean {
  const { state } = view;
  const refType = state.schema.nodes[REF];
  const defType = state.schema.nodes[DEF];
  const paraType = state.schema.nodes.paragraph;
  if (!refType || !defType || !paraType) {
    // gfm preset 没注册成功时静默失败，至少不抛异常打断编辑
    // eslint-disable-next-line no-console
    console.warn("[footnote] schema 缺少 footnote_reference / footnote_definition 节点");
    return false;
  }

  const label = nextLabel(state.doc);
  // 定义节点的 content 是 block+，必须带一个段落，否则 schema 校验不过
  const defNode = defType.create({ label }, paraType.create());
  const refNode = refType.create({ label });

  // 引用插在【选区末尾】：选中一段文字再加脚注时，上标落在被选文字之后，
  // 而不是替换掉选区（与右键菜单「链接」同语义：追加，不吞掉已有内容）
  const refPos = state.selection.to;
  const endPos = state.doc.content.size;

  const tr = state.tr;
  // 先把光标收拢到插入点：否则 insert 会以选区起点为准，
  // 上标跑到选中文字【前面】去。
  // 用 near 而不是 create：选中图片（NodeSelection）或停在原子块旁（gapcursor）
  // 时，create 出来的选区可能落在块边界上（不是合法的输入位置），
  // near 会自动收敛到最近的可输入位置。
  const nearSel = TextSelection.near(tr.doc.resolve(refPos));
  const insertAt = nearSel.from;

  // 引用是【行内】节点：代码块这类内容只允许纯文本（text*）的位置插不进去，
  // 硬插会让 ProseMirror 抛 Invalid content 打断编辑。提前判断并给出提示。
  const $at = tr.doc.resolve(insertAt);
  if (!$at.parent.canReplaceWith($at.index(), $at.index(), refType)) {
    flashHint(view, "这里不能插入脚注");
    return false;
  }

  tr.setSelection(nearSel);
  // 顺序很重要：先插正文引用，再把「文档末尾」过一遍 mapping 拿定义的位置。
  //
  // 两次插入共用一个事务，后一次的位置必须映射——引用在定义【之前】，插完
  // 引用后原 endPos 之后的一切整体后移 refNode.nodeSize。若照旧直接用 endPos，
  // 当引用就插在文末那个段落里时，endPos 会落回该段落内部，下面的
  // nodesBetween 就先扫到这个正文段落（它也是 textblock），光标于是停在
  // 正文段落开头——表现正是"插了脚注却没跳到文末"。反过来先插引用、
  // 再 map(endPos)，拿到的才是定义的真实起点。
  tr.insert(insertAt, refNode);
  const defStart = tr.mapping.map(endPos);
  tr.insert(defStart, defNode);

  // 光标送进刚建的定义内部，用户可以直接开始打字
  const caret = firstTextPos(tr.doc, defStart, defNode.nodeSize);
  if (caret != null) tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
  flashHint(view, "脚注内容直接输入 · 点正文任意处继续");
  return true;
}

/** 点上标 → 跳到文末对应定义（没有定义时给提示，不静默无反应） */
function jumpToDefinition(view: EditorView, label: string): boolean {
  const hit = findFootnote(view.state.doc, DEF, label);
  if (!hit) {
    flashHint(view, "文档里还没有这条脚注的定义");
    return true; // 消费点击：否则会选中上标，与"点了没反应"一样让人困惑
  }
  const caret = firstTextPos(view.state.doc, hit.pos, hit.node.nodeSize);
  const tr = view.state.tr;
  // 定义内没有可输入位置时退到节点前的近邻位置，至少保证滚动过去
  tr.setSelection(TextSelection.near(tr.doc.resolve(caret ?? hit.pos + 1), 1));
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
  return true;
}

/** 点定义编号 → 跳回正文第一个引用该 label 的上标 */
function jumpToReference(view: EditorView, label: string): boolean {
  const hit = findFootnote(view.state.doc, REF, label);
  if (!hit) {
    flashHint(view, "正文里没有引用这条脚注");
    return true;
  }
  const after = hit.pos + hit.node.nodeSize;
  const tr = view.state.tr;
  // 落点取引用【之后】：光标停在紧跟着的文字前，方便直接改后面的正文
  tr.setSelection(TextSelection.near(tr.doc.resolve(after), 1));
  tr.scrollIntoView();
  view.dispatch(tr);
  view.focus();
  return true;
}

/**
 * 点击跳转：
 *  - 点正文里的上标（footnote_reference）→ 跳到文末定义；
 *  - 点定义行前的编号（dt）→ 跳回正文首个引用。
 *
 * dt 是 toDOM 渲染出来的、ProseMirror 并不认识它，所以只能从
 * event.target 的 DOM 结构反推（所在的 dl 带 data-type=footnote_definition）；
 * label 也从 dl 的 data-label 读，与节点 attrs 同源。
 *
 * 副作用（已与用户确认，同 Typora / Obsidian）：单击上标被跳转占用，
 * 想删除上标要用 Backspace，或删掉文末对应的定义。
 */
export const footnoteClickPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleClick(view, pos, event) {
          const state = view.state;

          // ---- 1) 点定义编号 ----
          const target = event.target as HTMLElement | null;
          const dt = target?.closest?.("dt") ?? null;
          const dl = dt?.parentElement ?? null;
          if (dl?.getAttribute("data-type") === DEF) {
            const label = dl.getAttribute("data-label") ?? "";
            if (label) return jumpToReference(view, label);
          }

          // ---- 2) 点上标 ----
          // 必须真的点中上标元素才跳：引用是行内原子节点，常位于行尾，点它后面
          // （行内尾随空白）时 PM 的 pos 落在引用之后、nodeBefore 正是引用，
          // 只按"pos 相邻有没有 REF"判断会误触发跳转，导致无法在行尾点一下继续输入。
          const refEl = target?.closest?.('[data-type="footnote_reference"]');
          if (refEl) {
            // atom 行内节点没有内部位置，pos 通常落在节点边界上，前后各看一眼才稳定
            const safePos = Math.max(0, Math.min(pos, state.doc.content.size));
            const $pos = state.doc.resolve(safePos);
            const node = $pos.nodeAfter ?? $pos.nodeBefore;
            if (node?.type.name === REF) {
              return jumpToDefinition(view, String(node.attrs.label ?? ""));
            }
          }
          return false;
        },
      },
    })
);

/**
 * Ctrl/Cmd + Alt + F：插入脚注。
 *
 * 做成编辑器内 keymap 而不是 App.vue 的全局快捷键：插入要用到当前
 * EditorView 与文档状态，插件里直接就有，不必再找办法把 view 传出去；
 * 而且只有编辑器获得焦点时才该生效（源码模式下按它不应该插入节点）。
 */
export const footnoteKeymapPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (!(event.ctrlKey || event.metaKey) || !event.altKey) return false;
          if (event.key !== "f" && event.key !== "F") return false;
          return insertFootnote(view);
        },
      },
    })
);

/** 供 plugins.ts 注册（顺序：须在 gfmPlugins 之后，依赖它注册的节点类型） */
export const footnotePlugins = [footnoteKeymapPlugin, footnoteClickPlugin];
