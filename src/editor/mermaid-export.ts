/** Word 白底页面或无法从 DOM 读取背景时使用的兜底颜色。 */
export const DEFAULT_MERMAID_EXPORT_BACKGROUND = "#ffffff";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

function normalizeCssColor(value: string): string {
  if (!value || value === "none" || value === "transparent") return value;
  const probe = document.createElement("span");
  probe.style.color = value;
  return probe.style.color || value;
}

/**
 * Mermaid kanban serializes ticket links with xlink:href but does not always
 * declare the prefix on the root SVG. Browsers can display the in-memory DOM,
 * while image decoding and Word reject the serialized SVG as malformed XML.
 */
export function ensureMermaidXlinkNamespace(svg: string): string {
  if (!/\bxlink:[\w-]+\s*=/i.test(svg)) return svg;
  const rootTag = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!rootTag || /\bxmlns:xlink\s*=/i.test(rootTag)) return svg;
  return svg.replace(
    rootTag,
    rootTag.replace(
      /<svg\b/i,
      `<svg xmlns:xlink="${XLINK_NAMESPACE}"`
    )
  );
}

const HSL_COLOR_PATTERN = /hsla?\([^)]*\)/gi;

/**
 * Word's SVG color parser handles RGB reliably but not all HSL/HSLA values.
 * Normalize embedded CSS and paint attributes before Word receives the SVG.
 */
export function normalizeMermaidHslColors(svg: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement;
    if (root.localName !== "svg" || doc.querySelector("parsererror")) {
      return svg;
    }
    const normalize = (value: string) =>
      value.replace(HSL_COLOR_PATTERN, (color) => normalizeCssColor(color));
    for (const style of doc.querySelectorAll("style")) {
      style.textContent = normalize(style.textContent ?? "");
    }
    for (const element of [root, ...root.querySelectorAll("*")]) {
      for (const name of ["style", "fill", "stroke", "stop-color"]) {
        const value = element.getAttribute(name);
        if (value) element.setAttribute(name, normalize(value));
      }
    }
    return new XMLSerializer().serializeToString(root);
  } catch {
    return svg;
  }
}

function parseCssDeclarations(css: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const declaration of css.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const name = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (name && value) declarations[name] = value;
  }
  return declarations;
}

function readCssRuleDeclarations(
  root: Element,
  selectorSuffix: string
): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const style of root.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = rulePattern.exec(css))) {
      const selectors = match[1]
        .split(",")
        .map((selector) => selector.trim());
      if (!selectors.some((selector) => selector.endsWith(selectorSuffix))) {
        continue;
      }
      Object.assign(declarations, parseCssDeclarations(match[2]));
    }
  }
  return declarations;
}

/**
 * Word needs explicit line geometry and paint values. Mermaid 12 emits Gantt
 * grid lines with only `y2` and relies on SVG defaults plus inherited CSS;
 * both omissions make the vertical grid disappear in embedded Word SVG.
 */
export function preserveMermaidGanttGridLines(root: Element): void {
  const tickStyle = readCssRuleDeclarations(root, ".grid .tick");
  const stroke = tickStyle.stroke;
  const strokeWidth = tickStyle["stroke-width"] ?? "1";
  const shapeRendering = tickStyle["shape-rendering"];
  for (const line of root.querySelectorAll<SVGLineElement>(
    ".grid .tick line"
  )) {
    for (const name of ["x1", "y1", "x2"]) {
      if (!line.hasAttribute(name)) line.setAttribute(name, "0");
    }
    if (stroke) {
      line.setAttribute("stroke", stroke);
      line.style.setProperty("stroke", stroke, "important");
    }
    line.setAttribute("stroke-width", strokeWidth);
    line.style.setProperty("stroke-width", strokeWidth, "important");
    if (shapeRendering) {
      line.setAttribute("shape-rendering", shapeRendering);
      line.style.setProperty(
        "shape-rendering",
        shapeRendering,
        "important"
      );
    }
  }
}

/**
 * Mermaid venn-beta places the title baseline near y=0 while using a large
 * font size. Browsers may paint outside the SVG viewport, but Word clips it.
 * Shift the whole rendered Venn diagram down when the title baseline cannot
 * fit the font ascent, then grow the viewBox by the same inset. Moving only
 * the title would reduce the original gap between the title and circles.
 */
