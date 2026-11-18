const TABLE_COLUMN_GAP = "  ";
const WIDE_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Emoji_Presentation}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u;

type TableAlignment = "left" | "center" | "right";

function normalizeCellText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function displayWidth(text: string): number {
  return Array.from(text).reduce(
    (width, character) => width + (WIDE_CHAR.test(character) ? 2 : 1),
    0
  );
}

function cellAlignment(cell: HTMLTableCellElement): TableAlignment {
  const alignment = (
    cell.style.textAlign ||
    cell.getAttribute("align") ||
    "left"
  ).toLowerCase();
  return alignment === "center" || alignment === "right"
    ? alignment
    : "left";
}

function alignCell(
  text: string,
  width: number,
  alignment: TableAlignment
): string {
  const padding = Math.max(0, width - displayWidth(text));
  if (alignment === "right") return `${" ".repeat(padding)}${text}`;
  if (alignment === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
  }
  return `${text}${" ".repeat(padding)}`;
}

/** Format a table as space-aligned plain text using terminal-style display widths. */
export function tableToAlignedPlainText(table: HTMLTableElement): string {
  const rows = Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) => ({
      alignment: cellAlignment(cell),
      text: normalizeCellText(cell.textContent ?? ""),
    }))
  );
  if (rows.length === 0) return "";

  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(0, ...rows.map((row) => displayWidth(row[column]?.text ?? "")))
  );

  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          alignCell(cell.text, widths[column], cell.alignment)
        )
        .join(TABLE_COLUMN_GAP)
        .trimEnd()
    )
    .join("\n");
}

export function tableHtmlToAlignedPlainText(html: string): string | null {
  const template = document.createElement("template");
  template.innerHTML = html;
  const table = template.content.querySelector("table");
  return table ? tableToAlignedPlainText(table) : null;
}

/** Keep explicit center/right table alignment, but omit the schema's default left style. */
export function normalizeTableClipboardHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;

  for (const cell of template.content.querySelectorAll<HTMLTableCellElement>(
    "td, th"
  )) {
    if (cell.style.textAlign.toLowerCase() === "left") {
      cell.style.removeProperty("text-align");
      changed = true;
    }
    if (cell.getAttribute("align")?.toLowerCase() === "left") {
      cell.removeAttribute("align");
      changed = true;
    }
    if (cell.hasAttribute("style") && !cell.style.length) {
      cell.removeAttribute("style");
    }
  }

  return changed ? template.innerHTML : html;
}
