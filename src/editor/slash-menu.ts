/*
 * slash-menu.ts — 斜杠命令菜单（Notion 风格）
 *
 * 触发：在段落 / 标题行开头输入 "/" 弹出命令菜单。限制"块开头"是为了避免正文里
 *       写 C:/Users、1/2 之类的内容时频繁误弹菜单；代码块里 "/" 是字面量，不弹。
 * 过滤：继续输入英文缩写或中文关键词实时过滤（/h2、/标题、/bq 都能命中）。
 * 操作：↑↓ 选择、Enter / Tab 确认、Esc 关闭、鼠标点击直接执行。
 *
 * 实现要点：
 * - Plugin state（PluginKey）保存激活态、"/" 的文档位置、当前 query、选中项索引；
 * - handleTextInput 检测 "/"，仅在段落开头（parentOffset === 0）时激活；
 * - state.apply 校验 query 仍是 "/xxx" 且无空格，一旦不满足立即关闭；
 * - 菜单 DOM 挂在 .milkdown 容器内才能取到 --mt-* 主题变量（同 table-menu）；
 * - 命令执行统一走 runCmd()：先删除 "/query" 文本，再在干净的状态上派发事务；
 * - 中文输入法（IME）合成期间不触发，避免候选词阶段误弹菜单。
 *
 * 注意：所有需要宿主环境能力的命令（如插入图片要开系统文件对话框）通过
 * setSlashActionHandler 回调交给 App.vue 处理，插件本身不直接调 Tauri API。
 */
import { $prose } from "@milkdown/utils";
import type { Ctx } from "@milkdown/ctx";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type {
  Mark,
  MarkType,
  Node as PMNode,
  NodeType,
} from "@milkdown/prose/model";
import { toggleMark, wrapIn } from "@milkdown/prose/commands";
import { wrapInList } from "@milkdown/prose/schema-list";

// 项目自定义节点：通过 Milkdown ctx 取类型，避免硬编码节点名
import { mathBlockSchema } from "./math-view";
import { alertSchema } from "./alert";
import { tocSchema } from "./toc";
import { frontmatterSchema } from "./frontmatter";
import { htmlBlockSchema } from "./html-block";
import { diagramSchema } from "@milkdown/plugin-diagram";
import { setSelectionAfterBlock } from "./block-exit";

/** 需要宿主环境（App.vue）处理的动作 */
export type SlashAction = "image";

type SlashActionHandler = (
  action: SlashAction,
  view: EditorView,
  pos: number
) => void;

let actionHandler: SlashActionHandler | null = null;

/** 供 App.vue 注册宿主能力回调（如打开图片选择对话框） */
export function setSlashActionHandler(handler: SlashActionHandler | null): void {
  actionHandler = handler;
}

/** 命令执行上下文：Milkdown ctx + 编辑器视图 */
interface SlashCommandRunArgs {
  ctx: Ctx;
  view: EditorView;
  /** "/" 的文档位置 */
  from: number;
  /** 光标位置（"/" + query 之后） */
  to: number;
}

interface SlashCommand {
  id: string;
  /** 菜单显示的中文名 */
  title: string;
  /** 右侧浅色提示（markdown 语法） */
  hint?: string;
  /** 左侧图标（纯文本字符，不引图标库） */
  icon: string;
  /** 所属分组 */
  group: string;
  /** 匹配关键词：英文缩写 + 中文全拼 */
  keywords: string[];
  run: (args: SlashCommandRunArgs) => void;
}

/** 分组展示顺序 */
const GROUP_ORDER = ["基础", "列表", "高级", "格式", "插入"];

/** query 最大长度（超过则关闭菜单，防止用户一路输入下去菜单不消失） */
const MAX_QUERY = 32;

/** 当前 "/" 位置（供滚动时重定位菜单使用） */
let slashFrom = 0;

/** $prose 构建时保存的 ctx（命令需要它来取自定义节点类型） */
let currentCtx: Ctx;

/** 中文输入法合成状态：合成期间不触发菜单，避免候选词阶段误弹 */
let imeComposing = false;

/**
 * 持续输入的行内 mark。
 *
 * 注：本项目中所有 format mark 都是 inclusive:true（行内代码已在
 * plugins.ts 通过 inlineCodeInclusiveSchema 覆盖成 inclusive:true）。
 * 因此非包含型补 mark 的路径在当前 schema 下不会触发——行内代码的
 * 连续输入改由"空光标强制写 storedMarks + inclusive 自然继承"实现。
 * 此函数保留作通用兜底（理论上仍可服务任何 inclusive:false 的 mark）。
 */
/**
 * 保存完整的 mark【实例】而不是 MarkType：
 * 补 mark 时要在新字符上还原同样的属性（链接的 href 就是存在 attrs 里的），
 * 只记类型的话建出来的 mark 会丢掉 href，链接就废了。
 */
let pendingMark: Mark | null = null;

/**
 * 持续输入的锚点：下一个字符应当落在的位置。
 *
 * 用来判断光标是不是还在"接着往下写"。必须有它：刚斜杠插入行内代码时文档里
 * 一个字符都还没有，光标既不在格式内、前面也没有带格式的文字，只有锚点能对上。
 * 少了这条就会出现"输入第一个字母就退出行内代码"。
 */
let pendingAnchor = -1;

/**
 * 刚退出的 mark 类型 + "吃掉一次继承"标志。
 *
 * 包含型 mark（加粗等，inclusive: true）在光标位于内容末尾时会被自动继承，
 * 即使退出了持续模式，紧接着输入的字符仍会带上该 mark——表现为"关不掉"。
 * 因此退出后的第一次输入要显式插入【无 mark】的文本，打断这次继承。
 */
let exitedMarkTypes: MarkType[] = [];
let skipMarkOnce = false;

/** 输入法合成开始时的光标位置（合成结束后据此给整段文本补 mark） */
let compositionStartPos = -1;

/**
 * 退出持续输入 / 行内格式：只认 Esc。
 *
 * 方向键 / Home / End / Enter / Tab / 点别处一律不作为退出信号 —— 在粗体或行内代码
 * 里挪光标改个错字是高频操作，被打断就会莫名其妙掉出格式。
 * 因此也不能用「key.length > 1」这类宽泛判断：切换输入法时发出的
 * Control / Shift / Alt / Meta 同样是多字符键名，会把格式误关掉。
 */


/**
 * 成对标记（== 高亮 / ~~ 删除线）。
 *
 * 光标已经在该 mark 内部时，敲一个标记字符就表示"结束这个格式"：
 * 不把这个字符写进正文，并让后续输入脱离该 mark。
 * 否则标记字符会被原样写入、序列化时再被转义，源码里就出现
 * \====文字== 这种垃圾。
 *
 * 代价是在该格式内无法输入这个字符本身（高亮里打不出 =、删除线里打不出 ~），
 * 这个取舍是值得的——进入该状态后敲它，意图几乎都是"结束"。
 */
const PAIR_MARKS: Array<{ name: string; char: string }> = [
  { name: "highlight", char: "=" },
  // 删除线（~ / ~~）刻意不在此列：干预它会干扰 ~~abc~~ 的正常输入
  //（第三个 ~ 落下时默认规则就会触发，再吞字符反而多出字面 ~）。
];

