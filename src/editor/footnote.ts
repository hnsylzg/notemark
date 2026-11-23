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
import { $prose, $view } from "@milkdown/utils";
import {
  Plugin,
  Selection,
  TextSelection,
} from "@milkdown/prose/state";
import type {
  EditorView,
  NodeViewConstructor,
} from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import {
  footnoteDefinitionSchema,
  footnoteReferenceSchema,
} from "@milkdown/preset-gfm";
import { MENU_PRESERVE_EDITING_ATTRIBUTE } from "./menu-preserve";

/** preset-gfm 内置脚注节点在 ProseMirror schema 里的名字 */
const REF = "footnote_reference";
const DEF = "footnote_definition";
const FOOTNOTE_POINTER_EDGE_EM = 0.2;
const DEFINITION_SOURCE_OPEN = "[^";
const DEFINITION_SOURCE_CLOSE = "]:";

/** 查找到的脚注节点（文档位置 + 节点本身） */
interface FootnoteHit {
  pos: number;
  node: PMNode;
}

type FootnoteLabelOpener = (
  keyboardEntry?: boolean,
  fromLeft?: boolean
) => void;

const footnoteLabelOpeners = new WeakMap<
  HTMLElement,
  FootnoteLabelOpener
>();

function keepsEditorDuringMenuAction(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(`[${MENU_PRESERVE_EDITING_ATTRIBUTE}]`)
  );
}

function firstTextClientRect(element: HTMLElement): DOMRect | null {
  const ownerDocument = element.ownerDocument;
  const walker = ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT
  );
  const range = ownerDocument.createRange();
  try {
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? "";
      const firstVisible = text.search(/\S/);
      if (firstVisible < 0) continue;
      range.setStart(node, firstVisible);
      range.setEnd(node, firstVisible + 1);
      const rect =
        (typeof range.getClientRects === "function"
          ? range.getClientRects()[0]
          : null) ??
        (typeof range.getBoundingClientRect === "function"
          ? range.getBoundingClientRect()
          : null);
      if (rect && rect.width > 0) return rect;
    }
    return null;
  } finally {
    range.detach();
  }
}

interface ContentLineBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

