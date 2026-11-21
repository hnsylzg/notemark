/*
 * Typora-style inline mark editing.
 *
 * A mark normally renders as <strong>, <em>, <code>, etc. While its source is
 * being edited, the document keeps the mark but decoration widgets display the
 * Markdown delimiters around it. Keeping delimiters out of the document avoids
 * transient escaped markers in autosave/recovery output.
 */
import {
  Fragment,
  type Mark,
  type MarkType,
  type Node as ProseMirrorNode,
} from "@milkdown/prose/model";
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
import { $prose } from "@milkdown/utils";
import {
  EDITABLE_INLINE_HTML_MARK_TAGS,
  INLINE_HTML_MARK_NAME,
} from "./inline-html-mark";
import {
  LINK_REFERENCE_DEFINITION_NAME,
  LINK_REFERENCE_MARK_NAME,
  linkReferenceDefinitionFromAttrs,
  normalizeLinkReferenceIdentifier,
} from "./link-reference-definition";

export interface MarkSourceSession {
  markName: string;
  /** Full source range, including opening and closing delimiters. */
  from: number;
  to: number;
  attrs?: Readonly<Record<string, unknown>>;
  /**
   * 会话期间是否发生过真实的文档改动（用户输入/删除）。
   *
   * 打开会话时会把 `**`、反引号、`<mark>` 等分隔符作为【真实文本】写进文档，
   * 关闭时再按原文反推标记。反推并非在所有形态下都精确（行内代码里含反引号/
   * 换行、行内代码外层还套着加粗等），所以「没有任何输入」的会话不反推，
   * 直接把两段分隔符删掉，文档就精确回到打开前的状态。
   */
  dirty?: boolean;
  /**
   * 这次会话是否「只是在已有标记上打开源码」。
   *
   * 只有这种会话才允许走「只删分隔符」的关闭路径：点中已有加粗、或用光标
   * 进入已有标记，打开前文档里就有这个标记。反过来，选中文字后按 Ctrl+B 是
   * 【新增】标记，必须走原来的解析逻辑，否则会把用户的格式化操作撤销掉。
   */
  restorable?: boolean;
}

interface MarkSyntax {
  open: string;
  close: string;
  selector: string;
}

export const MARK_SOURCE_SYNTAX: Readonly<Record<string, MarkSyntax>> = {
  [LINK_REFERENCE_MARK_NAME]: {
    open: "[",
    close: "]",
    selector: "a[data-reference-label]",
  },
  link: {
    open: "[",
    close: "]",
    selector: "a[href]:not([data-reference-label])",
  },
  strong: { open: "**", close: "**", selector: "strong" },
  emphasis: { open: "*", close: "*", selector: "em" },
  strike_through: { open: "~~", close: "~~", selector: "del" },
  inlineCode: { open: "`", close: "`", selector: "code" },
  highlight: { open: "==", close: "==", selector: "mark.md-highlight" },
  underline: { open: "<u>", close: "</u>", selector: "u" },
  superscript: { open: "^", close: "^", selector: "sup" },
  subscript: { open: "~", close: "~", selector: "sub" },
  [INLINE_HTML_MARK_NAME]: {
    open: "",
    close: "",
    selector: "[data-inline-html-mark]",
  },
};

const SOURCE_TEXTBLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6";

type MarkSourceMeta =
  | { type: "start"; session: MarkSourceSession }
  | { type: "close" };

export const markSourceKey =
  new PluginKey<MarkSourceSession | null>("mtMarkSource");

function markTypeFor(
  state: EditorState,
  markName: string
): MarkType | null {
  return state.schema.marks[markName] ?? null;
}

function rangeIsFullyMarked(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  type: MarkType
): boolean {
  let complete = true;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && !type.isInSet(node.marks)) complete = false;
  });
  return complete;
}

function storedMarksWithout(
  state: EditorState,
  type: MarkType
): readonly Mark[] {
  return (state.storedMarks ?? state.selection.$from.marks()).filter(
    (mark) => mark.type !== type
  );
}

function storedMarksWith(
  state: EditorState,
  type: MarkType,
  attrs: Readonly<Record<string, unknown>> = {}
): readonly Mark[] {
  const mark = type.create(attrs);
  if (type.name === "inlineCode") return [mark];
  const base = state.storedMarks ?? state.selection.$from.marks();
  return base.filter((current) => current.type !== type).concat(mark);
}

/**
 * Find the contiguous marked text range containing (or touching) pos.
 * Adjacent text nodes with the same mark are treated as one range because
 * other inline marks may split the ProseMirror text node.
 */
function markRangeAt(
  doc: ProseMirrorNode,
  pos: number,
  type: MarkType
): { from: number; to: number } | null {
  const safe = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(safe);
  let depth = $pos.depth;
  while (depth > 0 && !$pos.node(depth).isTextblock) depth -= 1;
  if (depth === 0) return null;

  let from = -1;
  let to = -1;
  doc.nodesBetween($pos.start(depth), $pos.end(depth), (node, start) => {
    if (!node.isText || !type.isInSet(node.marks)) return;
    const end = start + node.nodeSize;
    if (start <= safe && safe <= end) {
      from = from < 0 ? start : Math.min(from, start);
      to = Math.max(to, end);
    } else if (from >= 0 && start === to) {
      to = end;
    }
  });
  return from >= 0 ? { from, to } : null;
}