if (typeof window !== "undefined") {
  window.addEventListener("compositionstart", () => {
    imeComposing = true;
    if (currentView) compositionStartPos = currentView.state.selection.from;
  });
  window.addEventListener("compositionend", () => {
    imeComposing = false;
    // 中文上屏不走 handleTextInput（走 DOM 观察），需在此给整段合成文本补 mark
    const view = currentView;
    const mark = pendingMark;
    if (view && compositionStartPos >= 0) {
      const start = compositionStartPos;
      setTimeout(() => {
        try {
          const end = view.state.selection.from;
          if (end <= start) return;
          if (skipMarkOnce) {
            // 刚退出：去掉继承来的 mark，保证之后的输入不再带格式
            skipMarkOnce = false;
            if (exitedMarkTypes.length > 0) {
              let tr = view.state.tr;
              for (const t of exitedMarkTypes) {
                tr = tr.removeMark(start, end, t);
              }
              view.dispatch(tr);
            }
            exitedMarkTypes = [];
          } else if (mark) {
            // 与 handleTextInput 同一条兜底：中文上屏前光标可能已经挪走，
            // 不校验会把整段合成文字都染成代码。
            const $s = view.state.doc.resolve(start);
            const attached =
              start === pendingAnchor ||
              mark.type.isInSet($s.marks()) ||
              Boolean($s.nodeBefore && mark.type.isInSet($s.nodeBefore.marks));
            if (attached) {
              view.dispatch(view.state.tr.addMark(start, end, mark));
              pendingAnchor = end;
            } else {
              pendingMark = null;
              pendingAnchor = -1;
              hideContinuousHint();
            }
          }
        } catch {
          /* 视图已销毁，忽略 */
        }
      }, 0);
    }
    compositionStartPos = -1;
  });

  // Esc 收起提示气泡：捕获阶段兜底，不依赖插件的 handleKeyDown 有没有执行到。
  //
  // inline-mark-escape 插件注册在本插件之前（见 plugins.ts 的顺序约束：它要排在
  // findReplacePlugin 之后，本插件要排最后才能拿到完整 schema），而它在 Esc 上
  // return true，ProseMirror 随即停止向后续插件传播 —— 本插件的 handleKeyDown
  // 根本执行不到。粗体 / 斜体这类包含型 mark 在光标处有 marks，必然被它截获，
  // 气泡就一直挂着；行内代码（inclusive:false）在末尾没有 marks，逃过截获反而
  // 正常，于是只有"粗体这些气泡按 Esc 不消失"。
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const v = hintView;
      // 被截获时没人清 storedMarks，退出就只挡得住一个字符，这里补上
      if (v) {
        const marks = activeMarks(v.state);
        if (marks.length > 0) clearStoredMarks(v, marks.map((m) => m.type));
      }
      hideContinuousHint();
    },
    true
  );

  // 菜单激活时，↑ ↓ Enter Tab 必须抢在 gapcursor 之前处理（捕获阶段）。
  //
  // prosemirror-gapcursor 的 keydownHandler 同样吃 ArrowUp / ArrowDown，而它注册在
  // 本插件之前（见 plugins.ts 顺序）。菜单开在块级原子节点（toc / yaml / htmlBlock）
  // 下方时，向上正好是这类节点，gapcursor 会把选区换成 GapCursor 并消费掉按键；
  // 本插件随后在 state.apply 里发现光标已离开触发区（readQuery 返回 null），
  // 菜单就被关掉了。捕获阶段早于事件到达编辑器 DOM，能确保菜单先拿到按键。
  window.addEventListener(
    "keydown",
    (e) => {
      const v = currentView;
      if (!v) return;
      if (
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown" &&
        e.key !== "Enter" &&
        e.key !== "Tab"
      ) {
        return;
      }
      if (handleMenuNavKey(v, e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
}

// ==================== 命令执行辅助 ====================

/**
 * 先删除 "/query"，再在删除后的状态上执行 ProseMirror 命令。
 *
 * 关键：命令必须"看到"删除后的干净文档（否则斜杠文本会被算进块内容），
 * 但命令产生的事务是按【删除后】的文档位置计算的，直接 dispatch 到
 * 【尚未删除】的真实文档上会造成位置整体错位——表现为斜杠文本残留、
 * 命令作用在错误位置。因此这里把两个事务的 steps 合并进同一个
 * 基于 view.state 的事务，顺序执行，位置才对得上。
 */
function runWithDelete(
  view: EditorView,
  from: number,
  to: number,
  cmd: Command
): void {
  // 第一步：真正派发删除事务，让编辑器状态先落到"干净"的文档上
  view.dispatch(view.state.tr.delete(from, to));
  // 第二步：在真实的最新状态上执行命令。
  // 刻意不再用 state.apply() 造虚拟中间状态——那样命令的 steps 是按
  // "删除后"的坐标算的，且 apply 会触发其他插件的 appendTransaction
  // 污染中间态，是命令静默失效的根源。
  const applied = cmd(view.state, view.dispatch);
  if (!applied) {
    // 命令判定为不适用（当前块不支持该转换）。留一句诊断，方便按 F12 定位
    // eslint-disable-next-line no-console
    console.warn(
      `[slash-menu] 命令未生效（from=${from}, to=${to}），当前块可能不支持该转换`
    );
    view.focus();
  }
}



/**
 * 把光标所在的文本块整体转成指定类型（标题 / 正文 / 代码块 / 公式块…）。
 *
 * 为什么不用 prosemirror-commands 的 setBlockType：它靠
 * doc.nodesBetween(from, to) 遍历选区来判定适用性，而斜杠命令场景下的
 * 选区是【空选区】（from === to，光标停在刚清空斜杠文本的位置），
 * 边界情况下会漏判、静默返回 false。这里直接从光标往上找最近的
 * textblock 并整体替换，语义明确、不受空选区影响。
 */
function setBlockAt(type: NodeType, attrs: Record<string, unknown> | null): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    let depth = $from.depth;
    while (depth > 0 && !$from.node(depth).isTextblock) depth -= 1;
    const node = $from.node(depth);
    if (!node || !node.isTextblock) return false;
    if (node.hasMarkup(type, attrs ?? {})) return true; // 已经是目标类型
    const pos = depth === 0 ? 0 : $from.before(depth);
    const $pos = state.doc.resolve(pos);
    if (!$pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, type)) {
      return false;
    }
    if (dispatch) dispatch(state.tr.setNodeMarkup(pos, type, attrs).scrollIntoView());
    return true;
  };
}

/**
 * 开启"持续输入"模式并应用 mark。
 *
 * 用于后续逐字符补 mark 的场景。本项目中所有 format mark 均为
 * inclusive:true（含被覆盖成 inclusive 的行内代码），该路径当前不触发，
 * 仅作通用兜底保留。
 */
function startContinuousMark(type: MarkType): Command {
  return (state, dispatch) => {
    // 光标已在 mark 内时按普通切换处理（用于关闭）
    if (type.isInSet(state.selection.$from.marks())) {
      clearPendingMark();
      return toggleMark(type)(state, dispatch);
    }
    pendingMark = type.create();
    return toggleMark(type)(state, dispatch);
  };
}

/**
 * 新输入字符实际会带上的 marks。
 *
 * 与 prosemirror-transform 的 insertText 口径一致：storedMarks 非空时直接用它，
 * 否则回落 $from.marks()。只取 $from.marks() 会漏掉「刚 toggle 上、还没敲字」
 * 的那一刻——那时 mark 只存在于 storedMarks，文档里还没有带格式的文字。
 */
function activeMarks(state: EditorState): readonly Mark[] {
  return state.storedMarks ?? state.selection.$from.marks();
}

/**
 * 把已退出的 mark 从 storedMarks 里摘掉。
 *
 * 少了这一步，退出只挡得住【一个】字符：skipMarkOnce 插完那个字符后 storedMarks
 * 仍原样保留（ProseMirror 只在 setSelection 时才清空它），第二个字符又被染回原
 * 格式 —— 看起来就是"退出来了又自己回去"。
 */
function clearStoredMarks(view: EditorView | null, types: MarkType[]): void {
  if (!view || types.length === 0) return;
  const stored = view.state.storedMarks;
  if (!stored || stored.length === 0) return;
  const rest = stored.filter((m) => !types.includes(m.type));
  if (rest.length === stored.length) return;
  view.dispatch(view.state.tr.setStoredMarks(rest));
}