function contentLineRects(element: HTMLElement): ContentLineBox[] {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  let rects: DOMRect[] = [];
  try {
    rects = Array.from(range.getClientRects());
  } catch {
    rects = Array.from(element.getClientRects());
  } finally {
    range.detach();
  }
  if (rects.length === 0) {
    rects = Array.from(element.getClientRects());
  }
  const fragments = rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: ContentLineBox[] = [];
  for (const rect of fragments) {
    const line = lines[lines.length - 1];
    const overlap = line
      ? Math.min(line.bottom, rect.bottom) -
        Math.max(line.top, rect.top)
      : 0;
    const centerDistance = line
      ? Math.abs(
          (line.top + line.bottom) / 2 -
            (rect.top + rect.bottom) / 2
        )
      : Number.POSITIVE_INFINITY;
    if (
      line &&
      (overlap > 0 ||
        centerDistance <
          Math.min(line.height, rect.height) / 2)
    ) {
      const left = Math.min(line.left, rect.left);
      const right = Math.max(line.right, rect.right);
      const top = Math.min(line.top, rect.top);
      const bottom = Math.max(line.bottom, rect.bottom);
      Object.assign(line, {
        left,
        right,
        top,
        bottom,
        width: right - left,
        height: bottom - top,
      });
    } else {
      lines.push({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  return lines;
}

function adjacentTextblockPosition(
  view: EditorView,
  from: number,
  direction: -1 | 1
): number | null {
  const blocks: Array<{ from: number; to: number }> = [];
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    return true;
  });
  const current = blocks.find(
    (block) => block.from < from && from < block.to
  );
  if (current) {
    const index = blocks.indexOf(current);
    const target = blocks[index + direction];
    return target ? target.from + 1 : null;
  }
  const target =
    direction > 0
      ? blocks.find((block) => block.from > from)
      : [...blocks].reverse().find((block) => block.to < from);
  return target ? target.from + 1 : null;
}

function selectionAtPosition(
  view: EditorView,
  position: number,
  bias: -1 | 1
): Selection {
  const bounded = Math.max(
    0,
    Math.min(position, view.state.doc.content.size)
  );
  const $pos = view.state.doc.resolve(bounded);
  return $pos.parent.isTextblock
    ? TextSelection.create(view.state.doc, bounded)
    : TextSelection.near($pos, bias);
}

function verticalTargetAt(
  view: EditorView,
  source: HTMLInputElement,
  direction: -1 | 1,
  linePos?: number
): { position: number; bias: -1 | 1 } | null {
  const sourceRect = source.getBoundingClientRect();
  let lineTop = sourceRect.top;
  let lineBottom = sourceRect.bottom;
  let targetLine: ContentLineBox | null = null;
  const lineBlock =
    typeof linePos === "number"
      ? source.closest<HTMLElement>("p, h1, h2, h3, h4, h5, h6")
      : null;
  if (lineBlock) {
    const rects = contentLineRects(lineBlock);
    let bestScore = Number.NEGATIVE_INFINITY;
    let currentLine = -1;
    const sourceCenter = (sourceRect.top + sourceRect.bottom) / 2;
    const sourceHorizontal =
      sourceRect.left + sourceRect.width / 2;
    rects.forEach((rect, index) => {
      const lineCenter = (rect.top + rect.bottom) / 2;
      const verticalDistance = Math.abs(sourceCenter - lineCenter);
      const horizontalDistance =
        sourceHorizontal < rect.left
          ? rect.left - sourceHorizontal
          : sourceHorizontal > rect.right
            ? sourceHorizontal - rect.right
            : 0;
      const score = -(verticalDistance + horizontalDistance);
      if (score > bestScore) {
        bestScore = score;
        currentLine = index;
        lineTop = rect.top;
        lineBottom = rect.bottom;
      }
    });
    targetLine = rects[currentLine + direction] ?? null;
    if (!targetLine) {
      const sibling =
        direction < 0
          ? lineBlock.previousElementSibling
          : lineBlock.nextElementSibling;
      if (sibling instanceof HTMLElement) {
        const siblingRects = contentLineRects(sibling);
        targetLine =
          direction < 0
            ? siblingRects[siblingRects.length - 1] ?? null
            : siblingRects[0] ?? null;
      }
    }
    if (targetLine) {
      lineTop = targetLine.top;
      lineBottom = targetLine.bottom;
    }
  }
  const styleSource = lineBlock ?? source;
  const style =
    source.ownerDocument.defaultView?.getComputedStyle(styleSource);
  const parsedLineHeight = style
    ? Number.parseFloat(style.lineHeight)
    : Number.NaN;
  const lineHeight =
    Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
      ? parsedLineHeight
      : sourceRect.height;
  const verticalOffset = lineHeight > 0 ? lineHeight / 2 : 0;
  const valueLength = source.value.length;
  const caretRatio =
    valueLength > 0
      ? Math.max(
          0,
          Math.min(1, (source.selectionStart ?? valueLength) / valueLength)
        )
      : 0.5;
  const rawLeft = sourceRect.left + sourceRect.width * caretRatio;
  const probeLeft = targetLine
    ? Math.max(targetLine.left, Math.min(rawLeft, targetLine.right))
    : rawLeft;
  const hit = view.posAtCoords({
    left: probeLeft,
    top: targetLine
      ? targetLine.top + targetLine.height / 2
      : direction < 0
        ? lineTop - verticalOffset
        : lineBottom + verticalOffset,
  });
  let position = hit?.pos ?? null;
  if (
    typeof linePos === "number" &&
    !targetLine
  ) {
    position = adjacentTextblockPosition(view, linePos, direction);
  }
  return position == null
    ? null
    : { position, bias: direction };
}

function parseFootnoteLabel(source: string, definition = false): string | null {
  const match = (definition ? /^\[\^([^\]]+)\]:$/ : /^\[\^([^\]]+)\]$/)
    .exec(source.trim());
  return match?.[1]?.trim() || null;
}

function updateFootnoteLabels(
  view: EditorView,
  oldLabel: string,
  newLabel: string
): void {
  if (!oldLabel || !newLabel || oldLabel === newLabel) return;
  const targets: Array<{ pos: number; node: PMNode }> = [];
  view.state.doc.descendants((node, pos) => {
    if (
      (node.type.name === REF || node.type.name === DEF) &&
      String(node.attrs.label ?? "") === oldLabel
    ) {
      targets.push({ pos, node });
    }
    return true;
  });
  if (targets.length === 0) return;
  let tr = view.state.tr;
  for (const target of targets) {
    tr = tr.setNodeMarkup(target.pos, undefined, {
      ...target.node.attrs,
      label: newLabel,
    });
  }
  view.dispatch(tr);
}