function markAttrsAtRange(
  doc: ProseMirrorNode,
  type: MarkType,
  from: number,
  to: number
): Readonly<Record<string, unknown>> | undefined {
  let attrs: Readonly<Record<string, unknown>> | undefined;
  doc.nodesBetween(from, Math.max(to, from + 1), (node) => {
    if (!node.isText || attrs) return;
    const mark = type.isInSet(node.marks);
    if (mark && Object.keys(mark.attrs).length > 0) {
      attrs = { ...mark.attrs };
    }
  });
  return attrs;
}

function selectionInsideSession(
  state: EditorState,
  session: MarkSourceSession
): boolean {
  const selection = state.selection;
  return selection.from >= session.from && selection.to <= session.to;
}

function delimitersFor(
  markName: string,
  attrs: Readonly<Record<string, unknown>> | undefined
): { open: string; close: string } | null {
  if (markName === INLINE_HTML_MARK_NAME) {
    const open = String(attrs?.open ?? "");
    const close = String(attrs?.close ?? "");
    return open && close ? { open, close } : null;
  }
  if (markName === LINK_REFERENCE_MARK_NAME) {
    const label = String(
      attrs?.label ?? attrs?.identifier ?? ""
    );
    return label ? { open: "[", close: `][${label}]` } : null;
  }
  if (markName !== "link") {
    const syntax = MARK_SOURCE_SYNTAX[markName];
    return syntax ? { open: syntax.open, close: syntax.close } : null;
  }
  const href = String(attrs?.href ?? "");
  const title = String(attrs?.title ?? "").replaceAll('"', '\\"');
  return {
    open: "[",
    close: `](${href}${title ? ` "${title}"` : ""})`,
  };
}

function parseInlineHtmlSource(
  source: string
): {
  tag: string;
  content: string;
  openLength: number;
  closeLength: number;
  attrs: Readonly<Record<string, unknown>>;
} | null {
  const open = /^<([a-z][a-z0-9-]*)(?:\s[^>]*)?>/i.exec(source);
  if (!open) return null;
  const close = new RegExp(`</${open[1]}\\s*>$`, "i").exec(source);
  if (!close || close.index < open[0].length) return null;
  return {
    tag: open[1].toLowerCase(),
    content: source.slice(open[0].length, close.index),
    openLength: open[0].length,
    closeLength: close[0].length,
    attrs: {
      open: open[0],
      close: close[0],
    },
  };
}

function isCompleteEditableInlineHtmlSource(source: string): boolean {
  const parsed = parseInlineHtmlSource(source);
  return parsed !== null && EDITABLE_INLINE_HTML_MARK_TAGS.has(parsed.tag);
}

function openSourceSessionTransaction(
  state: EditorState,
  markName: string,
  from: number,
  to: number,
  attrs: Readonly<Record<string, unknown>> | undefined,
  caret: number,
  selectContent = false,
  /** 是否「在已有标记上打开源码」（见 MarkSourceSession.restorable） */
  restorable = true
): Transaction | null {
  const type = markTypeFor(state, markName);
  const delimiters = delimitersFor(markName, attrs);
  if (!type || !delimiters) return null;

  const safeFrom = Math.max(1, Math.min(from, state.doc.content.size));
  const safeTo = Math.max(safeFrom, Math.min(to, state.doc.content.size));
  let tr = state.tr.insertText(delimiters.open, safeFrom);
  tr = tr.insertText(
    delimiters.close,
    safeTo + delimiters.open.length
  );
  const sourceTo = safeTo + delimiters.open.length + delimiters.close.length;
  tr = tr.removeMark(safeFrom, sourceTo, type);

  const contentFrom = safeFrom + delimiters.open.length;
  const contentTo = safeTo + delimiters.open.length;
  if (contentFrom < contentTo) {
    tr = tr.addMark(
      contentFrom,
      contentTo,
      type.create(attrs)
    );
  }
  // Preserve the user's entry side. Entering from before/after a mark must not
  // push the caret into the text; only an interior click maps inside content.
  const safeCaret =
    safeFrom < safeTo && caret <= safeFrom
      ? safeFrom
      : safeFrom < safeTo && caret >= safeTo
        ? sourceTo
        : contentFrom +
          Math.max(0, Math.min(caret - from, contentTo - contentFrom));
  tr = tr.setSelection(
    safeFrom !== safeTo && selectContent
      ? TextSelection.create(tr.doc, contentFrom, contentTo)
      : TextSelection.create(tr.doc, safeCaret)
  );
  tr = tr.setStoredMarks(storedMarksWith(state, type, attrs));
  if (restorable) {
    // Opening an existing mark is only a transient source view. Its temporary
    // delimiters must not become a phantom undo step when the user clicks away.
    tr = tr.setMeta("addToHistory", false);
  }
  return tr.setMeta(markSourceKey, {
    type: "start",
    session: { markName, from: safeFrom, to: sourceTo, attrs, restorable },
  } satisfies MarkSourceMeta);
}

/**
 * Build the command transaction for the toolbar or keyboard shortcut.
 *
 * - Non-empty selection: add the mark and immediately show its delimiters.
 * - Empty caret: show two widgets with the caret between them.
 * - Fully marked selection: toggle the mark off.
 * - Caret inside an existing marked range: reopen that range for source edit.
 */