export function preserveMermaidVennTitle(root: Element): void {
  const titles = Array.from(
    root.querySelectorAll<SVGTextElement>(".venn-title")
  );
  if (titles.length === 0) return;
  const declarations = readCssRuleDeclarations(root, ".venn-title");
  const fontSize = Number.parseFloat(declarations["font-size"] ?? "");
  if (!Number.isFinite(fontSize) || fontSize <= 0) return;
  const baselines = titles
    .map((title) => Number.parseFloat(title.getAttribute("y") ?? ""))
    .filter((value) => Number.isFinite(value));
  if (baselines.length === 0) return;
  const inset = Math.max(0, fontSize - Math.min(...baselines));
  if (inset <= 0) return;

  const content = Array.from(root.children).filter(
    (child) => !["style", "defs", "title", "desc"].includes(child.localName)
  );
  if (content.length > 0) {
    const wrapper = root.ownerDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "g"
    );
    wrapper.setAttribute("data-mermaid-export-offset", "true");
    wrapper.setAttribute("transform", `translate(0 ${inset})`);
    root.insertBefore(wrapper, content[0]);
    for (const child of content) wrapper.appendChild(child);
  }

  const values = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    values.length === 4 &&
    values.every((value) => Number.isFinite(value))
  ) {
    root.setAttribute(
      "viewBox",
      `${values[0]} ${values[1]} ${values[2]} ${values[3] + inset}`
    );
  }
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  if (Number.isFinite(height)) {
    root.setAttribute("height", String(height + inset));
  }
}

/**
 * Word does not consistently honor Mermaid Ishikawa's CSS
 * `dominant-baseline: middle/hanging`, so text renders slightly above its box.
 * Convert those labels to explicit baseline offsets in the export copy.
 */
export function preserveMermaidIshikawaTextBaseline(root: Element): void {
  if (root.getAttribute("aria-roledescription") !== "ishikawa") return;
  const textDeclarations = readCssRuleDeclarations(root, ".ishikawa text");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;
  const fontSize = Number.parseFloat(textDeclarations["font-size"] ?? "");
  if (!Number.isFinite(fontSize) || fontSize <= 0) return;
  const fontFamily =
    textDeclarations["font-family"] ||
    "sans-serif";
  const offsetFor = (baseline: "middle" | "hanging"): number | null => {
    context.font = `${fontSize}px ${fontFamily}`;
    context.textBaseline = baseline;
    const metrics = context.measureText("Hgj");
    const offset = Math.abs(metrics.alphabeticBaseline);
    return Number.isFinite(offset) && offset > 0
      ? Number(offset.toFixed(4))
      : null;
  };
  for (const text of root.querySelectorAll<SVGTextElement>(
    ".ishikawa-head-label, .ishikawa-label"
  )) {
    const classes = text.classList;
    const baseline = classes.contains("down")
      ? "hanging"
      : classes.contains("up")
        ? null
        : classes.contains("ishikawa-head-label") ||
            classes.contains("cause") ||
            classes.contains("align")
          ? "middle"
          : null;
    const offset = baseline ? offsetFor(baseline) : null;
    if (offset == null) continue;
    text.style.setProperty("dominant-baseline", "auto", "important");
    text.setAttribute("dominant-baseline", "auto");
    const textY = Number.parseFloat(text.getAttribute("y") ?? "");
    if (Number.isFinite(textY)) {
      text.setAttribute("y", String(Number((textY + offset).toFixed(4))));
    } else if (!text.hasAttribute("dy")) {
      text.setAttribute("dy", String(offset));
    }
  }
}

function inlineSvgPaintDeclarations(
  element: SVGElement,
  declarations: Record<string, string>
): void {
  for (const name of [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-opacity",
    "stroke-width",
  ]) {
    const value = declarations[name];
    if (!value) continue;
    element.setAttribute(name, value);
    element.style.setProperty(name, value, "important");
  }
}

function removeSvgFilters(element: SVGElement): void {
  element.removeAttribute("filter");
  element.style.removeProperty("filter");
}

const SVG_PATH_RADIUS_PATTERN =
  /^M\s*([-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?)/;

function pathStartRadius(path: SVGPathElement): number | null {
  const match = SVG_PATH_RADIUS_PATTERN.exec(path.getAttribute("d") ?? "");
  if (!match) return null;
  const radius = Number(match[1]);
  return Number.isFinite(radius) && radius > 0 ? radius : null;
}

function simplifyMermaidStateEndMarker(root: Element): void {
  for (const node of root.querySelectorAll<SVGGElement>(
    '[id*="state-root_end"]'
  )) {
    const outer = node.querySelector<SVGGElement>(".outer-path");
    if (!outer) continue;
    const paths = Array.from(outer.querySelectorAll<SVGPathElement>("path"))
      .map((path) => ({
        path,
        radius: pathStartRadius(path),
      }))
      .filter(
        (entry): entry is { path: SVGPathElement; radius: number } =>
          entry.radius !== null
      );
    if (paths.length < 2) continue;
    const outerRadius = Math.max(...paths.map((entry) => entry.radius));
    const innerRadius = Math.min(...paths.map((entry) => entry.radius));
    if (outerRadius === innerRadius) continue;
    const viaRadius = (radius: number) =>
      paths.filter((entry) => entry.radius === radius);
    const outerPaths = viaRadius(outerRadius);
    const innerPaths = viaRadius(innerRadius);
    const outerFill = outerPaths.find(
      ({ path }) => path.getAttribute("fill")?.toLowerCase() !== "none"
    )?.path.getAttribute("fill");
    const outerStroke = outerPaths.find(
      ({ path }) => path.getAttribute("stroke")?.toLowerCase() !== "none"
    );
    const innerFill = innerPaths.find(
      ({ path }) => path.getAttribute("fill")?.toLowerCase() !== "none"
    )?.path.getAttribute("fill");
    const innerStroke = innerPaths.find(
      ({ path }) => path.getAttribute("stroke")?.toLowerCase() !== "none"
    );

    const makeCircle = (
      radius: number,
      fill: string | null | undefined,
      strokePath: { path: SVGPathElement } | undefined
    ): SVGCircleElement => {
      const circle = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle"
      );
      circle.setAttribute("r", String(radius));
      if (fill) circle.setAttribute("fill", fill);
      const stroke = strokePath?.path.getAttribute("stroke");
      const strokeWidth = strokePath?.path.getAttribute("stroke-width");
      if (stroke) circle.setAttribute("stroke", stroke);
      if (strokeWidth) circle.setAttribute("stroke-width", strokeWidth);
      return circle;
    };

    outer.replaceChildren(
      makeCircle(outerRadius, outerFill, outerStroke),
      makeCircle(innerRadius, innerFill, innerStroke)
    );
    removeSvgFilters(outer);
  }
}