export const createFootnoteDefinitionView: NodeViewConstructor = (
  node,
  view,
  getPos
) => {
  const dom = document.createElement("dl");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.tabIndex = -1;
  const labelText = document.createElement("span");
  labelText.className = "mt-footnote-label-text";
  const source = document.createElement("input");
  source.className = "mt-footnote-label-source";
  source.type = "text";
  source.spellcheck = false;
  source.style.display = "none";
  dom.append(dt, dd);
  let editing = false;
  let boundaryEntry: "after" | null = null;
  let boundaryValue = "";
  let pendingPointerSelection:
    | { start: number; end: number }
    | null = null;
  let cleanupPointerSelectionRestore: (() => void) | null = null;
  let lastPointerButton = -1;

  const clearPointerSelectionRestore = (): void => {
    cleanupPointerSelectionRestore?.();
    cleanupPointerSelectionRestore = null;
  };

  const updateChrome = () => {
    const label = String(node.attrs.label ?? "");
    dom.dataset.type = DEF;
    dom.dataset.label = label;
    if (!editing) {
      labelText.textContent = label;
      dt.replaceChildren(labelText);
      source.style.display = "none";
      dt.classList.remove("mt-footnote-source-editing");
      delete dt.dataset.mtSource;
    }
  };
  updateChrome();

  const startEditing = (
    keyboardEntry = false,
    fromLeft = true,
    pointerEntry = false
  ) => {
    if (editing) return;
    editing = true;
    boundaryEntry =
      keyboardEntry && !fromLeft ? "after" : null;
    source.value = `${DEFINITION_SOURCE_OPEN}${String(
      node.attrs.label ?? ""
    )}${DEFINITION_SOURCE_CLOSE}`;
    boundaryValue = source.value;
    source.style.display = "inline-block";
    dt.replaceChildren(source);
    dt.dataset.mtSource = "true";
    dt.classList.add("mt-footnote-source-editing");
    document.addEventListener("mousedown", onOutsideMouseDown, true);
    document.addEventListener("pointerdown", onOutsideMouseDown, true);
    document.addEventListener(
      "selectionchange",
      onDocumentSelectionChange
    );
    source.focus();
    const textLength = source.value.length;
    const labelStart = Math.min(2, textLength);
    const start =
      keyboardEntry && !fromLeft ? textLength : labelStart;
    const end = keyboardEntry
      ? start
      : Math.max(labelStart, textLength - 2);
    source.setSelectionRange(start, end);
    pendingPointerSelection =
      pointerEntry && start > 0 ? { start, end } : null;
    const restorePointerSelection = (): void => {
      if (
        !editing ||
        !pendingPointerSelection
      ) {
        return;
      }
      source.focus({ preventScroll: true });
      source.setSelectionRange(
        pendingPointerSelection.start,
        pendingPointerSelection.end
      );
    };
    clearPointerSelectionRestore();
    if (pendingPointerSelection) {
      const restoreAfterEventDefaults = (): void => {
        restorePointerSelection();
        setTimeout(restorePointerSelection, 0);
        requestAnimationFrame(restorePointerSelection);
      };
      document.addEventListener(
        "mouseup",
        restoreAfterEventDefaults,
        true
      );
      document.addEventListener(
        "click",
        restoreAfterEventDefaults,
        true
      );
      cleanupPointerSelectionRestore = () => {
        document.removeEventListener(
          "mouseup",
          restoreAfterEventDefaults,
          true
        );
        document.removeEventListener(
          "click",
          restoreAfterEventDefaults,
          true
        );
      };
    }
    queueMicrotask(restorePointerSelection);
    requestAnimationFrame(restorePointerSelection);
    setTimeout(restorePointerSelection, 0);
  };

  const onOutsideMouseDown = (event: MouseEvent) => {
    if (keepsEditorDuringMenuAction(event.target)) return;
    if (!dt.contains(event.target as Node)) finishEditing(true);
  };

  const finishEditing = (commit: boolean) => {
    if (!editing) return;
    const previous = String(node.attrs.label ?? "");
    const next = commit
      ? parseFootnoteLabel(source.value, true)
      : previous;
    editing = false;
    boundaryEntry = null;
    boundaryValue = "";
    pendingPointerSelection = null;
    clearPointerSelectionRestore();
    updateChrome();
    if (next && next !== previous) {
      updateFootnoteLabels(view, previous, next);
    }
    document.removeEventListener("mousedown", onOutsideMouseDown, true);
    document.removeEventListener("pointerdown", onOutsideMouseDown, true);
    document.removeEventListener(
      "selectionchange",
      onDocumentSelectionChange
    );
  };

  const boundarySideAtCaret = (): "after" | null => {
    if (!editing || !boundaryEntry) return null;
    if (
      source.selectionStart === source.value.length &&
      source.selectionEnd === source.value.length
    ) {
      return "after";
    }
    return null;
  };

  const explanationStartPos = (): number | null => {
    const pos = getPos();
    if (typeof pos !== "number") return null;
    const live = view.state.doc.nodeAt(pos);
    if (!live || live.type.name !== DEF) return null;
    return firstTextPos(view.state.doc, pos, live.nodeSize);
  };

  const labelContentRange = (): { from: number; to: number } => ({
    from: DEFINITION_SOURCE_OPEN.length,
    to: Math.max(
      DEFINITION_SOURCE_OPEN.length,
      source.value.length - DEFINITION_SOURCE_CLOSE.length
    ),
  });

  const clampSourceSelection = (): void => {
    if (!editing) return;
    const range = labelContentRange();
    const length = source.value.length;
    const selectionStart = source.selectionStart ?? range.from;
    const selectionEnd = source.selectionEnd ?? selectionStart;
    if (
      selectionStart === length &&
      selectionEnd === length
    ) {
      return;
    }
    const clamp = (position: number): number =>
      Math.max(range.from, Math.min(position, range.to));
    const nextStart = clamp(selectionStart);
    const nextEnd = clamp(selectionEnd);
    if (
      nextStart !== selectionStart ||
      nextEnd !== selectionEnd
    ) {
      source.setSelectionRange(nextStart, nextEnd);
    }
  };

  const onDocumentSelectionChange = (): void => {
    if (source.ownerDocument.activeElement === source) {
      clampSourceSelection();
    }
  };

  const deletionTouchesProtectedSyntax = (
    inputType: "deleteContentBackward" | "deleteContentForward"
  ): boolean => {
    const range = labelContentRange();
    const selectionStart = source.selectionStart ?? 0;
    const selectionEnd = source.selectionEnd ?? selectionStart;
    const from =
      selectionStart === selectionEnd &&
      inputType === "deleteContentBackward"
        ? Math.max(0, selectionStart - 1)
        : selectionStart;
    const to =
      selectionStart === selectionEnd &&
      inputType === "deleteContentForward"
        ? Math.min(source.value.length, selectionEnd + 1)
        : selectionEnd;
    const removedLabelCharacters = Math.max(
      0,
      Math.min(to, range.to) - Math.max(from, range.from)
    );
    return (
      from < range.from ||
      to > range.to ||
      removedLabelCharacters >= range.to - range.from
    );
  };

  const insertLabelText = (text: string): void => {
    const range = labelContentRange();
    const selectionStart = source.selectionStart ?? range.from;
    const selectionEnd = source.selectionEnd ?? selectionStart;
    const from = Math.max(
      range.from,
      Math.min(selectionStart, range.to)
    );
    const to = Math.max(
      from,
      Math.min(selectionEnd, range.to)
    );
    source.setRangeText(text, from, to, "end");
  };

  const redirectLabelInsertion = (text: string): boolean => {
    const range = labelContentRange();
    const selectionStart = source.selectionStart ?? range.from;
    const selectionEnd = source.selectionEnd ?? selectionStart;
    if (selectionStart > range.to) {
      source.setSelectionRange(range.to, range.to);
      return true;
    }
    if (
      selectionStart < range.from ||
      selectionEnd > range.to
    ) {
      insertLabelText(text);
      return true;
    }
    return false;
  };

  const focusExplanationStart = (): void => {
    finishEditing(true);
    const target = explanationStartPos();
    if (target == null) return;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(target), 1)
      )
    );
    view.focus();
  };

  const insertAtBoundary = (text: string): void => {
    finishEditing(true);
    const target = explanationStartPos();
    if (target == null || !text) return;
    const tr = view.state.tr.insertText(text, target);
    tr.setSelection(
      TextSelection.near(
        tr.doc.resolve(target + text.length),
        1
      )
    );
    view.dispatch(tr);
    view.focus();
  };

  const pointerEntryAt = (
    event: MouseEvent
  ): { keyboardEntry: boolean; fromLeft: boolean } | null => {
    if (editing || event.button !== 0) return null;
    const target = event.target as Node | null;
    if (!target || source.contains(target)) return null;
    const inNumber = dt.contains(target);
    const inExplanation = dd.contains(target);
    if (inExplanation && target !== dd) return null;

    const labelRect =
      firstTextClientRect(labelText) ??
      labelText.getBoundingClientRect();
    if (
      labelRect.width > 0 &&
      (event.clientY < labelRect.top ||
        event.clientY > labelRect.bottom)
    ) {
      return null;
    }
    const dtRect = dt.getBoundingClientRect();
    const fontSize = Number.parseFloat(
      dt.ownerDocument.defaultView?.getComputedStyle(dt).fontSize ?? ""
    );
    const edgeWidth = Number.isFinite(fontSize)
      ? fontSize * FOOTNOTE_POINTER_EDGE_EM
      : 0;
    if (
      !inNumber &&
      !inExplanation &&
      dtRect.width > 0 &&
      event.clientX <= dtRect.left + edgeWidth
    ) {
      return { keyboardEntry: true, fromLeft: true };
    }

    if (labelRect.width <= 0) {
      return inNumber
        ? { keyboardEntry: false, fromLeft: true }
        : null;
    }
    const contentBlock =
      dd.firstElementChild instanceof HTMLElement
        ? dd.firstElementChild
        : null;
    const contentRect = contentBlock
      ? firstTextClientRect(contentBlock) ??
        contentBlock.getBoundingClientRect()
      : null;
    const clickedBeforeContent =
      !!contentRect &&
      contentRect.width > 0 &&
      event.clientX < contentRect.left;
    if (
      (!inExplanation || clickedBeforeContent) &&
      event.clientX > labelRect.right
    ) {
      return { keyboardEntry: true, fromLeft: false };
    }
    if (!inNumber) return null;
    return event.clientX < labelRect.left
      ? { keyboardEntry: true, fromLeft: true }
      : { keyboardEntry: false, fromLeft: true };
  };

  dom.addEventListener(
    "mousedown",
    (event) => {
      lastPointerButton = event.button;
    },
    true
  );
  dom.addEventListener(
    "contextmenu",
    () => {
      lastPointerButton = 2;
    },
    true
  );
  dom.addEventListener("mousedown", (event) => {
    const entry = pointerEntryAt(event);
    if (!entry) return;
    event.preventDefault();
    event.stopPropagation();
    startEditing(
      entry.keyboardEntry,
      entry.fromLeft,
      true
    );
  });
  dom.addEventListener("click", (event) => {
    const secondaryGesture = lastPointerButton !== 0;
    lastPointerButton = -1;
    if (secondaryGesture || event.button !== 0) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      editing &&
      pendingPointerSelection
    ) {
      event.preventDefault();
      event.stopPropagation();
      source.focus({ preventScroll: true });
      source.setSelectionRange(
        pendingPointerSelection.start,
        pendingPointerSelection.end
      );
    }
  });
  source.addEventListener("mousedown", (event) => {
    pendingPointerSelection = null;
    clearPointerSelectionRestore();
    event.stopPropagation();
  });
  source.addEventListener("mouseup", () => {
    queueMicrotask(clampSourceSelection);
  });
  source.addEventListener("select", clampSourceSelection);
  source.addEventListener("click", (event) => {
    event.stopPropagation();
    queueMicrotask(clampSourceSelection);
  });
  source.addEventListener("beforeinput", (event) => {
    const side = boundarySideAtCaret();
    if (
      event.inputType === "deleteContentBackward" ||
      event.inputType === "deleteContentForward"
    ) {
      if (side) {
        event.preventDefault();
        focusExplanationStart();
        return;
      }
      if (deletionTouchesProtectedSyntax(event.inputType)) {
        event.preventDefault();
      }
      return;
    }
    if (!event.data || !event.inputType.startsWith("insert")) return;
    if (!side) {
      if (redirectLabelInsertion(event.data)) {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    insertAtBoundary(event.data);
  });
  source.addEventListener("input", () => {
    const side = boundaryEntry;
    const value = source.value;
    if (!boundaryValue || value === boundaryValue) return;
    const markerStart = value.indexOf(DEFINITION_SOURCE_OPEN);
    if (
      markerStart > 0 &&
      value.endsWith(DEFINITION_SOURCE_CLOSE)
    ) {
      const prefix = value.slice(0, markerStart);
      const markerSource = value.slice(markerStart);
      source.value = `${DEFINITION_SOURCE_OPEN}${prefix}${markerSource.slice(
        DEFINITION_SOURCE_OPEN.length
      )}`;
      const caret = DEFINITION_SOURCE_OPEN.length + prefix.length;
      source.setSelectionRange(caret, caret);
      return;
    }
    if (side) {
      const afterSide = value.startsWith(boundaryValue);
      if (afterSide) {
        const inserted = value.slice(boundaryValue.length);
        if (!inserted) return;
        source.value = boundaryValue;
        insertAtBoundary(inserted);
        return;
      }
      if (value === boundaryValue.slice(0, -1)) {
        source.value = boundaryValue;
        focusExplanationStart();
        return;
      }
    }
    if (parseFootnoteLabel(value, true) == null) {
      source.value = boundaryValue;
      const range = labelContentRange();
      source.setSelectionRange(range.from, range.to);
    }
  });
  source.addEventListener("keydown", (event) => {
    pendingPointerSelection = null;
    clearPointerSelectionRestore();
    event.stopPropagation();
    const boundarySide = boundarySideAtCaret();
    if (
      boundarySide &&
      (event.key === "Backspace" || event.key === "Delete")
    ) {
      event.preventDefault();
      focusExplanationStart();
      return;
    }
    if (
      boundarySide &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      insertAtBoundary(event.key);
      return;
    }
    const caret = source.selectionStart ?? 0;
    const range = labelContentRange();
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      deletionTouchesProtectedSyntax(
        event.key === "Backspace"
          ? "deleteContentBackward"
          : "deleteContentForward"
      )
    ) {
      event.preventDefault();
      return;
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      redirectLabelInsertion(event.key)
    ) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const pos = getPos();
      const target = verticalTargetAt(view, source, direction);
      finishEditing(true);
      if (target) {
        view.dispatch(
          view.state.tr.setSelection(
            selectionAtPosition(
              view,
              target.position,
              target.bias
            )
          )
        );
      } else if (typeof pos === "number") {
        const exitPos =
          direction < 0
            ? pos
            : firstTextPos(view.state.doc, pos, node.nodeSize ?? 1) ??
              pos;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.near(
              view.state.doc.resolve(exitPos),
              direction
            )
          )
        );
      }
      view.focus();
    } else if (
      event.key === "ArrowLeft" &&
      caret > range.to &&
      caret <= source.value.length
    ) {
      event.preventDefault();
      source.setSelectionRange(range.to, range.to);
    } else if (
      event.key === "ArrowLeft" &&
      caret <= range.from
    ) {
      event.preventDefault();
      const pos = getPos();
      finishEditing(true);
      if (typeof pos === "number") {
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.near(view.state.doc.resolve(pos), -1)
          )
        );
      }
      view.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      source.setSelectionRange(range.from, range.from);
    } else if (event.key === "End") {
      event.preventDefault();
      source.setSelectionRange(range.to, range.to);
    } else if (
      event.key === "ArrowRight" &&
      caret >= range.to
    ) {
      event.preventDefault();
      const pos = getPos();
      finishEditing(true);
      if (typeof pos === "number") {
        const live = view.state.doc.nodeAt(pos);
        const caretAt = live
          ? firstTextPos(view.state.doc, pos, live.nodeSize)
          : null;
        if (caretAt != null) {
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.near(view.state.doc.resolve(caretAt), 1)
            )
          );
        }
      }
      view.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      finishEditing(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishEditing(false);
    }
  });
  source.addEventListener("blur", () => finishEditing(true));
  footnoteLabelOpeners.set(dt, startEditing);

  return {
    dom,
    contentDOM: dd,
    update(updatedNode) {
      if (updatedNode.type !== node.type) return false;
      node = updatedNode;
      updateChrome();
      return true;
    },
    ignoreMutation(mutation) {
      return !dd.contains(mutation.target as Node);
    },
    destroy() {
      editing = false;
      clearPointerSelectionRestore();
      footnoteLabelOpeners.delete(dt);
      document.removeEventListener("mousedown", onOutsideMouseDown, true);
      document.removeEventListener("pointerdown", onOutsideMouseDown, true);
      document.removeEventListener(
        "selectionchange",
        onDocumentSelectionChange
      );
    },
  };
};