export function createMarkSourceTransaction(
  state: EditorState,
  markName: string
): Transaction | null {
  const type = markTypeFor(state, markName);
  if (!type || !MARK_SOURCE_SYNTAX[markName]) return null;

  const selection = state.selection;
  if (selection.empty) {
    const existing = markRangeAt(state.doc, selection.from, type);
    const from = existing?.from ?? selection.from;
    const to = existing?.to ?? selection.from;
    const attrs = existing
      ? markAttrsAtRange(state.doc, type, from, to)
      : markName === "link"
        ? { href: "" }
        : undefined;
    return openSourceSessionTransaction(
      state,
      markName,
      from,
      to,
      attrs,
      selection.from
    );
  }

  if (rangeIsFullyMarked(state.doc, selection.from, selection.to, type)) {
    return state.tr
      .removeMark(selection.from, selection.to, type)
      .setStoredMarks(storedMarksWithout(state, type))
      .setMeta(markSourceKey, { type: "close" } satisfies MarkSourceMeta);
  }

  const attrs = markAttrsAtRange(
    state.doc,
    type,
    selection.from,
    selection.to
  );
  if (markName === "link" && !attrs) return null;
  return openSourceSessionTransaction(
    state,
    markName,
    selection.from,
    selection.to,
    attrs,
    selection.to,
    true,
    // 选区还未被标记：这次打开是在【新增】标记（工具栏 / Ctrl+B），
    // 关闭时必须保留格式化结果，不能整段还原。
    false
  );
}

export function startMarkSource(
  view: EditorView,
  markName: string
): boolean {
  if (markSourceKey.getState(view.state)) return false;
  const tr = createMarkSourceTransaction(view.state, markName);
  if (!tr) return false;
  // The caret already has a user-chosen position. Scrolling here can visibly
  // jump to another line, especially after a right-click or blur/refocus.
  view.dispatch(tr);
  view.focus();
  return true;
}

function activateMarkRange(
  view: EditorView,
  markName: string,
  from: number,
  to: number,
  caret: number
): boolean {
  const type = markTypeFor(view.state, markName);
  if (!type || from > to) return false;
  if (
    from < to &&
    view.state.doc.textBetween(from, to, "", "") === ""
  ) {
    return false;
  }
  const attrs = markAttrsAtRange(view.state.doc, type, from, to);
  if (markName === "link" && !attrs) return false;
  const tr = openSourceSessionTransaction(
    view.state,
    markName,
    from,
    to,
    attrs,
    caret
  );
  if (!tr) return false;
  view.dispatch(tr);
  view.focus();
  return true;
}

function activateLinkAtPosition(
  view: EditorView,
  pos: number
): boolean {
  for (const markName of [
    LINK_REFERENCE_MARK_NAME,
    "link",
  ]) {
    const type = markTypeFor(view.state, markName);
    if (!type) continue;
    const range =
      markRangeAt(view.state.doc, pos, type) ??
      markRangeAt(view.state.doc, Math.max(1, pos - 1), type);
    if (!range) continue;
    const attrs = markAttrsAtRange(
      view.state.doc,
      type,
      range.from,
      range.to
    );
    if (!attrs) continue;
    if (
      activateMarkRange(
        view,
        markName,
        range.from,
        range.to,
        pos
      )
    ) {
      return true;
    }
  }
  return false;
}

export function startMarkSourceRange(
  view: EditorView,
  markName: string,
  from: number,
  to: number,
  caret = to
): boolean {
  return activateMarkRange(view, markName, from, to, caret);
}

/**
 * 关闭一个「只打开、没有任何输入」的会话：删掉打开时插入的两段分隔符。
 *
 * 打开会话时 mark 已经从分隔符区间移到了内容区间，所以只要删除分隔符文本，
 * 文档就精确回到打开前的状态，不需要解析、也不会碰到其它 mark。
 *
 * 用 delete 而不是整段替换文档：整段替换会让 ProseMirror 丢失位置映射，
 * 只能按记录的光标复位，于是用户用方向键把光标移出去时会被弹回原位。
 */
function closeSessionWithoutEdit(
  state: EditorState,
  session: MarkSourceSession
): Transaction {
  const delimiters = delimitersFor(session.markName, session.attrs);
  let tr = state.tr;
  if (delimiters) {
    tr = tr.delete(session.to - delimiters.close.length, session.to);
    tr = tr.delete(session.from, session.from + delimiters.open.length);
  }
  return tr
    .setMeta("addToHistory", false)
    .setMeta(markSourceKey, { type: "close" });
}