/**
 * 停止持续输入（行内代码这类非包含型 mark），并收起提示气泡。
 *
 * 只管"停止逐字符补 mark"这一件事。粗体 / 斜体 / 高亮这类包含型 mark
 * 不在这里处理 —— 它们靠 inclusive 自然继承，唯一出口是 Esc（见 handleKeyDown）。
 * 方向键 / 点击只收起气泡、不改格式，否则在粗体里挪光标改个错字，
 * 刚输入的字就会被打断成非粗体。
 */
function clearPendingMark(view?: EditorView | null): void {
  if (pendingMark) {
    // 记住刚退出的 mark：下次输入要吃掉它的继承，否则关不掉
    exitedMarkTypes = [pendingMark.type];
    skipMarkOnce = true;
    clearStoredMarks(view ?? hintView, exitedMarkTypes);
  }
  pendingMark = null;
  pendingAnchor = -1;
  hideContinuousHint();
}

/** 持续输入模式的提示气泡 DOM */
let hintEl: HTMLDivElement | null = null;
/** 提示气泡所属的编辑器视图（mousedown 这类拿不到 view 的退出路径要用） */
let hintView: EditorView | null = null;

/**
 * 在光标下方提示"XX 输入中 · Esc 或方向键退出"。
 * 没有它用户完全看不出自己正处在持续输入状态，也不知道怎么退出来。
 * 文案里的两种退出方式必须与下面的退出逻辑实际行为一致。
 */
function showContinuousHint(view: EditorView, label: string): void {
  hideContinuousHint();
  const host = document.querySelector<HTMLElement>(".milkdown") ?? document.body;
  const el = document.createElement("div");
  el.className = "mt-slash-hint";
  el.textContent = `${label}输入中 · Esc 退出`;
  el.style.left = "0px";
  el.style.top = "0px";
  host.appendChild(el);
  hintEl = el;
  hintView = view;
  // 进入持续输入：记下锚点，作为"光标还在接着写"的判据之一
  pendingAnchor = view.state.selection.from;
  try {
    const coords = view.coordsAtPos(view.state.selection.from);
    const maxLeft = Math.max(8, window.innerWidth - el.offsetWidth - 8);
    el.style.left = `${Math.max(8, Math.min(coords.left, maxLeft))}px`;
    el.style.top = `${coords.bottom + 6}px`;
  } catch {
    /* 位置失效时保持在默认角落，不影响功能 */
  }
}

function hideContinuousHint(): void {
  hintEl?.remove();
  hintEl = null;
  hintView = null;
}

/**
 * 插入块级节点，并保证光标有地方落脚。
 *
 * atom 块（hr / toc / yaml / table 等）本身不可编辑，插入后若后面没有
 * 段落，光标无处可去（虽然启用了 gapcursor，但普通光标仍进不去），
 * 因此在节点后补一个空段落并把光标放进去。
 */
/**
 * 光标所在块的范围，以及该块是否为"空文本块"。
 *
 * 斜杠命令的典型场景是光标停在刚清空斜杠文本的【空段落】里。此时插入
 * 块级节点必须【整体替换】该块，而不是在光标处插入——后者会走 PM 的
 * 切分逻辑，把节点放到当前块【之后】，表现为"分割线出现在光标下方"，
 * 上面还残留一个空段落。
 */
function blockRangeAt(state: EditorState): {
  start: number;
  end: number;
  empty: boolean;
} {
  const { $from } = state.selection;
  let depth = $from.depth;
  while (depth > 0 && !$from.node(depth).isBlock) depth -= 1;
  if (depth === 0) {
    return { start: 0, end: state.doc.content.size, empty: false };
  }
  const block = $from.node(depth);
  return {
    start: $from.before(depth),
    end: $from.after(depth),
    empty: block.isTextblock && block.content.size === 0,
  };
}