export const footnoteDefinitionView = $view(
  footnoteDefinitionSchema.node,
  () => createFootnoteDefinitionView
);

export const createFootnoteReferenceView: NodeViewConstructor = (
  initialNode,
  view,
  getPos
) => {
  let node = initialNode;
  let editing = false;
  let boundaryEntry: "before" | "after" | null = null;
  const dom = document.createElement("sup");
  dom.className = "mt-footnote-reference";
  dom.tabIndex = -1;
  const source = document.createElement("input");
  source.className = "mt-footnote-label-source";
  source.type = "text";
  source.spellcheck = false;
  source.style.display = "none";

  const render = () => {
    const label = String(node.attrs.label ?? "");
    dom.dataset.type = REF;
    dom.dataset.label = label;
    dom.title = "脚注";
    if (!editing) {
      dom.replaceChildren(document.createTextNode(label));
      source.style.display = "none";
      dom.classList.remove("mt-footnote-source-editing");
    }
  };
  render();

  const startEditing = (keyboardEntry = false, fromLeft = true) => {
    if (editing) return;
    editing = true;
    boundaryEntry = keyboardEntry
      ? fromLeft
        ? "before"
        : "after"
      : null;
    source.value = `[^${String(node.attrs.label ?? "")}]`;
    source.style.display = "inline-block";
    dom.replaceChildren(source);
    dom.classList.add("mt-footnote-source-editing");
    document.addEventListener("mousedown", onOutsideMouseDown, true);
    document.addEventListener("pointerdown", onOutsideMouseDown, true);
    source.focus();
    const textLength = source.value.length;
    const start = keyboardEntry
      ? fromLeft
        ? 0
        : textLength
      : 2;
    const end = keyboardEntry
      ? start
      : Math.max(2, textLength - 1);
    source.setSelectionRange(start, end);
  };

  const onOutsideMouseDown = (event: MouseEvent) => {
    if (keepsEditorDuringMenuAction(event.target)) return;
    if (!dom.contains(event.target as Node)) finishEditing(true);
  };

  const finishEditing = (commit: boolean) => {
    if (!editing) return;
    const previous = String(node.attrs.label ?? "");
    const next = commit ? parseFootnoteLabel(source.value) : previous;
    editing = false;
    boundaryEntry = null;
    render();
    if (next && next !== previous) {
      updateFootnoteLabels(view, previous, next);
    }
    document.removeEventListener("mousedown", onOutsideMouseDown, true);
    document.removeEventListener("pointerdown", onOutsideMouseDown, true);
  };

  dom.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if (editing) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    startEditing();
  });
  dom.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!editing) startEditing();
  });
  source.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });
  source.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  source.addEventListener("beforeinput", (event) => {
    const side = boundaryEntry;
    if (!editing || !side || !event.data) return;
    const atBoundary =
      side === "before"
        ? source.selectionStart === 0 && source.selectionEnd === 0
        : source.selectionStart === source.value.length &&
          source.selectionEnd === source.value.length;
    if (
      !atBoundary ||
      !event.inputType.startsWith("insert")
    ) {
      return;
    }
    event.preventDefault();
    const pos = getPos();
    finishEditing(true);
    if (typeof pos !== "number") return;
    const live = view.state.doc.nodeAt(pos);
    if (!live) return;
    const at = side === "before" ? pos : pos + live.nodeSize;
    const tr = view.state.tr.insertText(event.data, at);
    tr.setSelection(
      TextSelection.near(
        tr.doc.resolve(at + event.data.length),
        side === "before" ? -1 : 1
      )
    );
    view.dispatch(tr);
    view.focus();
  });
  source.addEventListener("keydown", (event) => {
    event.stopPropagation();
    const caret = source.selectionStart ?? 0;
    const textLength = source.value.length;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const pos = getPos();
      const target = verticalTargetAt(
        view,
        source,
        direction,
        pos
      );
      finishEditing(true);
      if (target) {
        view.dispatch(
          view.state.tr.setSelection(
            selectionAtPosition(
              view,
              target.position,
              target.bias
            )
          )
        );
      } else if (typeof pos === "number") {
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.near(
              view.state.doc.resolve(
                direction < 0 ? pos : pos + node.nodeSize
              ),
              direction
            )
          )
        );
      }
      view.focus();
    } else if (event.key === "ArrowLeft" && caret === 0) {
      event.preventDefault();
      const pos = getPos();
      finishEditing(true);
      if (typeof pos === "number") {
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.near(view.state.doc.resolve(pos), -1)
          )
        );
      }
      view.focus();
    } else if (
      event.key === "ArrowRight" &&
      caret === textLength
    ) {
      event.preventDefault();
      const pos = getPos();
      finishEditing(true);
      if (typeof pos === "number") {
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.near(
              view.state.doc.resolve(pos + node.nodeSize),
              1
            )
          )
        );
      }
      view.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      finishEditing(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishEditing(false);
    }
  });
  source.addEventListener("blur", () => finishEditing(true));
  footnoteLabelOpeners.set(dom, startEditing);

  return {
    dom,
    update(updatedNode) {
      if (updatedNode.type !== node.type) return false;
      node = updatedNode;
      render();
      return true;
    },
    stopEvent(event) {
      return editing && dom.contains(event.target as Node);
    },
    ignoreMutation: () => true,
    destroy() {
      editing = false;
      footnoteLabelOpeners.delete(dom);
      document.removeEventListener("mousedown", onOutsideMouseDown, true);
      document.removeEventListener("pointerdown", onOutsideMouseDown, true);
    },
  };
};