function finishMarkSourceTransaction(
  state: EditorState,
  session: MarkSourceSession
): Transaction {
  // 只是点开又点走（会话期间没有任何输入）：删掉分隔符即可精确还原。
  // 不走下面的正则反推——行内代码含反引号/换行、或外层还套着加粗时，
  // 反推会失败并把插入的分隔符留在正文里，于是「点一下」就变成了真实修改。
  if (session.restorable !== false && !session.dirty) {
    return closeSessionWithoutEdit(state, session);
  }
  const originalType = markTypeFor(state, session.markName);
  const source = state.doc.textBetween(
    session.from,
    session.to,
    "\n",
    "\n"
  );
  const delimiters = delimitersFor(session.markName, session.attrs);
  let content = "";
  let attrs = session.attrs;
  let valid = false;
  let openLength = 0;
  let closeLength = 0;
  let finalType = originalType;

  const parsedInlineHtml =
    session.markName === INLINE_HTML_MARK_NAME
      ? parseInlineHtmlSource(source)
      : null;
  if (parsedInlineHtml && originalType) {
    content = parsedInlineHtml.content;
    openLength = parsedInlineHtml.openLength;
    closeLength = parsedInlineHtml.closeLength;
    attrs = parsedInlineHtml.attrs;
    valid = true;
  }

  const parsed = valid ? null : findPlainInlineMatch(source);
  if (
    parsed &&
    parsed.start === 0 &&
    parsed.end === source.length
  ) {
    const parsedType = markTypeFor(state, parsed.markName);
    if (parsedType) {
      finalType = parsedType;
      content = parsed.content;
      openLength = parsed.contentStart;
      closeLength = source.length - parsed.contentEnd;
      attrs =
        parsed.attrs ??
        (parsed.markName === session.markName
          ? session.attrs
          : undefined);
      if (finalType.name === LINK_REFERENCE_MARK_NAME) {
        const identifier = normalizeLinkReferenceIdentifier(
          String(
            attrs?.identifier ??
              parsed.attrs?.identifier ??
              ""
          )
        );
        let definitionUrl = "";
        let definitionTitle: string | null = null;
        state.doc.descendants((node) => {
          if (node.type.name !== LINK_REFERENCE_DEFINITION_NAME) {
            return true;
          }
          const definition = linkReferenceDefinitionFromAttrs(node.attrs);
          if (!definition || definition.identifier !== identifier) {
            return true;
          }
          definitionUrl = definition.url;
          definitionTitle = definition.title;
          return false;
        });
        attrs = {
          ...session.attrs,
          ...attrs,
          identifier,
          label: String(attrs?.label ?? identifier),
          url: definitionUrl || String(session.attrs?.url ?? ""),
          title:
            definitionTitle ??
            (typeof session.attrs?.title === "string"
              ? session.attrs.title
              : null),
          referenceType: String(attrs?.referenceType ?? "full"),
        };
      }
      valid = true;
    }
  }
  if (
    !valid &&
    delimiters &&
    source === delimiters.open + delimiters.close &&
    originalType
  ) {
    openLength = delimiters.open.length;
    closeLength = delimiters.close.length;
    valid = true;
  }

  let tr = state.tr;
  if (valid && finalType) {
    tr = tr.delete(session.to - closeLength, session.to);
    tr = tr.delete(session.from, session.from + openLength);
    if (content) {
      const contentEnd = session.from + content.length;
      if (originalType && originalType !== finalType) {
        tr = tr.removeMark(
          session.from,
          contentEnd,
          originalType
        );
      }
      if (finalType.name === "inlineCode") {
        for (const markType of Object.values(tr.doc.type.schema.marks)) {
          if (markType !== finalType) {
            tr = tr.removeMark(
              session.from,
              contentEnd,
              markType
            );
          }
        }
      }
      tr = tr.addMark(
        session.from,
        contentEnd,
        finalType.create(attrs)
      );
    }
  } else if (originalType) {
    // Incomplete delimiters are valid user text while editing. Keep the raw
    // source (for example `**bold*`) instead of deleting the remaining marker
    // characters and making the whole construct appear swallowed.
    tr = tr.removeMark(session.from, session.to, originalType);
  }
  if (finalType) {
    tr = tr.setStoredMarks(storedMarksWithout(state, finalType));
  }
  if (session.restorable !== false) {
    // 「点中已有标记」的会话里，关闭只是把临时分隔符换回原来的 mark，
    // 并不是一次新的格式化操作：它不该单独占一条撤销记录。否则撤销时
    // 会先把分隔符还原成正文（`****粗体****`），而那条记录又被用完，
    // 正文里的 `**` 就再也撤不掉了。用户真正输入的内容另有自己的记录。
    tr = tr.setMeta("addToHistory", false);
  }
  return tr.setMeta(markSourceKey, {
    type: "close",
  } satisfies MarkSourceMeta);
}

function closeMarkSource(view: EditorView): void {
  const session = markSourceKey.getState(view.state);
  if (!session) return;
  view.dispatch(finishMarkSourceTransaction(view.state, session));
}

/** Finish the active inline source session before leaving visual editing. */
export function closeActiveMarkSource(view: EditorView): boolean {
  if (!markSourceKey.getState(view.state)) return false;
  closeMarkSource(view);
  return true;
}

export function sourceSessionBlockElement(
  view: EditorView,
  session: MarkSourceSession
): HTMLElement | null {
  try {
    const at = view.domAtPos(Math.min(session.from + 1, session.to));
    const node =
      at.node.nodeType === 3
        ? at.node.parentElement
        : (at.node as Element);
    return node?.closest<HTMLElement>(SOURCE_TEXTBLOCK_SELECTOR) ?? null;
  } catch {
    return null;
  }
}

