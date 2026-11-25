/*
 * Shared editor actions used by the context menu.
 *
 * This module intentionally contains no command launcher state, input
 * handling, filtering, keyboard navigation, or launcher DOM.
 */
import type {
  Node as PMNode,
  NodeType,
} from "@milkdown/prose/model";
import {
  TextSelection,
  type Command,
  type EditorState,
  type Selection,
  type Transaction,
} from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { wrapIn } from "@milkdown/prose/commands";
import { wrapInList } from "@milkdown/prose/schema-list";
import { setSelectionAfterBlock } from "./block-exit";
import {
  appendFloatingLayer,
  clampFloatingLayer,
} from "./floating-layer";
import { startMarkSource, startMarkSourceRange } from "./mark-source";

export type EditorAction = "image";

type EditorActionHandler = (
  action: EditorAction,
  view: EditorView,
  pos: number
) => void;

let actionHandler: EditorActionHandler | null = null;

/** Register host capabilities such as opening the native image picker. */
export function setEditorActionHandler(
  handler: EditorActionHandler | null
): void {
  actionHandler = handler;
}

export function applyFormatMark(
  view: EditorView,
  markName: string,
  _label: string
): void {
  void _label;
  startMarkSource(view, markName);
}

export function openImagePicker(view: EditorView, pos: number): void {
  actionHandler?.("image", view, pos);
}

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

function setBlockAt(
  type: NodeType,
  attrs: Record<string, unknown> | null
): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    let depth = $from.depth;
    while (depth > 0 && !$from.node(depth).isTextblock) depth -= 1;
    const node = $from.node(depth);
    if (!node?.isTextblock) return false;
    if (node.hasMarkup(type, attrs ?? {})) return true;
    const pos = depth === 0 ? 0 : $from.before(depth);
    const $pos = state.doc.resolve(pos);
    if (!$pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, type)) {
      return false;
    }
    dispatch?.(state.tr.setNodeMarkup(pos, type, attrs).scrollIntoView());
    return true;
  };
}

