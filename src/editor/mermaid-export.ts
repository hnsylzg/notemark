/** Word 白底页面或无法从 DOM 读取背景时使用的兜底颜色。 */
export const DEFAULT_MERMAID_EXPORT_BACKGROUND = "#ffffff";

function normalizeCssColor(value: string): string {
  if (!value || value === "none" || value === "transparent") return value;
  const probe = document.createElement("span");
  probe.style.color = value;
  return probe.style.color || value;
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
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement;
    if (root.localName !== "svg" || doc.querySelector("parsererror")) {
      return svg;
    }
    applyMermaidEdgeLabelBackground(root, background);
    preserveMermaidGanttGridLines(root);
    preserveMermaidStateMarkers(root);
    normalizeSvgPathNumbers(root);
    return new XMLSerializer().serializeToString(root);
  } catch {
    return svg;
  }
}