function clickedMark(
  target: Element | null
): { markName: string; element: HTMLElement } | null {
  if (!target) return null;
  // 代码块里的 <code>（CodeMirror 编辑器或占位 <pre><code>）不是行内代码。
  // 误判会把代码块正文当成行内代码插入反引号，而关闭时的正则又匹配不上
  // （正文里有换行/反引号），反引号就永久留在代码里——点一下即脏。
  if (target.closest("pre, .cm-editor, .milkdown-code-block-placeholder")) {
    return null;
  }
  const inlineHtml = target.closest<HTMLElement>(
    "[data-inline-html-mark]"
  );
  if (inlineHtml) {
    return { markName: INLINE_HTML_MARK_NAME, element: inlineHtml };
  }
  let found: { markName: string; element: HTMLElement } | null = null;
  for (const [markName, syntax] of Object.entries(MARK_SOURCE_SYNTAX)) {
    const element = target.closest<HTMLElement>(syntax.selector);
    if (element && (!found || found.element.contains(element))) {
      found = { markName, element };
    }
  }
  return found;
}

interface PlainInlineMatch {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  content: string;
  markName: string;
  attrs?: Readonly<Record<string, unknown>>;
}

const PLAIN_INLINE_PATTERNS: ReadonlyArray<{
  markName: string;
  pattern: RegExp;
}> = [
  { markName: "strong", pattern: /\*\*(?=\S)([\s\S]*?\S)\*\*/ },
  { markName: "strike_through", pattern: /~~(?=\S)([\s\S]*?\S)~~/ },
  { markName: "highlight", pattern: /==(?=\S)([\s\S]*?\S)==/ },
  { markName: "inlineCode", pattern: /`([^`\n]+)`/ },
  { markName: "underline", pattern: /<u>(.+?)<\/u>/i },
  {
    markName: "emphasis",
    pattern:
      /(?<!\*)\*(?!\*)(?=\S)([^*\n]*?\S)(?<!\*)\*(?!\*)/,
  },
  { markName: "superscript", pattern: /\^(?=\S)([^\^\n]*?\S)\^/ },
  {
    markName: "subscript",
    pattern: /(?<!~)~(?=\S)([^~\n]*?\S)(?<!~)~(?!~)/,
  },
];

const INLINE_SYNTAX_INPUT_CHARS = new Set([
  "*",
  "~",
  "=",
  "`",
  "^",
  "<",
  ">",
  "/",
  "[",
  "]",
  "(",
  ")",
]);

function findPlainInlineMatch(
  text: string,
  focus?: number,
  includeMath = false
): PlainInlineMatch | null {
  let found: PlainInlineMatch | null = null;
  const consider = (candidate: PlainInlineMatch): void => {
    if (
      focus != null &&
      (focus < candidate.start || focus > candidate.end + 1)
    ) {
      return;
    }
    if (
      !found ||
      candidate.start < found.start ||
      (candidate.start === found.start && candidate.end > found.end)
    ) {
      found = candidate;
    }
  };

  const inlineHtmlPattern =
    /<([a-z][a-z0-9-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi;
  for (const match of text.matchAll(inlineHtmlPattern)) {
    if (match.index == null) continue;
    const tag = match[1].toLowerCase();
    if (tag === "u" || !EDITABLE_INLINE_HTML_MARK_TAGS.has(tag)) continue;
    const parsed = parseInlineHtmlSource(match[0]);
    if (!parsed) continue;
    consider({
      start: match.index,
      end: match.index + match[0].length,
      contentStart: match.index + parsed.openLength,
      contentEnd:
        match.index + match[0].length - parsed.closeLength,
      content: parsed.content,
      markName: INLINE_HTML_MARK_NAME,
      attrs: parsed.attrs,
    });
  }

  if (includeMath) {
    const mathPattern = /\$([^$\n]+)\$/g;
    for (const match of text.matchAll(mathPattern)) {
      if (match.index == null || !match[1]) continue;
      consider({
        start: match.index,
        end: match.index + match[0].length,
        contentStart: match.index + 1,
        contentEnd: match.index + match[0].length - 1,
        content: match[1],
        markName: "math_inline",
      });
    }
  }

  const linkPattern =
    /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"((?:[^"\\]|\\.)*)")?\)/g;
  for (const link of text.matchAll(linkPattern)) {
    if (link.index == null) continue;
    consider({
      start: link.index,
      end: link.index + link[0].length,
      contentStart: link.index + 1,
      contentEnd: link.index + 1 + link[1].length,
      content: link[1],
      markName: "link",
      attrs: {
        href: link[2],
        title: (link[3] ?? "").replaceAll('\\"', '"'),
      },
    });
  }
  const referenceLinkPattern =
    /(?<!!)\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
  for (const reference of text.matchAll(referenceLinkPattern)) {
    if (reference.index == null) continue;
    const identifier = (
      reference[2] || reference[1]
    ).trim();
    if (!identifier) continue;
    consider({
      start: reference.index,
      end: reference.index + reference[0].length,
      contentStart: reference.index + 1,
      contentEnd:
        reference.index + 1 + reference[1].length,
      content: reference[1],
      markName: LINK_REFERENCE_MARK_NAME,
      attrs: {
        identifier: normalizeLinkReferenceIdentifier(identifier),
        label: identifier,
        referenceType: reference[2] ? "full" : "collapsed",
      },
    });
  }
  for (const { markName, pattern } of PLAIN_INLINE_PATTERNS) {
    const globalPattern = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
    );
    for (const match of text.matchAll(globalPattern)) {
      if (match.index == null || !match[1]) continue;
      consider({
        start: match.index,
        end: match.index + match[0].length,
        contentStart: match.index + match[0].indexOf(match[1]),
        contentEnd:
          match.index + match[0].indexOf(match[1]) + match[1].length,
        content: match[1],
        markName,
      });
    }
  }
  return found;
}

