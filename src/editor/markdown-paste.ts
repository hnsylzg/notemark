function decodeNumericEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replace(/&#(\d+);/g, (entity, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replace(/&nbsp;/gi, " ");
}

/**
 * 剪贴板纯文本可能经历多层 Markdown 转义，例如 `\#`、`\*\*`、
 * `https\://`、`\`\`\``，并由 HTML 文本导出产生 `&#x20;`。
 * “粘贴”按 Markdown 渲染前先去掉这些转义层；“粘贴为纯文本”不经过这里。
 */
export function normalizePastedMarkdown(text: string): string {
  return decodeNumericEntities(text)
    // 行末转义反斜杠多为导出的软换行残留。
    .replace(/\\+[ \t]*(?=\r?\n|$)/g, "")
    // 合并多层转义：\\\# / \\# / \# → #。
    .replace(/\\+([!-/:-@\[-`{-~])/g, "$1");
}