/**
 * State diagrams color the start/end markers only through class selectors.
 * Embedded Word SVG ignores those selectors, so copy the resolved paint.
 */
export function preserveMermaidStateMarkers(root: Element): void {
  for (const selector of [
    ".node circle.state-start",
    ".node circle.state-end",
    ".end-state-inner",
  ]) {
    const declarations = readCssRuleDeclarations(root, selector);
    if (Object.keys(declarations).length === 0) continue;
    for (const element of root.querySelectorAll<SVGElement>(selector)) {
      inlineSvgPaintDeclarations(element, declarations);
      removeSvgFilters(element);
    }
  }
  for (const element of root.querySelectorAll<SVGElement>(
    '[id*="state-root_end"] .outer-path'
  )) {
    removeSvgFilters(element);
  }
  simplifyMermaidStateEndMarker(root);
}

const SVG_PATH_NUMBER_PATTERN =
  /[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g;

function normalizeSvgNumber(value: string): string {
  if (!/[eE]/.test(value)) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  if (Math.abs(number) < 1e-12) return "0";
  return number
    .toFixed(12)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

/** Word's SVG path parser does not consistently accept exponent notation. */
export function normalizeSvgPathNumbers(root: Element): void {
  for (const path of root.querySelectorAll<SVGPathElement>("path[d]")) {
    const value = path.getAttribute("d");
    if (!value || !/[eE]/.test(value)) continue;
    path.setAttribute(
      "d",
      value.replace(SVG_PATH_NUMBER_PATTERN, normalizeSvgNumber)
    );
  }
}

/** 读取图表所在页面的实际背景色，避免导出依赖页面 CSS。 */
export function resolveMermaidExportBackground(
  element: Element | null
): string {
  let current = element;
  while (current instanceof HTMLElement) {
    const inline = current.style.getPropertyValue("--mt-color-bg").trim();
    if (inline && !inline.startsWith("var(") && inline !== "transparent") {
      return inline;
    }
    const style = getComputedStyle(current);
    const themed = style.getPropertyValue("--mt-color-bg").trim();
    if (themed && !themed.startsWith("var(") && themed !== "transparent") {
      return themed;
    }
    const computed = style.backgroundColor.trim();
    if (
      computed &&
      computed !== "transparent" &&
      computed !== "rgba(0, 0, 0, 0)"
    ) {
      return computed;
    }
    current = current.parentElement;
  }
  return DEFAULT_MERMAID_EXPORT_BACKGROUND;
}

/** 把连线标签的实际背景和透明度写入 SVG，供脱离页面 CSS 的导图使用。 */
export function applyMermaidEdgeLabelBackground(
  root: SVGSVGElement | Element,
  background: string
): void {
  for (const rect of root.querySelectorAll<SVGRectElement>(".edgeLabel rect")) {
    rect.setAttribute("fill", background);
    rect.setAttribute("opacity", "1");
    rect.style.setProperty("fill", background, "important");
    rect.style.setProperty("opacity", "1", "important");
  }
}

/** 对 SVG 字符串执行边标签背景规范化，并返回新的 SVG 文本。 */
export function normalizeMermaidSvgForExport(
  svg: string,
  background: string
): string {
  try {
    const doc = new DOMParser().parseFromString(
      ensureMermaidXlinkNamespace(svg),
      "image/svg+xml"
    );
    const root = doc.documentElement;
    if (root.localName !== "svg" || doc.querySelector("parsererror")) {
      return svg;
    }
    applyMermaidEdgeLabelBackground(root, background);
    preserveMermaidGanttGridLines(root);
    preserveMermaidVennTitle(root);
    preserveMermaidIshikawaTextBaseline(root);
    preserveMermaidStateMarkers(root);
    normalizeSvgPathNumbers(root);
    return new XMLSerializer().serializeToString(root);
  } catch {
    return svg;
  }
}