function insertAtom(
  type: NodeType,
  attrs?: Record<string, unknown>
): Command {
  return (state, dispatch) => {
    const node = type.create(attrs);
    const paragraph = state.schema.nodes.paragraph;
    const { start, end, empty } = blockRangeAt(state);
    let tr: Transaction;
    let nodeStart: number;
    if (empty) {
      nodeStart = start;
      tr = state.tr.replaceWith(start, end, node);
    } else {
      nodeStart = state.selection.from;
      // Structural insertion is programmatic navigation. Without this marker,
      // the inline source plugin can reopen a mark session at the new caret.
      tr = state.tr.replaceSelectionWith(node).setMeta("pointer", true);
    }
    const blockEnd = nodeStart + node.nodeSize;
    let paragraphInserted = false;
    if (paragraph && blockEnd === tr.doc.content.size) {
      tr = tr.insert(blockEnd, paragraph.create());
      paragraphInserted = true;
    }
    tr = tr.setSelection(
      paragraphInserted
        ? TextSelection.create(tr.doc, blockEnd + 1)
        : TextSelection.near(tr.doc.resolve(blockEnd + 1))
    );
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

type BlockInsertion = {
  command: Command;
  insertedPos: () => number | null;
};

function selectedPlainText(state: EditorState): string {
  const { from, to, empty } = state.selection;
  if (empty) return "";
  return state.doc.textBetween(from, to, "\n", (leaf) =>
    leaf.type.name === "hardbreak" || leaf.type.name === "hard_break"
      ? "\n"
      : ""
  );
}

function findInsertedBlock(
  tr: Transaction,
  inserted: PMNode,
  from: number,
  to: number
): number | null {
  const mappedFrom = tr.mapping.map(from, -1);
  const mappedTo = tr.mapping.map(to, 1);
  const searchFrom = Math.max(0, Math.min(mappedFrom, mappedTo) - 4);
  const searchTo = Math.min(
    tr.doc.content.size,
    Math.max(mappedFrom, mappedTo) + 4
  );
  let found: number | null = null;
  tr.doc.nodesBetween(searchFrom, searchTo, (node, pos) => {
    if (node !== inserted && !node.eq(inserted)) return true;
    found = pos;
    return false;
  });
  if (found != null) return found;

  // Complex replacements can rebuild the node object outside the mapped
  // neighborhood. Fall back to a full document scan for the same block shape.
  tr.doc.descendants((node, pos) => {
    if (node !== inserted && !node.eq(inserted)) return found == null;
    found = pos;
    return false;
  });
  return found;
}

/**
 * Insert a block at the current selection.
 *
 * ProseMirror splits a surrounding textblock when a block node replaces an
 * inline range or a collapsed caret. This gives one shared rule for code,
 * math and horizontal rules: insert before at paragraph start, after at
 * paragraph end, split in the middle, and replace only an actual selection.
 */
function insertBlockAtSelection(
  type: NodeType,
  attrs: Record<string, unknown> | null,
  options: { codeFromSelection?: boolean; openInside?: boolean } = {}
): BlockInsertion {
  let insertedPos: number | null = null;
  const command: Command = (state, dispatch) => {
    const text = options.codeFromSelection
      ? selectedPlainText(state)
      : "";
    let node: PMNode;
    try {
      node = type.create(attrs, text ? state.schema.text(text) : null);
    } catch {
      return false;
    }

    let tr: Transaction;
    try {
      tr = state.tr.replaceSelectionWith(node);
    } catch {
      return false;
    }
    insertedPos = findInsertedBlock(
      tr,
      node,
      state.selection.from,
      state.selection.to
    );
    if (insertedPos == null) return false;

    if (options.openInside === false) {
      setSelectionAfterBlock(tr, insertedPos + node.nodeSize);
    } else {
      tr.setSelection(TextSelection.create(tr.doc, insertedPos + 1));
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
  return { command, insertedPos: () => insertedPos };
}

function insertTableNxM(rows: number, cols: number): Command {
  return (state, dispatch) => {
    const {
      table,
      table_header_row,
      table_header,
      table_row,
      table_cell,
      paragraph,
    } = state.schema.nodes;
    if (
      !table ||
      !table_header_row ||
      !table_header ||
      !table_row ||
      !table_cell ||
      !paragraph
    ) {
      return false;
    }

    const emptyCell = (type: NodeType): PMNode =>
      type.create(null, paragraph.create());
    const headerCells = Array.from({ length: cols }, () =>
      emptyCell(table_header)
    );
    const bodyRow = (): PMNode =>
      table_row.create(
        null,
        Array.from({ length: cols }, () => emptyCell(table_cell))
      );
    const node = table.create(null, [
      table_header_row.create(null, headerCells),
      ...Array.from({ length: Math.max(1, rows - 1) }, bodyRow),
    ]);

    const { start, end, empty } = blockRangeAt(state);
    let tr: Transaction;
    let nodeStart: number;
    if (empty) {
      nodeStart = start;
      tr = state.tr.replaceWith(start, end, node);
    } else {
      nodeStart = state.selection.from;
      tr = state.tr.replaceSelectionWith(node);
    }
    const tableEnd = nodeStart + node.nodeSize;
    if (paragraph && tableEnd === tr.doc.content.size) {
      tr = tr.insert(tableEnd, paragraph.create());
    }

    let cellPos: number | null = null;
    tr.doc.nodesBetween(nodeStart, nodeStart + node.nodeSize, (child, pos) => {
      if (cellPos != null) return false;
      if (
        child.type.name === "table_header" ||
        child.type.name === "table_cell"
      ) {
        cellPos = pos;
        return false;
      }
      return true;
    });
    if (cellPos != null) {
      tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)));
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

function wrapInTaskList(bulletListType: NodeType): Command {
  return (state, dispatch) => {
    let captured: Transaction | undefined;
    const applied = wrapInList(bulletListType)(state, (tr) => {
      captured = tr;
    });
    const tr = captured as Transaction | undefined;
    if (!applied || !tr) return false;
    const $head = tr.doc.resolve(tr.selection.from);
    for (let depth = $head.depth; depth > 0; depth -= 1) {
      const node = $head.node(depth);
      if (node.type.name === "list_item") {
        tr.setNodeMarkup($head.before(depth), undefined, {
          ...node.attrs,
          checked: false,
        });
        break;
      }
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

export type EditorBlockAction =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "blockquote"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "codeBlock";

export function applyBlockAction(
  view: EditorView,
  action: EditorBlockAction
): boolean {
  const { nodes } = view.state.schema;
  let command: Command | null = null;
  if (action === "paragraph") {
    command = setBlockAt(nodes.paragraph, null);
  } else if (action === "codeBlock") {
    command = setBlockAt(nodes.code_block, null);
  } else if (action.startsWith("heading")) {
    const level = Number(action.slice(-1)) as 1 | 2 | 3 | 4 | 5 | 6;
    command = setBlockAt(nodes.heading, { level });
  } else if (action === "blockquote") {
    command = wrapIn(nodes.blockquote);
  } else if (action === "bulletList") {
    command = wrapInList(nodes.bullet_list);
  } else if (action === "orderedList") {
    command = wrapInList(nodes.ordered_list);
  } else if (action === "taskList") {
    command = wrapInTaskList(nodes.bullet_list);
  }
  if (!command) return false;
  const applied = command(view.state, view.dispatch);
  if (applied) {
    view.focus();
    // NodeViews and block margins settle after the transaction renders. Sync
    // the DOM selection once more so the first inserted block already shows a
    // normal caret instead of briefly leaving it at the block edge.
    requestAnimationFrame(() => {
      if (!view.isDestroyed) view.focus();
    });
  }
  return applied;
}

export type EditorInsertCommand =
  | "image"
  | "hr"
  | "table"
  | "code"
  | "math"
  | "toc"
  | "frontmatter";

function insertFrontmatter(view: EditorView, type: NodeType): boolean {
  if (view.state.doc.firstChild?.type === type) return true;
  const node = type.create({ value: "" });
  const tr = view.state.tr.insert(0, node);
  setSelectionAfterBlock(tr, node.nodeSize);
  view.dispatch(tr.scrollIntoView());
  requestAnimationFrame(() => {
    const dom = view.nodeDOM(0) as HTMLElement | null;
    dom?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return true;
}

function promptLinkUrl(view: EditorView, label: string): boolean {
  const insertPos = view.state.selection.from;
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
  box.append(input, tip);
  appendFloatingLayer(box);
  try {
    const coords = view.coordsAtPos(insertPos);
    clampFloatingLayer(box, coords.left, coords.bottom + 6, 8);
  } catch {
    /* Keep the fallback position. */
  }

  const cleanup = (): void => {
    box.remove();
    document.removeEventListener("mousedown", onOutside, true);
  };
  const onOutside = (event: MouseEvent): void => {
    if (!box.contains(event.target as Node)) cleanup();
  };
  const commit = (): void => {
    const href = input.value.trim();
    cleanup();
    if (!href) {
      view.focus();
      return;
    }
    const state = view.state;
    const linkType = state.schema.marks.link;
    if (!linkType) return;
    const at = Math.max(0, Math.min(insertPos, state.doc.content.size));
    const tr = state.tr.insertText(label, at);
    tr.addMark(at, at + label.length, linkType.create({ href }));
    tr.setSelection(TextSelection.create(tr.doc, at, at + label.length));
    tr.setStoredMarks([]);
    view.dispatch(tr.scrollIntoView());
    view.focus();
    startMarkSourceRange(view, "link", at, at + label.length);
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cleanup();
      view.focus();
    }
  });
  document.addEventListener("mousedown", onOutside, true);
  input.focus();
  input.select();
  return true;
}

function promptTableSize(view: EditorView): boolean {
  const insertPos = view.state.selection.from;
  const box = document.createElement("div");
  box.className = "mt-slash-linkbox";
  const rowWrap = document.createElement("div");
  rowWrap.style.cssText = "display:flex;align-items:center;gap:6px";
  const label = (text: string): HTMLSpanElement => {
    const span = document.createElement("span");
    span.textContent = text;
    span.style.cssText = "opacity:.6;font-size:12px";
    return span;
  };
  const colsInput = document.createElement("input");
  colsInput.type = "text";
  colsInput.inputMode = "numeric";
  colsInput.className = "mt-slash-linkbox__input";
  colsInput.style.width = "56px";
  colsInput.value = "3";
  const separator = document.createElement("span");
  separator.textContent = "×";
  separator.style.opacity = "0.6";
  const rowsInput = document.createElement("input");
  rowsInput.type = "text";
  rowsInput.inputMode = "numeric";
  rowsInput.className = "mt-slash-linkbox__input";
  rowsInput.style.width = "56px";
  rowsInput.value = "3";
  rowWrap.append(label("列"), colsInput, separator, label("行"), rowsInput);
  const tip = document.createElement("div");
  tip.className = "mt-slash-linkbox__tip";
  tip.textContent = "Enter 确认 · Esc 取消";
  box.append(rowWrap, tip);
  appendFloatingLayer(box);
  try {
    const coords = view.coordsAtPos(insertPos);
    // Typora-style table picker: cover the insertion point itself so the
    // focused size inputs become the visual anchor while the editor loses
    // native caret painting.
    clampFloatingLayer(box, coords.left, coords.top, 8);
  } catch {
    /* Keep the fallback position. */
  }

  let active = true;
  const cleanup = (): void => {
    if (!active) return;
    active = false;
    box.remove();
    document.removeEventListener("mousedown", onOutside, true);
  };
  const onOutside = (event: MouseEvent): void => {
    if (!box.contains(event.target as Node)) cleanup();
  };
  const commit = (): void => {
    const rows = Number(rowsInput.value.trim());
    const cols = Number(colsInput.value.trim());
    cleanup();
    if (
      !Number.isInteger(rows) ||
      rows < 1 ||
      !Number.isInteger(cols) ||
      cols < 1
    ) {
      view.focus();
      return;
    }
    const safePos = Math.min(
      insertPos,
      view.state.doc.content.size
    );
    const $pos = view.state.doc.resolve(safePos);
    let selection: Selection;
    try {
      selection = TextSelection.create(view.state.doc, safePos);
    } catch {
      selection = TextSelection.near($pos, -1);
    }
    view.dispatch(
      view.state.tr
        .setSelection(selection)
        // Table insertion happens after the dialog closes. Keep the inline
        // mark source plugin from reopening a just-closed mark while focus
        // moves back from the dialog.
        .setMeta("pointer", true)
    );
    view.focus();
    insertTableNxM(rows, cols)(view.state, view.dispatch);
  };
  const onKey = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cleanup();
      view.focus();
    }
  };
  rowsInput.addEventListener("keydown", onKey);
  colsInput.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onOutside, true);
  const restoreInitialFocus = (): void => {
    if (!box.isConnected || box.contains(document.activeElement)) return;
    colsInput.focus();
    colsInput.select();
  };
  restoreInitialFocus();
  // The menu click and any NodeView focus restoration can finish after this
  // function returns. Re-check once the current task settles and once more
  // after layout, without overriding a user who already moved within the box.
  queueMicrotask(restoreInitialFocus);
  requestAnimationFrame(restoreInitialFocus);
  return true;
}

export function promptLinkUrlDialog(
  view: EditorView,
  label: string
): boolean {
  return promptLinkUrl(view, label);
}

export function runEditorCommand(
  view: EditorView,
  id: EditorInsertCommand
): boolean {
  const { nodes } = view.state.schema;
  let command: Command | null = null;
  let getInsertedPos: (() => number | null) | null = null;
  let openEditableBlock = false;
  if (id === "image") {
    openImagePicker(view, view.state.selection.to);
    return true;
  }
  if (id === "table") return promptTableSize(view);
  if (id === "hr" && nodes.hr) {
    const insertion = insertBlockAtSelection(nodes.hr, null, {
      openInside: false,
    });
    command = insertion.command;
  } else if (id === "code" && nodes.code_block) {
    const insertion = insertBlockAtSelection(nodes.code_block, null, {
      codeFromSelection: true,
    });
    command = insertion.command;
  } else if (id === "math" && nodes.math_block) {
    const insertion = insertBlockAtSelection(nodes.math_block, null);
    command = insertion.command;
    getInsertedPos = insertion.insertedPos;
    openEditableBlock = true;
  } else if (id === "toc" && nodes.toc) {
    command = insertAtom(nodes.toc);
  } else if (id === "frontmatter" && nodes.yaml) {
    return insertFrontmatter(view, nodes.yaml);
  }
  if (!command) return false;
  const applied = command(view.state, view.dispatch);
  if (applied) {
    view.focus();
    const targetPos = openEditableBlock ? getInsertedPos?.() : null;
    if (targetPos != null) {
      requestAnimationFrame(() => {
        if (view.isDestroyed) return;
        const dom = view.nodeDOM(targetPos) as HTMLElement | null;
        dom?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
  }
  return applied;
}
