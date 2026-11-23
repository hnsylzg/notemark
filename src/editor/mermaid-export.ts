/** Word 白底页面或无法从 DOM 读取背景时使用的兜底颜色。 */
export const DEFAULT_MERMAID_EXPORT_BACKGROUND = "#ffffff";

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
    return new XMLSerializer().serializeToString(root);
  } catch {
    return svg;
  }
}
