export interface SourceTabEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

const SOURCE_TAB = "\t";
const SOURCE_OUTDENT_SPACES = 4;
const MAX_BLOCKQUOTE_LEADING_SPACES = 3;

function lineStartAt(value: string, offset: number): number {
  return value.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function selectedLineEnd(
  value: string,
  selectionStart: number,
  selectionEnd: number
): number {
  if (
    selectionEnd > selectionStart &&
    value[selectionEnd - 1] === "\n"
  ) {
    return selectionEnd - 1;
  }
  return selectionEnd;
}

function outdentWidth(line: string): number {
  if (line.startsWith(SOURCE_TAB)) return SOURCE_TAB.length;
  let spaces = 0;
  while (
    spaces < SOURCE_OUTDENT_SPACES &&
    line[spaces] === " "
  ) {
    spaces += 1;
  }
  return spaces;
}

function blockquoteContinuation(
  line: string
): { prefix: string; contentStart: number } | null {
  let cursor = 0;
  let prefix = "";
  while (true) {
    const markerStart = cursor;
    let leadingSpaces = 0;
    while (
      leadingSpaces < MAX_BLOCKQUOTE_LEADING_SPACES &&
      line[cursor] === " "
    ) {
      cursor += 1;
      leadingSpaces += 1;
    }
    if (line[cursor] !== ">") {
      cursor = markerStart;
      break;
    }
    cursor += 1;
    prefix += `${line.slice(markerStart, cursor)} `;
    if (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
  }
  return prefix ? { prefix, contentStart: cursor } : null;
}

/**
 * Tab indents every selected line. A collapsed selection inserts one tab.
 * Shift+Tab removes one leading tab or up to one standard four-space indent.
 */
export function applySourceTab(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean
): SourceTabEdit {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  if (start === end && !outdent) {
    return {
      value: `${value.slice(0, start)}${SOURCE_TAB}${value.slice(start)}`,
      selectionStart: start + SOURCE_TAB.length,
      selectionEnd: start + SOURCE_TAB.length,
    };
  }

  const from = lineStartAt(value, start);
  const selectedEnd = selectedLineEnd(value, start, end);
  const newlineAfterSelection = value.indexOf("\n", selectedEnd);
  const to =
    newlineAfterSelection < 0
      ? value.length
      : newlineAfterSelection + 1;
  const segment = value.slice(from, to);
  const endsWithNewline = segment.endsWith("\n");
  const lines = segment.split("\n");
  if (endsWithNewline) lines.pop();

  let offsetAtStart = 0;
  let offsetAtEnd = 0;
  let lineStart = from;
  const transformedLines = lines.map((line) => {
    const width = outdent ? outdentWidth(line) : 0;
    const inserted = outdent ? 0 : SOURCE_TAB.length;
    const contribution = inserted - width;
    if (start >= lineStart) {
      offsetAtStart += outdent
        ? -Math.min(width, start - lineStart)
        : contribution;
    }
    if (end >= lineStart) {
      offsetAtEnd += outdent
        ? -Math.min(width, end - lineStart)
        : contribution;
    }
    lineStart += line.length + 1;
    return outdent ? line.slice(width) : `${SOURCE_TAB}${line}`;
  });
  const replacement =
    transformedLines.join("\n") + (endsWithNewline ? "\n" : "");
  return {
    value:
      value.slice(0, from) +
      replacement +
      value.slice(to),
    selectionStart: Math.max(from, start + offsetAtStart),
    selectionEnd: Math.max(from, end + offsetAtEnd),
  };
}

/**
 * Plain Enter in a source textarea continues leading indentation. Blockquotes
 * continue only their marker depth; indentation inside the quote is not copied.
 */
export function applySourceEnter(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  continueBlockquotes = true
): SourceTabEdit | null {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  if (start !== end) return null;

  const lineStart = lineStartAt(value, start);
  if (start === lineStart) return null;
  const newlineAfterCursor = value.indexOf("\n", start);
  const lineEnd =
    newlineAfterCursor < 0 ? value.length : newlineAfterCursor;
  const line = value.slice(lineStart, lineEnd);

  const blockquote = continueBlockquotes
    ? blockquoteContinuation(line)
    : null;
  let continuation: string | null = null;
  if (blockquote) {
    const quoteContent = line.slice(blockquote.contentStart).trim();
    continuation = quoteContent ? blockquote.prefix : "";
  } else {
    const indent = line.match(/^[ \t]*/)?.[0] ?? "";
    if (indent && line.slice(indent.length).trim()) {
      continuation = indent;
    }
  }
  if (continuation === null) return null;

  const insertion = `\n${continuation}`;
  return {
    value: value.slice(0, start) + insertion + value.slice(start),
    selectionStart: start + insertion.length,
    selectionEnd: start + insertion.length,
  };
}

function applyTextareaEdit(
  textarea: HTMLTextAreaElement,
  edit: SourceTabEdit
): void {
  const scrollTop = textarea.scrollTop;
  textarea.value = edit.value;
  textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.scrollTop = scrollTop;
  textarea.focus();
}

/**
 * Shared DOM adapter for source textareas. It preserves scroll/focus and
 * emits the normal input event so existing draft/history handlers still run.
 */
export function handleSourceKeydown(
  event: KeyboardEvent,
  textarea: HTMLTextAreaElement
): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;

  if (event.key === "Enter" && !event.shiftKey) {
    const edit = applySourceEnter(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd
    );
    if (!edit) return false;
    event.preventDefault();
    event.stopPropagation();
    applyTextareaEdit(textarea, edit);
    return true;
  }

  if (event.key !== "Tab") return false;
  event.preventDefault();
  event.stopPropagation();
  const edit = applySourceTab(
    textarea.value,
    textarea.selectionStart,
    textarea.selectionEnd,
    event.shiftKey
  );
  if (
    edit.value === textarea.value &&
    edit.selectionStart === textarea.selectionStart &&
    edit.selectionEnd === textarea.selectionEnd
  ) {
    return true;
  }
  applyTextareaEdit(textarea, edit);
  return true;
}
