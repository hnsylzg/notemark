/** Markdown image 节点对应的三个标准属性。 */
export type ImageMarkdownAttrs = {
  src: string;
  alt: string;
  title: string | null;
};

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function decodeEscapes(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const next = value[i + 1];
    if (ch === "\\" && next != null && ESCAPABLE.test(next)) {
      out += next;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

function encodeText(value: string, extra: string): string {
  let out = "";
  for (const ch of value) {
    out += ch === "\\" || extra.includes(ch) ? `\\${ch}` : ch;
  }
  return out;
}

function encodeDestination(src: string): string {
  if (!src) return "";
  if (/[\s()<>]/.test(src)) {
    return `<${encodeText(src, ">")}>`;
  }
  return encodeText(src, "()<>");
}

function encodeTitle(title: string): string {
  return `"${encodeText(title, '"')}"`;
}

/** 节点属性 → 可直接显示的 Markdown 图片源码。 */
export function formatImageMarkdown(attrs: Record<string, unknown>): string {
  const alt = encodeText(String(attrs.alt ?? ""), "[]");
  const src = encodeDestination(String(attrs.src ?? ""));
  const title = attrs.title == null ? "" : String(attrs.title);
  return `![${alt}](${src}${title ? ` ${encodeTitle(title)}` : ""})`;
}

/**
 * 解析单张 Markdown 图片。只接受完整的一条 `![alt](src "title")`，
 * 避免用户失焦时把未完成的半截语法提交成错误节点。
 */
export function parseImageMarkdown(input: string): ImageMarkdownAttrs | null {
  const source = input.trim();
  if (!source.startsWith("![")) return null;

  let i = 2;
  let alt = "";
  let altClosed = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      alt += ch + source[i + 1];
      i += 2;
      continue;
    }
    if (ch === "]") {
      altClosed = true;
      i += 1;
      break;
    }
    alt += ch;
    i += 1;
  }
  if (!altClosed || source[i] !== "(") return null;
  i += 1;
  while (source[i] === " " || source[i] === "\t") i += 1;

  let src = "";
  if (source[i] === "<") {
    i += 1;
    let closed = false;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\" && i + 1 < source.length) {
        src += ch + source[i + 1];
        i += 2;
        continue;
      }
      if (ch === ">") {
        closed = true;
        i += 1;
        break;
      }
      src += ch;
      i += 1;
    }
    if (!closed) return null;
  } else {
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\" && i + 1 < source.length) {
        src += ch + source[i + 1];
        i += 2;
        continue;
      }
      if (ch === ")" || ch === " " || ch === "\t") break;
      src += ch;
      i += 1;
    }
  }

  let hadSeparator = false;
  while (source[i] === " " || source[i] === "\t") {
    hadSeparator = true;
    i += 1;
  }

  let title: string | null = null;
  if (hadSeparator && (source[i] === '"' || source[i] === "'" || source[i] === "(")) {
    const open = source[i];
    const close = open === "(" ? ")" : open;
    i += 1;
    let body = "";
    let closed = false;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\" && i + 1 < source.length) {
        body += ch + source[i + 1];
        i += 2;
        continue;
      }
      if (ch === close) {
        closed = true;
        i += 1;
        break;
      }
      body += ch;
      i += 1;
    }
    if (!closed) return null;
    title = decodeEscapes(body);
    while (source[i] === " " || source[i] === "\t") i += 1;
  }

  if (source[i] !== ")" || i + 1 !== source.length) return null;
  return {
    src: decodeEscapes(src),
    alt: decodeEscapes(alt),
    title,
  };
}
