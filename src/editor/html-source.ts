/**
 * html-source.ts — 将编辑器选区 DOM 格式化为便于阅读的 HTML 源码。
 *
 * 只负责“源码排版”：块级元素分行缩进，行内元素保持连续，pre 内容原样保留。
 * 不改变元素语义，也不添加主题样式。
 */

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const INLINE_ELEMENTS = new Set([
  "a",
  "abbr",
  "acronym",
  "audio",
  "b",
  "bdi",
  "bdo",
  "br",
  "button",
  "canvas",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "mark",
  "math",
  "object",
  "output",
  "picture",
  "q",
  "ruby",
  "s",
  "samp",
  "select",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "svg",
  "textarea",
  "time",
  "tt",
  "u",
  "var",
  "video",
  "wbr",
]);

const PRESERVE_WHITESPACE_ELEMENTS = new Set(["pre", "script", "style"]);

/**
 * ProseMirror/Milkdown 为编辑和剪贴板恢复附加的内部属性，不属于内容语义。
 * Typora 的“复制为 HTML 代码”不会输出这些属性。
 */
const INTERNAL_ATTRIBUTES = new Set([
  "contenteditable",
  "data-label",
  "data-list-type",
  "data-pm-slice",
  "data-spread",
  "data-v-app",
]);

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function openingTag(element: Element): string {
  const attributes = Array.from(element.attributes)
    .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
    .join("");
  return `<${element.tagName.toLowerCase()}${attributes}>`;
}

function closingTag(element: Element): string {
  return `</${element.tagName.toLowerCase()}>`;
}

function isInline(element: Element): boolean {
  return INLINE_ELEMENTS.has(element.tagName.toLowerCase());
}

function isBlankText(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && !node.nodeValue?.trim();
}

/**
 * 清理编辑器内部标记，并把仅含一个段落的列表项压平：
 * <li><p>text</p></li> → <li>text</li>
 */
export function prepareClipboardHtml(root: ParentNode): void {
  root.querySelectorAll("*").forEach((element) => {
    for (const attribute of INTERNAL_ATTRIBUTES) {
      element.removeAttribute(attribute);
    }
  });

  root.querySelectorAll("li").forEach((item) => {
    const children = Array.from(item.childNodes).filter(
      (child) => !isBlankText(child)
    );
    if (children.length !== 1) return;
    const child = children[0];
    if (
      child.nodeType !== Node.ELEMENT_NODE ||
      (child as Element).tagName.toLowerCase() !== "p"
    ) {
      return;
    }
    const paragraph = child as Element;
    item.replaceChildren(...Array.from(paragraph.childNodes));
  });
}

function serializeInlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue ?? "");
  if (node.nodeType === Node.COMMENT_NODE) return `<!--${node.nodeValue ?? ""}-->`;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const open = openingTag(element);
  if (VOID_ELEMENTS.has(tag)) return open;
  if (PRESERVE_WHITESPACE_ELEMENTS.has(tag)) {
    return `${open}${element.innerHTML}${closingTag(element)}`;
  }
  return `${open}${Array.from(element.childNodes)
    .map(serializeInlineNode)
    .join("")}${closingTag(element)}`;
}

function serializeBlockNode(node: Node): string {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const open = openingTag(element);
    if (VOID_ELEMENTS.has(tag)) return open;
    if (PRESERVE_WHITESPACE_ELEMENTS.has(tag)) {
      return `${open}${element.innerHTML}${closingTag(element)}`;
    }

    const children = Array.from(element.childNodes).filter(
      (child) => !isBlankText(child)
    );
    if (children.every((child) =>
      child.nodeType === Node.ELEMENT_NODE
        ? isInline(child as Element)
        : child.nodeType === Node.TEXT_NODE || child.nodeType === Node.COMMENT_NODE
    )) {
      return `${open}${children
        .map(serializeInlineNode)
        .join("")}${closingTag(element)}`;
    }

    const lines = [open];
    let inlineRun = "";
    const flushInlineRun = (): void => {
      if (!inlineRun) return;
      lines.push(inlineRun);
      inlineRun = "";
    };

    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE && !isInline(child as Element)) {
        flushInlineRun();
        lines.push(serializeBlockNode(child));
      } else {
        inlineRun += serializeInlineNode(child);
      }
    }
    flushInlineRun();
    lines.push(closingTag(element));
    return lines.join("\n");
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return escapeText(node.nodeValue ?? "");
  }
  if (node.nodeType === Node.COMMENT_NODE) {
    return `<!--${node.nodeValue ?? ""}-->`;
  }
  return "";
}

/** 格式化一个仅包含选区内容、没有外层包装元素的 DOM 容器。 */
export function formatHtmlFragment(root: ParentNode): string {
  return Array.from(root.childNodes)
    .filter((child) => !isBlankText(child))
    .map((child) => serializeBlockNode(child))
    .join("\n");
}