export const footnoteReferenceView = $view(
  footnoteReferenceSchema.node,
  () => createFootnoteReferenceView
);

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
  // TS 的控制流分析看不到回调里的赋值，这里显式收窄。
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
 * 样式复用现有浮层提示 mt-slash-hint，视觉保持一致。
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
function openFootnoteLabelEditor(
  view: EditorView,
  pos: number,
  keyboardEntry: boolean,
  fromLeft: boolean
): boolean {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return false;
  const target =
    dom.dataset.type === REF
      ? dom
      : dom.dataset.type === DEF
        ? dom.querySelector<HTMLElement>("dt")
        : null;
  const opener = target
    ? footnoteLabelOpeners.get(target)
    : undefined;
  if (!opener) return false;
  opener(keyboardEntry, fromLeft);
  return true;
}

function footnoteKeyboardTarget(
  view: EditorView,
  direction: -1 | 1
): { pos: number; fromLeft: boolean } | null {
  const { selection } = view.state;
  if (!selection.empty) return null;
  const { $from } = selection;

  if (direction > 0) {
    if ($from.nodeAfter?.type.name === REF) {
      return { pos: $from.pos, fromLeft: true };
    }
    if ($from.nodeAfter?.type.name === DEF) {
      return { pos: $from.pos, fromLeft: true };
    }
    if (
      $from.parent.isTextblock &&
      $from.parentOffset === $from.parent.content.size
    ) {
      const after = $from.after($from.depth);
      const $after = view.state.doc.resolve(after);
      if ($after.nodeAfter?.type.name === DEF) {
        return { pos: $after.pos, fromLeft: true };
      }
    }
    return null;
  }

  if ($from.nodeBefore?.type.name === REF) {
    return {
      pos: $from.pos - $from.nodeBefore.nodeSize,
      fromLeft: false,
    };
  }
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== DEF) continue;
    const pos = $from.before(depth);
    const first = firstTextPos(
      view.state.doc,
      pos,
      node.nodeSize
    );
    return first === $from.pos
      ? { pos, fromLeft: false }
      : null;
  }
  return null;
}