function previewInlineDecorations(state: EditorState): DecorationSet {
  if (markSourceKey.getState(state)) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (decorations.length > 0) return false;
    if (!node.isTextblock || node.content.size === 0) return true;
    if (node.type.spec.code) return true;

    let runs: Array<{ start: number; text: string }> = [];
    const previewRuns = (): boolean => {
      if (runs.length === 0) return false;
      const text = runs.map((run) => run.text).join("");
      const match = findPlainInlineMatch(text);
      if (!match) return false;
      const sourceStart = runs[0].start + match.start;
      const sourceEnd = runs[0].start + match.end;
      const selection = state.selection;
      if (
        selection.from > sourceEnd ||
        selection.to < sourceStart
      ) {
        return false;
      }
      const contentStart = runs[0].start + match.contentStart;
      const contentEnd = runs[0].start + match.contentEnd;
      decorations.push(
        Decoration.inline(contentStart, contentEnd, {
          class:
            `mt-inline-source-preview ` +
            `mt-inline-source-preview--${match.markName}`,
        })
      );
      return true;
    };

    let offset = pos + 1;
    node.forEach((child) => {
      if (decorations.length > 0) return;
      if (child.isText && child.text) {
        runs.push({ start: offset, text: child.text });
      } else {
        if (previewRuns()) return;
        runs = [];
      }
      offset += child.nodeSize;
    });
    if (decorations.length === 0) previewRuns();
    return decorations.length === 0;
  });
  return DecorationSet.create(state.doc, decorations);
}

export function autoFormatInlineMarkdown(
  state: EditorState,
  respectSelection = true,
  scope?: { blockPos: number; focusOffset: number }
): Transaction | null {
  let tr = state.tr;
  let changed = false;

  const buildSlice = (
    runs: Array<{
      node: ProseMirrorNode;
      start: number;
      end: number;
      text: string;
    }>,
    from: number,
    to: number,
    target?: MarkType,
    attrs?: Readonly<Record<string, unknown>>
  ): ProseMirrorNode[] => {
    const nodes: ProseMirrorNode[] = [];
    let offset = 0;
    for (const run of runs) {
      const runStart = offset;
      const runEnd = offset + run.text.length;
      offset = runEnd;
      const start = Math.max(from, runStart);
      const end = Math.min(to, runEnd);
      if (start >= end) continue;
      const text = run.text.slice(start - runStart, end - runStart);
      let marks = [...run.node.marks];
      if (target) {
        marks = marks.filter((mark) => mark.type !== target);
        if (target.name === "inlineCode") marks = [];
        marks.push(target.create(attrs));
      }
      nodes.push(state.schema.text(text, marks));
    }
    return nodes;
  };

  // Interactive auto-formatting is scoped to the textblock where the user is
  // working. Scanning the whole document on blur can rewrite untouched literal
  // Markdown such as escaped backticks in a format-test document.
  const { $from } = state.selection;
  const node =
    scope == null ? $from.parent : state.doc.nodeAt(scope.blockPos);
  if (
    (scope == null && $from.depth === 0) ||
    !node ||
    !node.isTextblock ||
    node.content.size === 0 ||
    node.type.spec.code
  ) {
    return null;
  }

  let runs: Array<{
    node: ProseMirrorNode;
    start: number;
    end: number;
    text: string;
  }> = [];
  const tryFormatRuns = (): boolean => {
    if (runs.length === 0) return false;
    const text = runs.map((run) => run.text).join("");
    const targetStart = scope ? scope.blockPos + 1 : $from.start($from.depth);
    const selectionInsideTarget =
      state.selection.from >= targetStart &&
      state.selection.to <= targetStart + node.content.size;
    const focusPosition =
      scope && !selectionInsideTarget
        ? targetStart + scope.focusOffset
        : state.selection.from;
    const focus = focusPosition - runs[0].start;
    const match = findPlainInlineMatch(text, focus, true);
    const type = markTypeFor(state, match?.markName ?? "");
    const mathType = state.schema.nodes.math_inline;
    if (
      !match ||
      (match.markName === "math_inline" ? !mathType : !type)
    ) {
      return false;
    }
    if (respectSelection) {
      const sourceStart = runs[0].start + match.start;
      const sourceEnd = runs[0].start + match.end;
      const selection = state.selection;
      const atOpeningBoundary =
        selection.empty && selection.from === sourceStart;
      const atClosingBoundary =
        selection.empty && selection.from === sourceEnd;
      const insideSource =
        (selection.from < sourceEnd &&
          selection.to > sourceStart) ||
        atClosingBoundary;
      if (!atOpeningBoundary && insideSource) {
        return false;
      }
    }

    const inline = [
      ...buildSlice(runs, 0, match.start),
      ...(match.markName === "math_inline"
        ? [
            mathType!.create(
              null,
              state.schema.text(match.content)
            ),
          ]
        : buildSlice(
            runs,
            match.contentStart,
            match.contentEnd,
            type!,
            match.attrs
          )),
      ...buildSlice(runs, match.end, text.length),
    ];
    tr = tr.replaceWith(
      runs[0].start,
      runs[runs.length - 1].end,
      Fragment.fromArray(inline)
    );
    changed = true;
    return true;
  };

  let offset = scope ? scope.blockPos + 1 : $from.start($from.depth);
  node.forEach((child) => {
    if (changed) return;
    if (child.isText && child.text) {
      runs.push({
        node: child,
        start: offset,
        end: offset + child.nodeSize,
        text: child.text,
      });
    } else {
      if (tryFormatRuns()) return;
      runs = [];
    }
    offset += child.nodeSize;
  });
  if (!changed) tryFormatRuns();
  return changed ? tr : null;
}

