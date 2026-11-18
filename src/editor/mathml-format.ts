/**
 * MathML 源码格式化。
 *
 * MathML 结构按元素分行缩进；叶子元素（mi/mo/mn、annotation 等）保持单行。
 * 文本内容只做 XML 必要的转义，不改 TeX 原文。
 */
const MATHML_INDENT = "  ";
const INVISIBLE_MATH_OPERATORS = new Set(["\u2061", "\u2062"]);

function escapeXmlText(value: string): string {
  return escapeXmlCharacters(value);
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlCharacters(value, true);
}

function escapeXmlCharacters(value: string, attribute = false): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint > 0x7f) {
      result += `&#x${codePoint.toString(16).toUpperCase()};`;
    } else if (character === "&") {
      result += "&amp;";
    } else if (character === "<") {
      result += "&lt;";
    } else if (character === ">") {
      result += "&gt;";
    } else if (attribute && character === '"') {
      result += "&quot;";
    } else {
      result += character;
    }
  }
  return result;
}

function serializeMathMlNode(node: Node, depth: number): string {
  const indent = MATHML_INDENT.repeat(depth);
  if (node.nodeType === Node.TEXT_NODE) {
    return `${indent}${escapeXmlText(node.nodeValue ?? "")}`;
  }
  if (node.nodeType === Node.COMMENT_NODE) {
    return `${indent}<!--${node.nodeValue ?? ""}-->`;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as Element;
  const tag = element.tagName;
  const attributes = Array.from(element.attributes)
    .map((attribute) => ` ${attribute.name}="${escapeXmlAttribute(attribute.value)}"`)
    .join("");
  const open = `<${tag}${attributes}>`;
  const close = `</${tag}>`;
  const children = Array.from(element.childNodes).filter(
    (child) =>
      child.nodeType !== Node.TEXT_NODE || Boolean(child.nodeValue?.trim())
  );
  if (children.length === 0) return `${indent}${open}${close}`;
  if (
    children.every(
      (child) =>
        child.nodeType === Node.TEXT_NODE ||
        child.nodeType === Node.COMMENT_NODE
    )
  ) {
    return `${indent}${open}${children.map((child) => serializeMathMlNode(child, 0)).join("")}${close}`;
  }

  const lines = [`${indent}${open}`];
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) {
      lines.push(`${MATHML_INDENT.repeat(depth + 1)}${escapeXmlText(child.nodeValue ?? "")}`);
    } else {
      lines.push(serializeMathMlNode(child, depth + 1));
    }
  }
  lines.push(`${indent}${close}`);
  return lines.join("\n");
}

export function formatMathMl(element: Element): string {
  return serializeMathMlNode(element, 0);
}

export function formatMathMlString(source: string): string {
  const template = document.createElement("template");
  template.innerHTML = source;
  const math = template.content.querySelector("math");
  if (!math) return "";
  // MathJax 的 semantic enrichment 仅用于屏幕阅读分析；Typora 的复制结果
  // 不包含这批 data-semantic-* 字段，复制时清理以保持结构和体积一致。
  [math, ...math.querySelectorAll("*")].forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith("data-semantic-")) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  for (const operator of Array.from(math.querySelectorAll("mo"))) {
    if (INVISIBLE_MATH_OPERATORS.has(operator.textContent?.trim() ?? "")) {
      operator.remove();
    }
  }

  for (const row of Array.from(math.querySelectorAll("mrow"))) {
    const parent = row.parentElement;
    if (
      row.hasAttributes() ||
      !parent ||
      !["math", "mrow"].includes(parent.localName)
    ) {
      continue;
    }
    row.replaceWith(...Array.from(row.childNodes));
  }
  return formatMathMl(math);
}
