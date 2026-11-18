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

export interface MarkSourceSession {
  markName: string;
  /** Full source range, including opening and closing delimiters. */
  from: number;
  to: number;
  attrs?: Readonly<Record<string, unknown>>;
}

interface MarkSyntax {
  open: string;
  close: string;
  selector: string;
}

export const MARK_SOURCE_SYNTAX: Readonly<Record<string, MarkSyntax>> = {
  link: { open: "[", close: "]", selector: "a[href]" },
  strong: { open: "**", close: "**", selector: "strong" },
  emphasis: { open: "*", close: "*", selector: "em" },
  strike_through: { open: "~~", close: "~~", selector: "del" },
  inlineCode: { open: "`", close: "`", selector: "code" },
  highlight: { open: "==", close: "==", selector: "mark.md-highlight" },
  underline: { open: "<u>", close: "</u>", selector: "u" },
  superscript: { open: "^", close: "^", selector: "sup" },
  subscript: { open: "~", close: "~", selector: "sub" },
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
  if (markName !== "link") {
    const syntax = MARK_SOURCE_SYNTAX[markName];
    return syntax ? { open: syntax.open, close: syntax.close } : null;
  }
  const href = String(attrs?.href ?? "");
  if (!href) return null;
  const title = String(attrs?.title ?? "").replaceAll('"', '\\"');
  return {
    open: "[",
    close: `](${href}${title ? ` "${title}"` : ""})`,
  };
}

function openSourceSessionTransaction(
  state: EditorState,
  markName: string,
  from: number,
  to: number,
  attrs: Readonly<Record<string, unknown>> | undefined,
  caret: number,
  selectContent = false
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
  const safeCaret =
    contentFrom +
    Math.max(0, Math.min(caret - from, contentTo - contentFrom));
  tr = tr.setSelection(
    safeFrom !== safeTo && selectContent
      ? TextSelection.create(tr.doc, contentFrom, contentTo)
      : TextSelection.create(tr.doc, safeCaret)
  );
  tr = tr.setStoredMarks(storedMarksWith(state, type, attrs));
  return tr.setMeta(markSourceKey, {
    type: "start",
    session: { markName, from: safeFrom, to: sourceTo, attrs },
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
      : undefined;
    if (markName === "link" && !attrs) return null;
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
    true
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

export function startMarkSourceRange(
  view: EditorView,
  markName: string,
  from: number,
  to: number,
  caret = to
): boolean {
  return activateMarkRange(view, markName, from, to, caret);
}

function finishMarkSourceTransaction(
  state: EditorState,
  session: MarkSourceSession
): Transaction {
  const originalType = markTypeFor(state, session.markName);
  const delimiters = delimitersFor(session.markName, session.attrs);
  const source = state.doc.textBetween(
    session.from,
    session.to,
    "\n",
    "\n"
  );
  let content = "";
  let attrs = session.attrs;
  let valid = false;
  let openLength = 0;
  let closeLength = 0;
  let finalType = originalType;

  const parsed = findPlainInlineMatch(source);
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
    tr = tr.removeMark(session.from, session.to, originalType);
  }
  if (finalType) {
    tr = tr.setStoredMarks(storedMarksWithout(state, finalType));
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

function findPlainInlineMatch(text: string): PlainInlineMatch | null {
  let found: PlainInlineMatch | null = null;
  const link =
    /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"((?:[^"\\]|\\.)*)")?\)/.exec(
      text
    );
  if (link && link.index != null) {
    found = {
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
    };
  }
  for (const { markName, pattern } of PLAIN_INLINE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || match.index == null || !match[1]) continue;
    const candidate: PlainInlineMatch = {
      start: match.index,
      end: match.index + match[0].length,
      contentStart:
        match.index + match[0].indexOf(match[1]),
      contentEnd:
        match.index + match[0].indexOf(match[1]) + match[1].length,
      content: match[1],
      markName,
    };
    if (
      !found ||
      candidate.start < found.start ||
      (candidate.start === found.start &&
        candidate.end > found.end)
    ) {
      found = candidate;
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
  respectSelection = true
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

  state.doc.descendants((node, pos) => {
    if (changed || !node.isTextblock || node.content.size === 0) {
      return !changed;
    }
    if (node.type.spec.code) return true;

    let runs: Array<{
      node: ProseMirrorNode;
      start: number;
      end: number;
      text: string;
    }> = [];
    const tryFormatRuns = (): boolean => {
      if (runs.length === 0) return false;
      const text = runs.map((run) => run.text).join("");
      const match = findPlainInlineMatch(text);
      const type = markTypeFor(state, match?.markName ?? "");
      if (!match || !type) return false;
      if (respectSelection) {
        const sourceStart = runs[0].start + match.start;
        const sourceEnd = runs[0].start + match.end;
        const selection = state.selection;
        if (
          selection.from <= sourceEnd &&
          selection.to >= sourceStart
        ) {
          return false;
        }
      }

      const inline = [
        ...buildSlice(runs, 0, match.start),
        ...buildSlice(
          runs,
          match.contentStart,
          match.contentEnd,
          type,
          match.attrs
        ),
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

    let offset = pos + 1;
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
    return !changed;
  });
  return changed ? tr : null;
}

export function createMarkSourcePlugin(): Plugin<MarkSourceSession | null> {
  return new Plugin<MarkSourceSession | null>({
    key: markSourceKey,
    view(editorView) {
      const closeOnOutsidePointer = (event: Event): void => {
        const session = markSourceKey.getState(editorView.state);
        if (!session) {
          const tr = autoFormatInlineMarkdown(editorView.state, false);
          if (tr) editorView.dispatch(tr);
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
        const meta = tr.getMeta(markSourceKey) as MarkSourceMeta | undefined;
        if (meta?.type === "close") return null;
        if (meta?.type === "start") return meta.session;
        if (!previous || !tr.docChanged) return previous;

        const from = tr.mapping.map(previous.from, -1);
        const to = tr.mapping.map(previous.to, 1);
        return from <= to ? { ...previous, from, to } : null;
      },
    },
    appendTransaction(_transactions, _oldState, newState) {
      const session = markSourceKey.getState(newState);
      if (!session) {
        const selectionMoved = _transactions.some(
          (tr) =>
            tr.selectionSet &&
            !tr.docChanged &&
            !tr.getMeta("pointer")
        );
        if (!selectionMoved || !newState.selection.empty) return null;
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
        return finishMarkSourceTransaction(newState, session);
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
            !!parsed &&
            parsed.start === 0 &&
            parsed.end === source.length;
          if (
            complete &&
            ![...text].every((character) =>
              INLINE_SYNTAX_INPUT_CHARS.has(character)
            )
          ) {
            closeMarkSource(view);
          }
        } else if (!session) {
          queueMicrotask(() => {
            if (view.isDestroyed || markSourceKey.getState(view.state)) {
              return;
            }
            const tr = autoFormatInlineMarkdown(view.state);
            if (tr) view.dispatch(tr);
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
        if (
          (event.key === "ArrowRight" &&
            view.state.selection.head === session.to) ||
          (event.key === "ArrowLeft" &&
            view.state.selection.head === session.from)
        ) {
          closeMarkSource(view);
        }
        return false;
      },
      handleDOMEvents: {
        blur(view) {
          if (markSourceKey.getState(view.state)) {
            closeMarkSource(view);
          } else {
            const tr = autoFormatInlineMarkdown(view.state, false);
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
        if (!mark) return false;
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