function insertAtom(
  type: NodeType,
  attrs?: Record<string, unknown>
): Command {
  return (state, dispatch) => {
    const node = type.create(attrs);
    const { start, end, empty } = blockRangeAt(state);

    let tr: Transaction;
    let nodeStart: number;
    if (empty) {
      // 空块：整体替换为节点本身，节点落在原块位置
      nodeStart = start;
      tr = state.tr.replaceWith(start, end, node);
    } else {
      // 非空块：在光标处插入（由 PM 负责按需切分）。
      // 节点起点就是插入前的选区起点。不能写成
      // `tr.selection.from - node.nodeSize`：插入后若后方没有可落脚的文本
      // 位置，tr.selection 会往前找，减出来的起点是错的（光标跑到上一个
      // 块的末尾，插入位置也会算错）。
      nodeStart = state.selection.from;
      tr = state.tr.replaceSelectionWith(node);
    }
    // atom 块不可编辑，光标进不去：把光标放到节点之后的最近文本位置。
    // 与表格一致，【不】补空段落，避免序列化留下多余的 <br />。
    // 用 setSelectionAfterBlock 而非 Selection.near：后者向后找不到位置时会
    // 往前找，光标会跳到上一个块末尾（插入后光标跑到上面的对象后面）。
    setSelectionAfterBlock(tr, nodeStart + node.nodeSize);
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 插入容器块（如 alert，内含一个空段落），光标落进容器内部 */
function insertWrap(
  type: NodeType,
  attrs: Record<string, unknown>
): Command {
  return (state, dispatch) => {
    const node = type.create(attrs, state.schema.nodes.paragraph.create());
    const { start, end, empty } = blockRangeAt(state);

    let tr: Transaction;
    if (empty) {
      // 空块：整体替换为容器本身（容器内已含空段落）
      tr = state.tr.replaceWith(start, end, node);
      tr.setSelection(TextSelection.near(tr.doc.resolve(start + 1)));
    } else {
      tr = state.tr.replaceSelectionWith(node);
      const $at = tr.doc.resolve(tr.selection.from);
      if (!$at.parent.isTextblock) {
        tr.setSelection(TextSelection.near($at, 1));
      }
    }
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * 插入 rows × cols 的表格（含表头行，数据行 = rows - 1），光标落进第一个单元格。
 * 与固定 3×3 的旧实现行为一致，仅行列数可配置。
 */
function insertTableNxM(rows: number, cols: number): Command {
  return (state, dispatch) => {
    const { schema } = state;
    const { table, table_header_row, table_header, table_row, table_cell, paragraph } =
      schema.nodes;
    if (!table || !table_header_row || !table_header || !table_row || !table_cell) {
      return false;
    }
    const emptyCell = (type: NodeType): PMNode => type.create(null, paragraph.create());

    const headerCells: PMNode[] = Array.from({ length: cols }, () =>
      emptyCell(table_header)
    );
    const bodyRow = (): PMNode =>
      table_row.create(
        null,
        Array.from({ length: cols }, () => emptyCell(table_cell))
      );
    // table 的 content 约束是 "table_header_row table_row+"：
    // 一个表头行 + 至少一个数据行，顺序错会导致 schema 校验失败
    const node = table.create(null, [
      table_header_row.create(null, headerCells),
      ...Array.from({ length: Math.max(1, rows - 1) }, bodyRow),
    ]);

    // 与 insertAtom 同理：光标在空块时整体替换，避免表格落到光标下方。
    // 注意：表格本身可编辑（光标会进单元格），所以【不】像 insertAtom 那样
    // 在后面补空段落——否则保存后会在表格下方留一行多余的 <br />。
    const { start, end, empty } = blockRangeAt(state);
    let tr: Transaction;
    let nodeStart: number;
    if (empty) {
      nodeStart = start;
      tr = state.tr.replaceWith(start, end, node);
    } else {
      // 同 insertAtom：起点取插入前的选区起点（tr.selection 可能已在插入后
      // 向前偏移，反推会算错，进而让 nodesBetween 扫到旧表格）
      nodeStart = state.selection.from;
      tr = state.tr.replaceSelectionWith(node);
    }

    // 光标落进第一个单元格（表头第一格），方便直接填写表头。
    // 只在刚插入的这个表格范围内找，避免定位到文档里已有的旧表格。
    let cellPos: number | null = null;
    tr.doc.nodesBetween(nodeStart, nodeStart + node.nodeSize, (n, pos) => {
      if (cellPos != null) return false;
      if (n.type.name === "table_header" || n.type.name === "table_cell") {
        cellPos = pos;
        return false;
      }
      return true;
    });
    if (cellPos != null) {
      // +1 进入单元格内的段落，near 会落到段落内容起始
      tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)));
    }
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * 任务列表：gfm 没有独立的 taskList 节点，而是给 list_item 加 checked 属性
 *（见 @milkdown/preset-gfm 的 extendListItemSchemaForTask）。
 * 因此先包成无序列表，再把生成的 list_item 标记 checked = false。
 */
function wrapInTaskList(bulletListType: NodeType): Command {
  return (state, dispatch) => {
    let captured: Transaction | undefined;
    const ok = wrapInList(bulletListType)(state, (t) => {
      captured = t;
    });
    // TS 的控制流分析感知不到回调里的赋值，这里显式收窄类型
    const tr = captured as Transaction | undefined;
    if (!ok || !tr) return false;
    const $head = tr.doc.resolve(tr.selection.from);
    for (let d = $head.depth; d > 0; d -= 1) {
      const node = $head.node(d);
      if (node.type.name === "list_item") {
        tr.setNodeMarkup($head.before(d), undefined, {
          ...node.attrs,
          checked: false,
        });
        break;
      }
    }
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

/** 插入一段纯文本并把光标放到末尾 */
function insertText(text: string): Command {
  return (state, dispatch) => {
    const tr = state.tr.insertText(text);
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * 插入链接【节点】，而不是 "[文本](地址)" 这样的纯文本。
 *
 * 纯文本会走 text handler 序列化，而 mdast-util-to-markdown 的默认 unsafe
 * 表会把 ( ) 转义成 \( \)（本项目为兼容 [toc] / [!NOTE] 只过滤了 [ ] 的转义），
 * 导出的 markdown 就变成 [文本]\(地址\)，Typora/Obsidian 都识别不了。
 * 插入真正的 link mark 后由 link handler 序列化，输出才是标准的 [文本](地址)。
 */
/**
 * 在指定位置插入链接。
 *
 * 刻意不用 tr.replaceSelectionWith(node)：它默认 inheritMarks=true，
 * 会用选区继承来的 marks 覆盖节点自带的 link mark，结果插入的是一段
 * 没有链接格式的普通文字。这里先插入纯文本、再显式 addMark，结果确定。
 * @param pos 插入位置（浮层打开时记录的，不依赖失焦后的 selection）
 */
function insertLinkNode(
  view: EditorView,
  label: string,
  href: string,
  pos: number
): void {
  const state = view.state;
  const linkType = state.schema.marks["link"];
  if (!linkType) {
    // eslint-disable-next-line no-console
    console.warn("[slash-menu] schema 中找不到 link mark，无法插入链接");
    return;
  }
  // 位置收敛：浮层打开期间文档可能被改动，避免越界
  const at = Math.min(Math.max(pos, 0), state.doc.content.size);
  const mark = linkType.create({ href });
  const tr = state.tr.insertText(label, at);
  tr.addMark(at, at + label.length, mark);
  // 选中链接文字，用户直接打字即可替换，不必先手动选中
  tr.setSelection(TextSelection.create(tr.doc, at, at + label.length));
  view.dispatch(tr.scrollIntoView());
  // 进入持续输入模式：link mark 是包含型的，光标停在链接末尾会一直继承，
  // 不接管的话后续输入会全变成链接文字，根本退不出来
  pendingMark = mark;
  showContinuousHint(view, "链接");
  view.focus();
}

/**
 * 弹出地址输入框，回车后插入真正的链接节点。
 *
 * 为什么要输入地址：只插入一个空 href 的链接，看起来就是一段普通文字，
 * 既没有链接外观也点不开。让用户先给地址，插入后才是可用的链接。
 */
function promptLinkUrl(view: EditorView, label: string): void {
  // 浮层打开期间编辑器会失焦，selection 不再可靠，先把插入位置记下来
  const insertPos = view.state.selection.from;

  const host = document.querySelector<HTMLElement>(".milkdown") ?? document.body;
  const box = document.createElement("div");
  box.className = "mt-slash-linkbox";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "mt-slash-linkbox__input";
  input.placeholder = "输入链接地址";
  input.value = "https://";

  const tip = document.createElement("div");
  tip.className = "mt-slash-linkbox__tip";
  tip.textContent = "Enter 确认 · Esc 取消";

  box.appendChild(input);
  box.appendChild(tip);
  host.appendChild(box);

  try {
    const coords = view.coordsAtPos(view.state.selection.from);
    const maxLeft = Math.max(8, window.innerWidth - box.offsetWidth - 8);
    box.style.left = `${Math.max(8, Math.min(coords.left, maxLeft))}px`;
    box.style.top = `${coords.bottom + 6}px`;
  } catch {
    /* 位置失效时保持默认角落 */
  }
  input.focus();
  input.select();

  const cleanup = () => {
    box.remove();
    document.removeEventListener("mousedown", onDown, true);
  };
  const onDown = (e: MouseEvent) => {
    if (!box.contains(e.target as Node)) cleanup();
  };
  const commit = () => {
    const href = input.value.trim();
    cleanup();
    if (href) insertLinkNode(view, label, href, insertPos);
  };

  input.addEventListener("keydown", (e) => {
    // 阻止冒泡，否则会被编辑器的快捷键/插件抢走
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
      view.focus();
    }
  });
  document.addEventListener("mousedown", onDown, true);
}

/**
 * 弹出「列 × 行」两个数字输入框，确认后插入对应规格的表格。
 * 交互与链接地址输入框一致：Enter 确认、Esc 取消、点框外关闭。
 * 非法输入（非正整数 / 留空）直接放弃（不插入、不报错），
 * 用户按 Esc 或重新输入即可。行数含表头：内部按 schema 约束
 * 至少生成 1 个表头行 + 1 个数据行。
 */
function promptTableSize(view: EditorView): void {
  // 浮层打开期间编辑器会失焦，selection 不再可靠，先把插入位置记下来
  const insertPos = view.state.selection.from;

  const host = document.querySelector<HTMLElement>(".milkdown") ?? document.body;
  const box = document.createElement("div");
  box.className = "mt-slash-linkbox";

  // 列、行两个小数字框，中间用 × 分隔 —— 直接各填一个数字，不用输 x
  const rowWrap = document.createElement("div");
  rowWrap.style.display = "flex";
  rowWrap.style.alignItems = "center";
  rowWrap.style.gap = "6px";

  const label = (text: string) => {
    const s = document.createElement("span");
    s.textContent = text;
    s.style.opacity = "0.6";
    s.style.fontSize = "12px";
    return s;
  };

  const colsInput = document.createElement("input");
  colsInput.type = "text";
  colsInput.inputMode = "numeric";
  colsInput.className = "mt-slash-linkbox__input";
  colsInput.style.width = "56px";
  colsInput.value = "3";

  const sep = document.createElement("span");
  sep.textContent = "×";
  sep.style.opacity = "0.6";

  const rowsInput = document.createElement("input");
  rowsInput.type = "text";
  rowsInput.inputMode = "numeric";
  rowsInput.className = "mt-slash-linkbox__input";
  rowsInput.style.width = "56px";
  rowsInput.value = "3";

  rowWrap.append(label("列"), colsInput, sep, label("行"), rowsInput);

  const tip = document.createElement("div");
  tip.className = "mt-slash-linkbox__tip";
  tip.textContent = "Enter 确认 · Esc 取消";

  box.appendChild(rowWrap);
  box.appendChild(tip);
  host.appendChild(box);

  try {
    const coords = view.coordsAtPos(view.state.selection.from);
    const maxLeft = Math.max(8, window.innerWidth - box.offsetWidth - 8);
    box.style.left = `${Math.max(8, Math.min(coords.left, maxLeft))}px`;
    box.style.top = `${coords.bottom + 6}px`;
  } catch {
    /* 位置失效时保持默认角落 */
  }
  colsInput.focus();
  colsInput.select();

  const cleanup = () => {
    box.remove();
    document.removeEventListener("mousedown", onDown, true);
  };
  const onDown = (e: MouseEvent) => {
    if (!box.contains(e.target as Node)) cleanup();
  };
  const commit = () => {
    const rows = Number(rowsInput.value.trim());
    const cols = Number(colsInput.value.trim());
    cleanup();
    // 只要求正整数，不设上限；行数含表头，内部至少生成 1 表头 + 1 数据行
    if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
      view.focus();
      return;
    }
    // 弹框期间编辑器可能已被改动，先把光标恢复到记录的插入位置再执行命令
    const $pos = view.state.doc.resolve(
      Math.min(insertPos, view.state.doc.content.size)
    );
    view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
    view.focus();
    insertTableNxM(rows, cols)(view.state, view.dispatch);
  };

  const onKey = (e: KeyboardEvent) => {
    // 阻止冒泡，否则会被编辑器的快捷键/插件抢走
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
      view.focus();
    }
  };
  rowsInput.addEventListener("keydown", onKey);
  colsInput.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onDown, true);
}

// ==================== 命令表 ====================

/** 构建命令表（需要 ctx 拿自定义节点类型） */
function buildCommands(ctx: Ctx): SlashCommand[] {
  const mathBlock = mathBlockSchema.type(ctx) as NodeType;
  const alert = alertSchema.type(ctx) as NodeType;
  const toc = tocSchema.type(ctx) as NodeType;
  const yaml = frontmatterSchema.type(ctx) as NodeType;
  const htmlBlock = htmlBlockSchema.type(ctx) as NodeType;
  const diagram = diagramSchema.type(ctx) as NodeType;

  /** 内置节点通过 schema 名取（commonmark / gfm 已确认命名） */
  const builtin = (view: EditorView) => view.state.schema;

  const block = (name: string, attrs?: Record<string, unknown>) => (
    args: SlashCommandRunArgs
  ) => {
    const type = builtin(args.view).nodes[name];
    if (!type) return;
    runWithDelete(args.view, args.from, args.to, setBlockAt(type, attrs ?? null));
  };

  const list = (name: "bullet_list" | "ordered_list") => (
    args: SlashCommandRunArgs
  ) => {
    const type = builtin(args.view).nodes[name];
    if (!type) return;
    runWithDelete(args.view, args.from, args.to, wrapInList(type));
  };

  const customBlock = (type: NodeType, attrs?: Record<string, unknown>) => (
    args: SlashCommandRunArgs
  ) => {
    runWithDelete(args.view, args.from, args.to, setBlockAt(type, attrs ?? null));
  };

  const atom = (type: NodeType, attrs?: Record<string, unknown>) => (
    args: SlashCommandRunArgs
  ) => {
    runWithDelete(args.view, args.from, args.to, insertAtom(type, attrs));
  };

  /**
   * 元数据（frontmatter）必须位于文档最开头。
   * 若开头已有元数据则不重复插入；否则插到位置 0，光标放到其后。
   * 走 runWithDelete 与其他命令保持一致，避免"手动两次 dispatch"在
   * 某些文档结构下被 schema 静默丢弃（表现就是插入无效）。
   */
  const insertFrontmatter = (type: NodeType) => (
    args: SlashCommandRunArgs
  ) => {
    runWithDelete(args.view, args.from, args.to, (state, dispatch) => {
      if (state.doc.firstChild?.type === type) return true; // 已有元数据，跳过
      const node = type.create({ value: "" });
      const tr = state.tr.insert(0, node);
      // 光标落到元数据紧邻之后的位置（下一个块的起点）
      setSelectionAfterBlock(tr, node.nodeSize);
      if (dispatch) {
        dispatch(tr.scrollIntoView());
        // 插入后自动把焦点跳进元数据的 textarea 编辑框
        const view = args.view;
        requestAnimationFrame(() => {
          const dom = view.nodeDOM(0) as HTMLElement | null;
          const ta = dom?.querySelector?.(
            ".mt-frontmatter-body"
          ) as HTMLTextAreaElement | null;
          ta?.focus();
        });
      }
      return true;
    });
  };

  /**
   * 块级 HTML：插入一个 htmlBlock 节点（源码存于 value），光标落到其后，
   * 并把焦点跳进编辑框。参见 html-block.ts。
   */
  const insertHtmlBlock = (type: NodeType) => (
    args: SlashCommandRunArgs
  ) => {
    runWithDelete(args.view, args.from, args.to, (state, dispatch) => {
      const node = type.create({ value: "" });
      const { start, end, empty } = blockRangeAt(state);

      let tr: Transaction;
      let nodePos: number;
      if (empty) {
        tr = state.tr.replaceWith(start, end, node);
        nodePos = start;
      } else {
        // 同 insertAtom：起点取插入前的选区起点，不用 tr.selection 反推
        nodePos = state.selection.from;
        tr = state.tr.replaceSelectionWith(node);
      }
      // 与 insertAtom（目录 / 公式块）一致：插入时【不】在后面补空段落。
      // 块后面要不要空行，交给 Ctrl+Enter 决定（见 block-exit.ts）；
      // 自动补的空段落序列化后就是源码里多余的 <br />。
      setSelectionAfterBlock(tr, nodePos + node.nodeSize);
      if (dispatch) {
        dispatch(tr.scrollIntoView());
        // 插入后自动把焦点跳进 HTML 编辑框
        const view = args.view;
        requestAnimationFrame(() => {
          const dom = view.nodeDOM(nodePos) as HTMLElement | null;
          const ta = dom?.querySelector?.(
            ".mt-html-block-body"
          ) as HTMLTextAreaElement | null;
          ta?.focus();
        });
      }
      return true;
    });
  };

  const commands: SlashCommand[] = [
    // ---------- 基础 ----------
    { id: "text", title: "正文", icon: "¶", group: "基础", keywords: ["text", "p", "zhengwen", "正文", "段落"], run: block("paragraph") },
    { id: "h1", title: "一级标题", hint: "#", icon: "H1", group: "基础", keywords: ["h1", "标题1", "一级标题", "biaoti1"], run: block("heading", { level: 1 }) },
    { id: "h2", title: "二级标题", hint: "##", icon: "H2", group: "基础", keywords: ["h2", "标题2", "二级标题", "biaoti2"], run: block("heading", { level: 2 }) },
    { id: "h3", title: "三级标题", hint: "###", icon: "H3", group: "基础", keywords: ["h3", "标题3", "三级标题", "biaoti3"], run: block("heading", { level: 3 }) },
    { id: "h4", title: "四级标题", hint: "####", icon: "H4", group: "基础", keywords: ["h4", "标题4", "四级标题"], run: block("heading", { level: 4 }) },
    { id: "h5", title: "五级标题", hint: "#####", icon: "H5", group: "基础", keywords: ["h5", "标题5", "五级标题"], run: block("heading", { level: 5 }) },
    { id: "h6", title: "六级标题", hint: "######", icon: "H6", group: "基础", keywords: ["h6", "标题6", "六级标题"], run: block("heading", { level: 6 }) },
    {
      id: "quote",
      title: "引用",
      hint: ">",
      icon: "❝",
      group: "基础",
      keywords: ["quote", "bq", "yinyong", "引用"],
      run: (args) => {
        const type = builtin(args.view).nodes["blockquote"];
        if (!type) return;
        runWithDelete(args.view, args.from, args.to, wrapIn(type));
      },
    },
    {
      id: "hr",
      title: "分割线",
      hint: "---",
      icon: "―",
      group: "基础",
      keywords: ["hr", "divider", "fengexian", "分割线", "横线"],
      run: (args) => {
        const type = builtin(args.view).nodes["hr"];
        if (!type) return;
        runWithDelete(args.view, args.from, args.to, insertAtom(type));
      },
    },

    // ---------- 列表 ----------
    { id: "bullet", title: "无序列表", hint: "-", icon: "•", group: "列表", keywords: ["ul", "list", "liebiao", "无序", "无序列表", "列表"], run: list("bullet_list") },
    { id: "ordered", title: "有序列表", hint: "1.", icon: "1.", group: "列表", keywords: ["ol", "有序", "有序列表", "编号"], run: list("ordered_list") },
    {
      id: "task",
      title: "任务列表",
      hint: "- [ ]",
      icon: "☑",
      group: "列表",
      keywords: ["todo", "task", "renwu", "任务", "待办", "任务列表", "复选框"],
      run: (args) => {
        const type = builtin(args.view).nodes["bullet_list"];
        if (!type) return;
        runWithDelete(args.view, args.from, args.to, wrapInTaskList(type));
      },
    },

    // ---------- 高级块 ----------
    { id: "code", title: "代码块", hint: "```", icon: "{ }", group: "高级", keywords: ["code", "daima", "代码块", "代码"], run: block("code_block") },
    {
      id: "table",
      title: "表格",
      hint: "行×列",
      icon: "▦",
      group: "高级",
      keywords: ["table", "biaoge", "表格"],
      run: (args) => {
        // 先清掉斜杠文本，再弹出行列输入框（与 /链接 同一套交互）
        const view = args.view;
        view.dispatch(view.state.tr.delete(args.from, args.to));
        promptTableSize(view);
      },
    },
    { id: "math", title: "公式块", hint: "$$", icon: "∑", group: "高级", keywords: ["math", "gongshi", "公式", "公式块", "数学公式"], run: customBlock(mathBlock) },
    { id: "diagram", title: "流程图", hint: "mermaid", icon: "◫", group: "高级", keywords: ["mermaid", "diagram", "liuchengtu", "流程图", "图表"], run: customBlock(diagram, { value: "graph TD\n  A[开始] --> B[结束]" }) },
    {
      id: "alert-note",
      title: "提示框",
      hint: "[!NOTE]",
      icon: "ⓘ",
      group: "高级",
      keywords: ["note", "tishi", "提示", "提示框", "说明"],
      run: (args) => runWithDelete(args.view, args.from, args.to, insertWrap(alert, { alertType: "note" })),
    },
    {
      id: "alert-tip",
      title: "建议框",
      hint: "[!TIP]",
      icon: "!",
      group: "高级",
      keywords: ["tip", "jianyi", "建议", "技巧"],
      run: (args) => runWithDelete(args.view, args.from, args.to, insertWrap(alert, { alertType: "tip" })),
    },
    {
      id: "alert-important",
      title: "重要框",
      hint: "[!IMPORTANT]",
      icon: "✦",
      group: "高级",
      keywords: ["important", "zhongyao", "重要"],
      run: (args) => runWithDelete(args.view, args.from, args.to, insertWrap(alert, { alertType: "important" })),
    },
    {
      id: "alert-warning",
      title: "警告框",
      hint: "[!WARNING]",
      icon: "▲",
      group: "高级",
      keywords: ["warn", "warning", "jinggao", "警告"],
      run: (args) => runWithDelete(args.view, args.from, args.to, insertWrap(alert, { alertType: "warning" })),
    },
    {
      id: "alert-caution",
      title: "注意框",
      hint: "[!CAUTION]",
      icon: "⊘",
      group: "高级",
      keywords: ["caution", "zhuyi", "注意", "小心"],
      run: (args) => runWithDelete(args.view, args.from, args.to, insertWrap(alert, { alertType: "caution" })),
    },
    {
      id: "html",
      title: "HTML 块",
      hint: "< >",
      icon: "<>",
      group: "高级",
      keywords: ["html", "HTML"],
      run: insertHtmlBlock(htmlBlock),
    },
    {
      id: "toc",
      title: "目录",
      hint: "[toc]",
      icon: "☰",
      group: "高级",
      keywords: ["toc", "mulu", "目录"],
      run: atom(toc),
    },
    {
      id: "frontmatter",
      title: "元数据",
      hint: "---",
      icon: "⛶",
      group: "高级",
      keywords: ["frontmatter", "yaml", "元数据", "头部", "front"],
      run: insertFrontmatter(yaml),
    },
    // 行内格式（加粗/斜体/删除线/行内代码/高亮）已整体移到右键菜单
    //（format-menu.ts）——选中文字后点右键即可转换，不再需要行首 "/"。
    // 上标/下标/下划线、图片/链接 的右键入口见 format-menu.ts；
    // 行内公式与脚注同样只在右键菜单：它们要落在正文光标处，而 "/" 只在
    // 段落开头触发（见上方 handleTextInput 的 parentOffset === 0），
    // 一句话写到一半时根本弹不出菜单，放这里只会误导。
    // "/" 里保留图片、链接、日期这三个「插入」命令。

    // ---------- 插入 ----------
    // ---------- 插入 ----------
    {
      id: "image",
      title: "图片",
      icon: "❒",
      group: "插入",
      keywords: ["img", "image", "tupian", "图片", "插图"],
      run: (args) => {
        const view = args.view;
        view.dispatch(view.state.tr.delete(args.from, args.to));
        // 插入位置：删除斜杠文本后的光标处
        actionHandler?.("image", view, view.state.selection.from);
      },
    },
    {
      id: "link",
      title: "链接",
      hint: "[]()",
      icon: "⛓",
      group: "插入",
      keywords: ["link", "lianjie", "链接", "超链接"],
      run: (args) => {
        // 先清掉斜杠文本，再弹出地址输入框
        const view = args.view;
        view.dispatch(view.state.tr.delete(args.from, args.to));
        promptLinkUrl(view, "链接文本");
      },
    },
    {
      id: "date",
      title: "日期",
      icon: "▤",
      group: "插入",
      keywords: ["date", "riqi", "today", "日期", "今天"],
      run: (args) => {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const text = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        runWithDelete(args.view, args.from, args.to, insertText(text));
      },
    },
  ];

  return commands;
}

/** 匹配打分：完全命中 > 前缀命中 > 包含 > 标题包含 */
function matchScore(cmd: SlashCommand, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  for (const k of cmd.keywords) {
    if (k.toLowerCase() === q) return 100;
  }
  for (const k of cmd.keywords) {
    if (k.toLowerCase().startsWith(q)) return 80;
  }
  for (const k of cmd.keywords) {
    if (k.toLowerCase().includes(q)) return 60;
  }
  if (cmd.title.toLowerCase().includes(q)) return 40;
  return 0;
}

// ==================== 菜单 UI ====================

let menuEl: HTMLDivElement | null = null;
let currentView: EditorView | null = null;
let cleanupFns: Array<() => void> = [];
/** 当前过滤后的命令列表（与菜单项一一对应，供键盘索引） */
let visibleCommands: SlashCommand[] = [];
/** 命令表缓存（由 $prose 构建后写入） */
let commandTable: SlashCommand[] = [];

function closeMenu(): void {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
  menuEl?.remove();
  menuEl = null;
  currentView = null;
  visibleCommands = [];
}

/** 重新渲染菜单内容（过滤 + 高亮选中项） */
function renderMenu(view: EditorView, query: string, index: number): void {
  const menu = menuEl;
  if (!menu) return;

  const scored = commandTable
    .map((cmd, order) => ({ cmd, order, score: matchScore(cmd, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.score === a.score ? a.order - b.order : b.score - a.score))
    .map((x) => x.cmd);

  visibleCommands = scored;
  const active = Math.max(0, Math.min(index, Math.max(0, scored.length - 1)));

  menu.textContent = "";

  if (scored.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mt-slash-menu__empty";
    empty.textContent = "无匹配命令";
    menu.appendChild(empty);
    return;
  }

  // 按分组顺序渲染
  for (const group of GROUP_ORDER) {
    const items = scored.filter((c) => c.group === group);
    if (items.length === 0) continue;

    const title = document.createElement("div");
    title.className = "mt-slash-menu__group-title";
    title.textContent = group;
    menu.appendChild(title);

    for (const cmd of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mt-slash-menu__item";
      const globalIndex = scored.indexOf(cmd);
      if (globalIndex === active) btn.classList.add("is-active");

      const icon = document.createElement("span");
      icon.className = "mt-slash-menu__icon";
      if (cmd.id.startsWith("alert-")) icon.classList.add("is-alert");
      icon.textContent = cmd.icon;
      btn.appendChild(icon);

      const text = document.createElement("span");
      text.className = "mt-slash-menu__text";
      text.textContent = cmd.title;
      btn.appendChild(text);

      if (cmd.hint) {
        const hint = document.createElement("span");
        hint.className = "mt-slash-menu__hint";
        hint.textContent = cmd.hint;
        btn.appendChild(hint);
      }

      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        execCommand(view, globalIndex);
      });
      menu.appendChild(btn);
    }
  }

  // 选中项滚入可视区：必须只滚菜单自身，不能用 scrollIntoView。
  // scrollIntoView 会连带滚动所有祖先滚动容器——包括 .milkdown（编辑器滚动区），
  // 表现为「每输入一个字符编辑区就自动跳动」，干扰正常输入。
  const activeEl = menu.querySelector<HTMLElement>(".mt-slash-menu__item.is-active");
  if (activeEl) {
    const itemTop = activeEl.offsetTop;
    const itemBottom = itemTop + activeEl.offsetHeight;
    if (itemTop < menu.scrollTop) {
      menu.scrollTop = itemTop;
    } else if (itemBottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = itemBottom - menu.clientHeight;
    }
  }
}

/** 把菜单定位到 "/" 下方（视口坐标，贴边时收敛） */
function positionMenu(view: EditorView, from: number): void {
  const menu = menuEl;
  if (!menu) return;
  let left = 0;
  let top = 0;
  let anchorTop = 0;
  try {
    const coords = view.coordsAtPos(from);
    left = coords.left;
    top = coords.bottom + 6;
    anchorTop = coords.top;
  } catch {
    return; // 位置失效（文档已变更）时放弃本次定位
  }
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const maxLeft = window.innerWidth - width - 8;
  const maxTop = window.innerHeight - height - 8;
  // 下方空间不足时翻到 "/" 上方
  if (top > maxTop) top = Math.max(8, anchorTop - height - 6);
  menu.style.left = `${Math.max(8, Math.min(left, Math.max(8, maxLeft)))}px`;
  menu.style.top = `${Math.max(8, Math.min(top, Math.max(8, maxTop)))}px`;
}

function openMenu(view: EditorView, from: number): void {
  closeMenu();
  currentView = view;

  const host = document.querySelector<HTMLElement>(".milkdown") ?? document.body;
  const menu = document.createElement("div");
  menu.className = "mt-slash-menu";
  menu.style.left = "0px";
  menu.style.top = "0px";
  host.appendChild(menu);
  menuEl = menu;

  renderMenu(view, "", 0);
  positionMenu(view, from);

  const onDown = (e: MouseEvent) => {
    if (!menuEl || !menuEl.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
    }
  };
  const onScroll = () => {
    if (menuEl && currentView) positionMenu(currentView, slashFrom);
  };

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
}

// ==================== 插件状态 ====================

interface SlashState {
  active: boolean;
  /** "/" 的文档位置 */
  from: number;
  /** "/" 之后输入的过滤词 */
  query: string;
  /** 当前高亮项索引 */
  index: number;
}

const INACTIVE: SlashState = { active: false, from: 0, query: "", index: 0 };

type SlashMeta =
  | { type: "open"; from: number }
  | { type: "close" }
  | { type: "index"; index: number };

const slashKey = new PluginKey<SlashState>("mtSlash");

/** 从文档里读取 "/" 之后到光标的 query */
function readQuery(state: EditorState, from: number): string | null {
  const sel = state.selection;
  if (!sel.empty) return null;
  const head = sel.from;
  if (head <= from) return null;
  try {
    const text = state.doc.textBetween(from, head, undefined, "￼");
    // 必须是 "/" 开头、且后续无空白（输入空格即关闭菜单）
    if (!/^\/[^\s]*$/.test(text)) return null;
    if (text.length - 1 > MAX_QUERY) return null;
    return text.slice(1);
  } catch {
    return null;
  }
}

function execCommand(view: EditorView, index: number): void {
  const st = slashKey.getState(view.state);
  const cmd = visibleCommands[index] ?? commandTable[index];
  const from = st?.from ?? slashFrom;
  const to = view.state.selection.from;
  closeMenu();
  if (!cmd) return;
  // 关闭后先清掉插件状态，避免命令执行期间状态残留
  view.dispatch(view.state.tr.setMeta(slashKey, { type: "close" }));
  cmd.run({ ctx: currentCtx, view, from, to });
}

/**
 * 菜单激活时的导航 / 确认键处理（↑ ↓ 切换选中项，Enter / Tab 执行）。
 *
 * 抽成函数是因为有两个调用点：插件的 handleKeyDown，以及下方 window 捕获阶段的
 * keydown 兜底 —— gapcursor 同样吃方向键且注册在本插件之前，会抢先消费掉按键
 * （详见那里 window 监听的说明）。返回 true 表示按键已被菜单消费。
 */
function handleMenuNavKey(view: EditorView, key: string): boolean {
  const st = slashKey.getState(view.state);
  if (!st?.active) return false;

  if (key === "ArrowDown" || key === "ArrowUp") {
    const delta = key === "ArrowDown" ? 1 : -1;
    const total = visibleCommands.length;
    if (total === 0) return true;
    const next = (st.index + delta + total) % total;
    // 只派发 meta，重绘交给 view.update（与 query 变化走同一条路径）
    view.dispatch(
      view.state.tr.setMeta(slashKey, { type: "index", index: next })
    );
    return true;
  }
  if (key === "Enter" || key === "Tab") {
    if (visibleCommands.length === 0) return false;
    execCommand(view, st.index);
    return true;
  }
  return false;
}

// ==================== 插件本体 ====================

export const slashMenuPlugin = $prose((ctx) => {
  currentCtx = ctx;
  commandTable = buildCommands(ctx);

  return new Plugin<SlashState>({
    key: slashKey,
    state: {
      init: () => INACTIVE,
      apply(tr, prev, _old, newState) {
        const meta = tr.getMeta(slashKey) as SlashMeta | undefined;
        if (meta?.type === "close") return INACTIVE;
        if (meta?.type === "open") {
          slashFrom = meta.from;
          return { active: true, from: meta.from, query: "", index: 0 };
        }
        if (meta?.type === "index") {
          if (!prev.active) return prev;
          return { ...prev, index: Math.max(0, meta.index) };
        }
        if (!prev.active) return prev;

        // 文档变化后重新校验：query 失效或光标离开触发区则关闭
        const query = readQuery(newState, prev.from);
        if (query == null) return INACTIVE;
        return { ...prev, query };
      },
    },
    props: {
      handleTextInput(view, from, to, text) {
        // 刚退出（持续模式或按 Esc）：插入一个【不带 mark】的字符，打断继承。
        // 否则加粗/斜体这类包含型 mark 在退出后仍会继续生效，等于关不掉。
        if (skipMarkOnce && text.length === 1) {
          skipMarkOnce = false;
          exitedMarkTypes = [];
          const tr = view.state.tr.replaceWith(
            from,
            to,
            view.state.schema.text(text)
          );
          view.dispatch(tr.scrollIntoView());
          return true;
        }
        // 持续 mark 模式：给输入的每个字符显式补 mark。
        // 非包含型 mark（行内代码）在光标位于末尾时不会被继承，
        // 只靠 toggleMark 的话输入第一个字符后就会掉出代码样式。
        if (pendingMark && text.length === 1) {
          const $from = view.state.selection.$from;
          // 退出只认 Esc，所以光标可能已被方向键 / 点击挪到别处，而 pendingMark 还在。
          // 这里兜底：只在光标仍"贴着"这段格式时才补 mark，否则悄悄结束持续输入、
          // 本次按普通文本处理，免得把无关位置的字也染成代码 / 链接。
          // "贴着"有三种，缺一不可：
          //   1. 光标在格式内部；
          //   2. 紧接在格式末尾 —— 行内代码是 inclusive:false，末尾不继承，靠这条续上；
          //   3. 光标还停在持续输入的锚点上 —— 刚斜杠插入行内代码、一个字符都还没写时，
          //      前两条都不成立，只有它能对上；漏了就是"输入第一个字母就退出代码"。
          const attached =
            from === pendingAnchor ||
            pendingMark.type.isInSet($from.marks()) ||
            Boolean(
              $from.nodeBefore && pendingMark.type.isInSet($from.nodeBefore.marks)
            );
          if (attached) {
            const tr = view.state.tr.insertText(text, from, to);
            // 复用同一个 mark 实例，链接的 href 等属性才不会丢
            tr.addMark(from, from + text.length, pendingMark);
            view.dispatch(tr.scrollIntoView());
            pendingAnchor = from + text.length; // 锚点跟着往下走
            return true;
          }
          // 已不在格式范围内：结束持续输入。不 arm skipMarkOnce —— 光标本来就不在
          // 格式里，交给 ProseMirror 默认输入逻辑即可。
          pendingMark = null;
          pendingAnchor = -1;
          hideContinuousHint();
        }
        // 光标已在该格式内部时，敲一个标记字符（= 或 ~）即表示结束：
        // 不写入这个字符，并让后续输入脱离该 mark，源码保持干净的 ==文字==。
        if (!pendingMark) {
          const $from = view.state.selection.$from;
          for (const pair of PAIR_MARKS) {
            if (text !== pair.char) continue;
            const markType = view.state.schema.marks[pair.name];
            if (!markType || !markType.isInSet($from.marks())) break;
            exitedMarkTypes = [markType];
            skipMarkOnce = true;
            hideContinuousHint();
            return true; // 吞掉这个字符，不写进正文
          }
        }

        // 只在段落开头触发：避免正文里 C:/Users、1/2 之类的误弹
        if (text !== "/") return false;
        // 中文输入法合成期间不上屏，不触发
        if (imeComposing) return false;
        const $from = view.state.selection.$from;
        // 在段落 / 标题行开头触发。代码块里输入 "/" 是字面量，照旧不弹菜单；
        // 标题行开头（"#" 之前）也允许弹 —— 文档顶部紧跟 frontmatter 时，
        // 光标常落在标题行首，用户期望直接 "/" 插入块。
        const parentName = $from.parent.type.name;
        if (parentName !== "paragraph" && parentName !== "heading") return false;
        if ($from.parentOffset !== 0) return false;
        // 让 "/" 正常插入，插入后再打开菜单（此时文档里已有 "/"）。
        // 这里只派发 meta，菜单 DOM 交由下方 view.update 统一创建，避免重复创建。
        setTimeout(() => {
          const st = slashKey.getState(view.state);
          if (st?.active) return;
          slashFrom = from;
          view.dispatch(view.state.tr.setMeta(slashKey, { type: "open", from }));
        }, 0);
        return false;
      },
      handleKeyDown(_view, event) {
        const view = _view;
        const st = slashKey.getState(view.state);
        // 退出格式只认 Esc：方向键 / Home / End / Enter / Tab / 点别处一律不打断
        // 正在输入的格式，否则在粗体或行内代码里挪光标改个错字，格式就被打断了。
        // 菜单打开时 Esc 先让位给下面的"关闭菜单"（!st?.active 守卫）。
        if (event.key === "Escape" && !st?.active) {
          // 不挑来源 —— 斜杠命令、Ctrl+B、**text** 输入规则产生的格式都靠它退出。
          // 之前只有斜杠命令进入的能退，手动加的格式就成了"进了就出不来"。
          clearPendingMark(view); // 行内代码：停止逐字符补 mark
          const marks = activeMarks(view.state); // 包含型 mark：打断自动继承
          if (marks.length > 0) {
            exitedMarkTypes = marks.map((m) => m.type);
            skipMarkOnce = true;
            clearStoredMarks(view, exitedMarkTypes);
          }
        }
        if (!st?.active) return false;

        if (event.key === "Escape") {
          view.dispatch(view.state.tr.setMeta(slashKey, { type: "close" }));
          closeMenu();
          return true;
        }
        return handleMenuNavKey(view, event.key);
      },
    },
    view() {
      return {
        update(view, prevState) {
          const st = slashKey.getState(view.state);
          const prevSt = slashKey.getState(prevState);
          if (!st?.active) {
            if (prevSt?.active) closeMenu();
            return;
          }
          if (!menuEl) {
            openMenu(view, st.from);
            return;
          }
          // query 变化（过滤结果变了）或选中项变化时重渲染
          if (
            !prevSt?.active ||
            prevSt.query !== st.query ||
            prevSt.index !== st.index
          ) {
            renderMenu(view, st.query, st.index);
            positionMenu(view, st.from);
          }
        },
        destroy() {
          closeMenu();
        },
      };
    },
  });
});

// ==================== 供右键格式菜单复用（format-menu.ts） ====================
// 行内格式已从 "/" 移到右键菜单，但持续输入状态机仍挂在本插件的
// handleTextInput / handleKeyDown 上（与菜单是否打开无关）。右键菜单只需
// "启动"持续输入，后续逐字符补 mark、Esc 退出等仍由这里接管，行为完全一致。

/** 对当前选区/光标应用行内格式（不删除文本，与 / 命令行为一致）。
 * 非空选区 = toggle 该格式；空选区 = 开启持续输入（后续字符带格式，
 * 按 Esc 退出）。inclusive:false 的 mark（如行内代码）进入逐字符补 mark
 * 的持续模式，由本插件的 handleTextInput 托管。 */
export function applyFormatMark(
  view: EditorView,
  markName: string,
  label: string
): void {
  const type = view.state.schema.marks[markName];
  if (!type) return;
  view.focus();
  // 只有空选区才进入持续输入：非空选区 toggle 是一次性修改，改完即生效，
  // 弹"输入中"气泡既与事实不符，还会作为旧气泡停驻在原地误导用户。
  const { empty } = view.state.selection;
  if (empty) {
    // 无选区：开启持续输入。本项目所有 format mark 均为 inclusive:true
    // （行内代码在 plugins.ts 被覆盖成 inclusive:true），故恒走
    // "强制写 storedMarks" 分支；下方 inclusive===false 分支为防御性兜底，
    // 当前 schema 下不会命中。
    // 为何强制写而非 toggleMark：行首右键时 posAtCoords 常落在块边界
    // （上一块末尾），$from.marks() 带着前一段的尾格式，markIsActive 会误判
    // 为"已激活"而反向删除，导致打字不带格式。强制写可避免该误判，
    // 且 inclusive:true 让首字符后输入自然继承、不会断。
    if (type.spec.inclusive === false) {
      startContinuousMark(type)(view.state, view.dispatch);
    } else {
      const base = view.state.storedMarks ?? view.state.selection.$from.marks();
      const next = type.isInSet(base) ? base : base.concat(type.create());
      view.dispatch(view.state.tr.setStoredMarks(next));
    }
    showContinuousHint(view, label);
    return;
  }
  const cmd =
    type.spec.inclusive === false ? startContinuousMark(type) : toggleMark(type);
  cmd(view.state, view.dispatch);
}

/** 供右键菜单复用：打开宿主（App.vue）注册的图片选择对话框，插图到 pos */
export function openImagePicker(view: EditorView, pos: number): void {
  actionHandler?.("image", view, pos);
}

/** 供右键菜单复用：在光标处插入占位链接文本并弹地址输入框（行为同 /链接） */
export function promptLinkUrlDialog(view: EditorView, label: string): void {
  promptLinkUrl(view, label);
}
