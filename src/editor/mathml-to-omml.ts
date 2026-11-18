import { mml2omml } from "mathml2omml";

const OMML_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/math";
const MATH_TEXT_ELEMENTS = new Set(["mi", "mn", "mo", "mtext", "ms"]);
const VARIANT_START = "\uE000";
const VARIANT_SEPARATOR = "\uE001";
const VARIANT_END = "\uE002";
const OMML_LAYOUT_LOSS_SELECTOR = [
  "mspace[width]",
  "mpadded[height]",
  "mpadded[depth]",
  "mpadded[voffset]",
].join(",");

type OmmlMathStyle = "p" | "b" | "i" | "bi";

interface OmmlVariantStyle {
  script?: "script" | "fraktur" | "double-struck" | "sans-serif" | "monospace";
  style: OmmlMathStyle;
}

/**
 * mathvariant2omml 目前只处理 bold/italic，其他标准数学字母体会被写成
 * m:sty="undefined" 的普通文本。这里按 OMML 的 m:scr + m:sty 语义补齐。
 */
const OMML_VARIANT_STYLES: Record<string, OmmlVariantStyle> = {
  normal: { style: "p" },
  script: { script: "script", style: "p" },
  "bold-script": { script: "script", style: "b" },
  fraktur: { script: "fraktur", style: "p" },
  "bold-fraktur": { script: "fraktur", style: "b" },
  "double-struck": { script: "double-struck", style: "p" },
  "sans-serif": { script: "sans-serif", style: "p" },
  "bold-sans-serif": { script: "sans-serif", style: "b" },
  "sans-serif-bold": { script: "sans-serif", style: "b" },
  "sans-serif-italic": { script: "sans-serif", style: "i" },
  "sans-serif-bold-italic": { script: "sans-serif", style: "bi" },
  monospace: { script: "monospace", style: "p" },
};

interface PreparedMathMl {
  mathml: string;
  styles: OmmlVariantStyle[];
}

/**
 * mml2omml 会丢弃 mspace width 和 mpadded 的垂直布局属性。
 * 带这些属性的公式应降级为 SVG 图像，避免导出后字距、上下标位置失真。
 */
export function mathMlRequiresRasterFallback(mathml: string): boolean {
  const document = new DOMParser().parseFromString(mathml, "application/xml");
  if (document.querySelector("parsererror")) return false;
  return document.querySelector(OMML_LAYOUT_LOSS_SELECTOR) !== null;
}

function effectiveMathVariant(element: Element): string {
  let current: Element | null = element;
  while (current) {
    const variant = current.getAttribute("mathvariant");
    if (variant) return variant;
    current = current.parentElement;
  }
  return "";
}

function prepareMathVariantMarkers(mathml: string): PreparedMathMl {
  const document = new DOMParser().parseFromString(mathml, "application/xml");
  if (document.querySelector("parsererror")) {
    return { mathml, styles: [] };
  }

  const styles: OmmlVariantStyle[] = [];
  for (const element of document.getElementsByTagName("*")) {
    if (
      !MATH_TEXT_ELEMENTS.has(element.localName) ||
      element.children.length > 0
    ) {
      continue;
    }
    const text = element.textContent ?? "";
    const style = OMML_VARIANT_STYLES[effectiveMathVariant(element)];
    if (!text || !style) continue;

    const index = styles.push(style) - 1;
    element.textContent =
      `${VARIANT_START}${index}${VARIANT_SEPARATOR}` +
      `${text}${VARIANT_END}`;
  }

  for (const element of document.getElementsByTagName("*")) {
    const variant = element.getAttribute("mathvariant");
    if (variant && OMML_VARIANT_STYLES[variant]) {
      element.removeAttribute("mathvariant");
    }
  }

  return {
    mathml: new XMLSerializer().serializeToString(document),
    styles,
  };
}

function createMathElement(
  document: Document,
  localName: string,
  value: string
): Element {
  const element = document.createElementNS(OMML_NS, `m:${localName}`);
  element.setAttributeNS(OMML_NS, "m:val", value);
  return element;
}

function applyOmmlVariant(run: Element, style: OmmlVariantStyle): void {
  const document = run.ownerDocument;
  let properties = run.getElementsByTagNameNS(OMML_NS, "rPr")[0] ?? null;
  if (!properties) {
    properties = document.createElementNS(OMML_NS, "m:rPr");
    run.insertBefore(properties, run.firstChild);
  }

  for (const child of Array.from(properties.children)) {
    if (child.namespaceURI === OMML_NS && ["nor", "scr", "sty"].includes(child.localName)) {
      properties.removeChild(child);
    }
  }
  if (style.script) {
    properties.append(createMathElement(document, "scr", style.script));
  }
  properties.append(createMathElement(document, "sty", style.style));
}

function restoreMathVariantRuns(
  omml: string,
  styles: readonly OmmlVariantStyle[]
): string {
  if (!omml.includes(VARIANT_START)) return omml;

  const document = new DOMParser().parseFromString(omml, "application/xml");
  if (document.querySelector("parsererror")) return omml;

  const marker = new RegExp(
    `${VARIANT_START}(\\d+)${VARIANT_SEPARATOR}([\\s\\S]*?)${VARIANT_END}`,
    "g"
  );
  for (const textElement of Array.from(
    document.getElementsByTagNameNS(OMML_NS, "t")
  )) {
    const text = textElement.textContent ?? "";
    const run = textElement.parentElement;
    if (!text.includes(VARIANT_START) || !run) continue;

    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of text.matchAll(marker)) {
      const index = match.index ?? 0;
      if (index > offset) {
        fragment.append(cloneRunText(document, run, text.slice(offset, index)));
      }
      const style = styles[Number(match[1])];
      if (style) {
        fragment.append(cloneRunText(document, run, match[2], style));
      }
      offset = index + match[0].length;
    }
    if (offset < text.length) {
      fragment.append(cloneRunText(document, run, text.slice(offset)));
    }
    run.replaceWith(fragment);
  }

  return new XMLSerializer().serializeToString(document);
}

function cloneRunText(
  document: Document,
  sourceRun: Element,
  text: string,
  style?: OmmlVariantStyle
): Element {
  const run = sourceRun.cloneNode(true) as Element;
  const textElement = run.getElementsByTagNameNS(OMML_NS, "t")[0];
  if (textElement) {
    textElement.textContent = text;
  } else {
    const fallback = document.createElementNS(OMML_NS, "m:t");
    fallback.textContent = text;
    run.append(fallback);
  }
  if (style) applyOmmlVariant(run, style);
  return run;
}

/** MathJax MathML -> Word OMML，并保留标准数学字母体。 */
export function mathMlToOmml(mathml: string): string {
  const prepared = prepareMathVariantMarkers(mathml);
  return restoreMathVariantRuns(mml2omml(prepared.mathml), prepared.styles);
}