function footnoteReferenceClickTarget(
  view: EditorView,
  pos: number
): { pos: number; fromLeft: boolean } | null {
  for (const candidate of [
    Math.max(0, Math.min(pos, view.state.doc.content.size)),
    Math.max(0, Math.min(pos - 1, view.state.doc.content.size)),
  ]) {
    const $pos = view.state.doc.resolve(candidate);
    if ($pos.nodeAfter?.type.name === REF) {
      return { pos: $pos.pos, fromLeft: true };
    }
    if ($pos.nodeBefore?.type.name === REF) {
      return {
        pos: $pos.pos - $pos.nodeBefore.nodeSize,
        fromLeft: false,
      };
    }
  }
  return null;
}

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
export function createFootnoteClickPlugin(): Plugin {
  return new Plugin({
      props: {
        handleClick(view, pos, event) {
          const state = view.state;

          const target = event.target as HTMLElement | null;

          // ---- 点上标 ----
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
              const refPos =
                $pos.nodeAfter === node
                  ? $pos.pos
                  : $pos.pos - node.nodeSize;
              if (
                openFootnoteLabelEditor(
                  view,
                  refPos,
                  false,
                  true
                )
              ) {
                return true;
              }
              return jumpToDefinition(
                view,
                String(node.attrs.label ?? "")
              );
            }
          }
          if (
            target?.closest?.(
              '[data-type="footnote_definition"]'
            )
          ) {
            return false;
          }
          const fallback = footnoteReferenceClickTarget(view, pos);
          if (
            fallback &&
            openFootnoteLabelEditor(
              view,
              fallback.pos,
              true,
              fallback.fromLeft
            )
          ) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        handleKeyDown(view, event) {
          if (event.altKey || event.ctrlKey || event.metaKey) {
            return false;
          }
          if (
            event.key !== "ArrowLeft" &&
            event.key !== "ArrowRight"
          ) {
            return false;
          }
          const direction = event.key === "ArrowLeft" ? -1 : 1;
          const target = footnoteKeyboardTarget(view, direction);
          if (
            !target ||
            !openFootnoteLabelEditor(
              view,
              target.pos,
              true,
              target.fromLeft
            )
          ) {
            return false;
          }
          event.preventDefault();
          return true;
        },
      },
  });
}

export const footnoteClickPlugin = $prose(createFootnoteClickPlugin);

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
export const footnotePlugins = [
  footnoteReferenceView,
  footnoteDefinitionView,
  footnoteKeymapPlugin,
  footnoteClickPlugin,
];
