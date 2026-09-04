/*
 * katex-export-css.ts — 导出 / 打印的自包含 HTML 内联 KaTeX 样式与字体。
 *
 * 编辑器里公式由 math-view 的 NodeView 调 KaTeX 渲染进真实 DOM（getEditorHtml
 * 取到的 innerHTML 已含 .katex 结构），但 KaTeX 的样式表（katex.min.css）与字体
 * （fonts/*.woff2）在生产构建下由 Vite 抽成 <link> 引入，并不在导出 HTML 的样式
 * 收集范围内（collectRuntimeStyles 只收 <style>，主题 CSS 也不含 katex）。
 * 没有它们，导出 / 打印的 PDF 里公式结构（分式、上下标、定界符）会全部错乱。
 *
 * 这里把 katex.min.css 以 ?raw 取原始文本，再把它引用的字体全部内联成 data URL，
 * 生成一段可独立工作的 CSS 字符串，由 buildStandaloneHtml 注入导出 HTML，
 * 使 PDF 不依赖外部字体文件也能正确渲染公式。
 */
import katexCssRaw from "katex/dist/katex.min.css?raw";

// 所有 katex 字体（woff2 / woff / ttf）以 data URL 形式在构建期编译进产物，
// 这样导出的 HTML 自带字体，不依赖运行时 <link> 或外部字体文件。
const katexFonts = import.meta.glob("/node_modules/katex/dist/fonts/*", {
  query: "?inline",
  import: "default",
  eager: true,
}) as Record<string, string>;

// 文件名 -> data URL（如 "KaTeX_Main-Regular.woff2" -> "data:font/woff2;base64,..."）
const fontByFileName: Record<string, string> = {};
for (const [path, dataUrl] of Object.entries(katexFonts)) {
  const fileName = path.split("/").pop();
  if (fileName) fontByFileName[fileName] = dataUrl;
}

/**
 * 自包含的 KaTeX CSS（字体已内联为 data URL），可直接塞进导出 HTML 的 <style>。
 * 若某个字体未能匹配（理论上不会发生），保留原 url() 不替换，退化为无该字体。
 */
export const katexExportCss = katexCssRaw.replace(
  /url\(\s*['"]?fonts\/([^'")]+)['"]?\s*\)/g,
  (match, fileName: string) => {
    const dataUrl = fontByFileName[fileName];
    return dataUrl ? `url(${dataUrl})` : match;
  }
);
