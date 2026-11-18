/*
 * Mermaid 历史数学渲染接口兼容层。
 *
 * Mermaid 内部要求一个同步 renderToString() 接口来处理图中 $$...$$ 标签。
 * 本应用统一使用 MathJax，因此这里只提供最小兼容接口，实际输出仍由 MathJax 生成。
 */
import { mathJaxMathMlSync } from "./mathjax";

interface MathRendererCompatOptions {
  displayMode?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderToString(
  tex: string,
  options: MathRendererCompatOptions = {}
): string {
  try {
    return mathJaxMathMlSync(tex, options.displayMode === true);
  } catch {
    return `<span class="mt-math-source">${escapeHtml(tex)}</span>`;
  }
}

export default { renderToString };