export function createMarkSourcePlugin(): Plugin<MarkSourceSession | null> {
  let pendingAutoFormat: {
    blockPos: number;
    focusOffset: number;
  } | null = null;
  let pendingVerticalExit = false;

  return new Plugin<MarkSourceSession | null>({
    key: markSourceKey,
    view(editorView) {
      const closeOnOutsidePointer = (event: Event): void => {
        const session = markSourceKey.getState(editorView.state);
        if (!session) {
          if (event.type !== "click" || !pendingAutoFormat) return;
          const clickedInsideEditor =
            event.target instanceof Node &&
            editorView.dom.contains(event.target);
          const tr = autoFormatInlineMarkdown(
            editorView.state,
            clickedInsideEditor,
            pendingAutoFormat
          );
          if (tr) {
            pendingAutoFormat = null;
            editorView.dispatch(tr);
          }
          return;
        }
        const blockElement = sourceSessionBlockElement(
          editorView,
          session
        );
        if (
          event.target instanceof Element &&
          blockElement &&
          !blockElement.contains(event.target)
        ) {
          closeMarkSource(editorView);
          return;
        }
        if (
          event.type === "pointerdown" ||
          event.type === "mousedown"
        ) {
          return;
        }
        const target = event.target;
        if (target instanceof Node && editorView.dom.contains(target)) {
          const pointer = event as MouseEvent;
          const hit = editorView.posAtCoords({
            left: pointer.clientX,
            top: pointer.clientY,
          });
          if (hit && hit.pos >= session.from && hit.pos < session.to) {
            return;
          }
        }
        closeMarkSource(editorView);
      };
      document.addEventListener(
        "pointerdown",
        closeOnOutsidePointer,
        true
      );
      document.addEventListener(
        "mousedown",
        closeOnOutsidePointer,
        true
      );
      document.addEventListener("click", closeOnOutsidePointer, true);
      return {
        destroy() {
          document.removeEventListener(
            "pointerdown",
            closeOnOutsidePointer,
            true
          );
          document.removeEventListener(
            "mousedown",
            closeOnOutsidePointer,
            true
          );
          document.removeEventListener("click", closeOnOutsidePointer, true);
        },
      };
    },
    state: {
      init: () => null,
      apply(tr, previous) {
        if (tr.getMeta("addToHistory") === false) {
          pendingAutoFormat = null;
        }
        const meta = tr.getMeta(markSourceKey) as MarkSourceMeta | undefined;
        if (meta?.type === "close") {
          pendingAutoFormat = null;
          pendingVerticalExit = false;
          return null;
        }
        if (meta?.type === "start") {
          pendingAutoFormat = null;
          pendingVerticalExit = false;
          return { ...meta.session, dirty: false };
        }
        if (!previous || !tr.docChanged) return previous;

        const from = tr.mapping.map(previous.from, -1);
        const to = tr.mapping.map(previous.to, 1);
        if (from > to) {
          pendingVerticalExit = false;
          return null;
        }
        // 用户真的动了内容：关闭时走原有的解析还原逻辑。
        return { ...previous, from, to, dirty: true };
      },
    },
    appendTransaction(_transactions, _oldState, newState) {
      const session = markSourceKey.getState(newState);
      if (!session) {
        const emptiedTextblock =
          _transactions.some((tr) => tr.docChanged) &&
          newState.selection.empty &&
          newState.selection.$from.parent.isTextblock &&
          newState.selection.$from.parent.content.size === 0;
        if (
          emptiedTextblock &&
          (newState.storedMarks?.length ?? 0) > 0
        ) {
          return newState.tr.setStoredMarks([]);
        }
        const selectionMoved = _transactions.some(
          (tr) =>
            tr.selectionSet &&
            !tr.docChanged &&
            !tr.getMeta("pointer")
        );
        if (!selectionMoved) return null;
        if (pendingAutoFormat) {
          const tr = autoFormatInlineMarkdown(
            newState,
            true,
            pendingAutoFormat
          );
          if (tr) {
            pendingAutoFormat = null;
            return tr;
          }
        }
      // 水平线等原子节点会用 NodeSelection 接住第一次上下移动。
      // 待格式化内容仍应在离开原文本块时完成，而不是等第二次移动。
      if (!newState.selection.empty) return null;
        for (const markName of Object.keys(MARK_SOURCE_SYNTAX)) {
          const type = markTypeFor(newState, markName);
          if (!type) continue;
          const range = markRangeAt(
            newState.doc,
            newState.selection.from,
            type
          );
          if (!range) continue;
          const attrs = markAttrsAtRange(
            newState.doc,
            type,
            range.from,
            range.to
          );
          if (markName === "link" && !attrs) continue;
          return openSourceSessionTransaction(
            newState,
            markName,
            range.from,
            range.to,
            attrs,
            newState.selection.from
          );
        }
        return null;
      }

      if (!selectionInsideSession(newState, session)) {
        if (
          pendingVerticalExit &&
          _transactions.every((tr) => !tr.docChanged)
        ) {
          return null;
        }
        return finishMarkSourceTransaction(newState, session);
      }
      if (
        session.markName === INLINE_HTML_MARK_NAME &&
        _transactions.some((tr) => tr.docChanged)
      ) {
        const oldSession = markSourceKey.getState(_oldState);
        if (oldSession?.markName !== INLINE_HTML_MARK_NAME) return null;
        const oldSource = _oldState.doc.textBetween(
          oldSession.from,
          oldSession.to,
          "\n",
          "\n"
        );
        const source = newState.doc.textBetween(
          session.from,
          session.to,
          "\n",
          "\n"
        );
        if (
          !isCompleteEditableInlineHtmlSource(oldSource) &&
          isCompleteEditableInlineHtmlSource(source)
        ) {
          return finishMarkSourceTransaction(newState, session);
        }
      }
      return null;
    },
    props: {
      decorations: previewInlineDecorations,
      handleTextInput(view, from, to, text) {
        const session = markSourceKey.getState(view.state);
        if (
          session &&
          from === session.to &&
          to === session.to
        ) {
          const source = view.state.doc.textBetween(
            session.from,
            session.to,
            "\n",
            "\n"
          );
          const parsed = findPlainInlineMatch(source);
          const complete =
            (!!parsed &&
              parsed.start === 0 &&
              parsed.end === source.length) ||
            (session.markName === INLINE_HTML_MARK_NAME &&
              isCompleteEditableInlineHtmlSource(source));
          if (
            complete &&
            ![...text].every((character) =>
              INLINE_SYNTAX_INPUT_CHARS.has(character)
            )
          ) {
            closeMarkSource(view);
          }
        } else if (!session) {
          const $from = view.state.selection.$from;
          if ($from.depth > 0) {
            pendingAutoFormat = {
              blockPos: $from.before($from.depth),
              focusOffset: from - $from.start($from.depth),
            };
          }
          queueMicrotask(() => {
            if (view.isDestroyed || markSourceKey.getState(view.state)) {
              return;
            }
            if (!pendingAutoFormat) return;
            const tr = autoFormatInlineMarkdown(
              view.state,
              true,
              pendingAutoFormat
            );
            if (tr) {
              view.dispatch(tr);
              pendingAutoFormat = null;
            }
          });
        }
        return false;
      },
      handleKeyDown(view, event) {
        const mod = event.ctrlKey || event.metaKey;
        if (mod && !event.altKey) {
          const shortcut =
            event.key.toLowerCase() === "b"
              ? "strong"
              : event.key.toLowerCase() === "i"
                ? "emphasis"
                : event.key.toLowerCase() === "e"
                  ? "inlineCode"
                  : null;
          if (shortcut) {
            event.preventDefault();
            startMarkSource(view, shortcut);
            return true;
          }
        }

        const session = markSourceKey.getState(view.state);
        if (!session) return false;
        if (event.key === "Escape") {
          event.preventDefault();
          closeMarkSource(view);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          closeMarkSource(view);
          return false;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          // ProseMirror leaves ordinary vertical movement to the browser.
          // Keep the source DOM stable until keyup so Chromium can finish the
          // native line movement before the document is redrawn.
          pendingVerticalExit = true;
          return false;
        }
        const atBoundary =
          (event.key === "ArrowRight" &&
            view.state.selection.head === session.to) ||
          (event.key === "ArrowLeft" &&
            view.state.selection.head === session.from);
        if (atBoundary) {
          const source = view.state.doc.textBetween(
            session.from,
            session.to,
            "\n",
            "\n"
          );
          const complete =
            session.markName !== INLINE_HTML_MARK_NAME ||
            isCompleteEditableInlineHtmlSource(source);
          if (!complete) return false;
          closeMarkSource(view);
        }
        return false;
      },
      handleDOMEvents: {
        keyup(view, event) {
          if (
            !pendingVerticalExit ||
            (event.key !== "ArrowUp" && event.key !== "ArrowDown")
          ) {
            return false;
          }
          pendingVerticalExit = false;
          const session = markSourceKey.getState(view.state);
          if (session && !selectionInsideSession(view.state, session)) {
            closeMarkSource(view);
          }
          return false;
        },
        blur(view) {
          if (markSourceKey.getState(view.state)) {
            closeMarkSource(view);
          } else if (pendingAutoFormat) {
            const pending = pendingAutoFormat;
            pendingAutoFormat = null;
            const tr = autoFormatInlineMarkdown(
              view.state,
              false,
              pending
            );
            if (tr) view.dispatch(tr);
          }
          return false;
        },
      },
      handleClick(view, pos, event) {
        if (event.button !== 0) return false;
        const active = markSourceKey.getState(view.state);
        if (active) {
          if (
            active.markName === "link" &&
            clickedMark(event.target as Element | null)?.markName === "link"
          ) {
            event.preventDefault();
            return true;
          }
          return false;
        }

        const mark = clickedMark(event.target as Element | null);
        if (!mark) return activateLinkAtPosition(view, pos);
        try {
          const from = view.posAtDOM(mark.element, 0, 1);
          const to = view.posAtDOM(
            mark.element,
            mark.element.childNodes.length,
            -1
          );
          return activateMarkRange(
            view,
            mark.markName,
            from,
            to,
            pos
          );
        } catch {
          return false;
        }
      },
    },
  });
}

export const markSourcePlugin = $prose(() => createMarkSourcePlugin());
