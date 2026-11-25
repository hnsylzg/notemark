/*
 * Mermaid rendering shared by code-block previews, HTML export and Word export.
 * The editor no longer has a standalone Mermaid ProseMirror node.
 */
import { loadMathJax } from "./mathjax";

type MermaidLike = {
  initialize(config: unknown): void;
  render(id: string, text: string): Promise<{ svg: string }>;
};

const isDarkTheme = () =>
  document.documentElement.dataset.theme === "dark";

/**
 * Mermaid 的 SVG 几何由字体度量参与计算。固定为内置主题使用的字体栈，
 * 可保证所有主题的框、文字基线和导出结果一致；主题只负责配色。
 */
export const MERMAID_FONT_FAMILY =
  '"Open Sans", "Clear Sans", "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", "Segoe UI Emoji", sans-serif';

function readMermaidTheme(): string | null {
  const el = document.querySelector<HTMLElement>(".milkdown .diagram");
  if (!el) return null;
  const style = getComputedStyle(el);
  return style.getPropertyValue("--mermaid-theme").trim() || null;
}

/** 组装 Mermaid 配置：主题只覆盖配色，字体和图形几何保持全局一致。 */
export function getMermaidConfig(): Record<string, unknown> {
  return {
    startOnLoad: false,
    theme: readMermaidTheme() ?? (isDarkTheme() ? "dark" : "redux"),
    look: "classic",
    layout: "dagre",
    fontFamily: MERMAID_FONT_FAMILY,
    // 用纯 SVG <text> 渲染标签，避免 foreignObject 导致 Word/PDF 文字裁切。
    htmlLabels: false,
    flowchart: { look: "classic" },
  };
}

let mermaidPromise: Promise<MermaidLike> | null = null;
const MERMAID_SVG_CACHE_LIMIT = 100;
const mermaidSvgCache = new Map<string, Promise<string>>();

function getMermaid(): Promise<MermaidLike> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(
      (mod) => (mod.default ?? mod) as MermaidLike
    );
  }
  return mermaidPromise;
}

function cacheMermaidSvg(
  key: string,
  promise: Promise<string>
): Promise<string> {
  if (mermaidSvgCache.size >= MERMAID_SVG_CACHE_LIMIT) {
    const oldest = mermaidSvgCache.keys().next().value;
    if (oldest) mermaidSvgCache.delete(oldest);
  }
  mermaidSvgCache.set(key, promise);
  void promise.catch(() => {
    if (mermaidSvgCache.get(key) === promise) mermaidSvgCache.delete(key);
  });
  return promise;
}

function mermaidUsesMathJax(source: string): boolean {
  return /\$\$[\s\S]*\$\$/.test(source);
}

/** Render a Mermaid source string with the editor's active theme settings. */
export async function renderMermaidSvg(
  value: string,
  identity: string,
  revision: number
): Promise<string> {
  const config = getMermaidConfig();
  const cacheKey = `${JSON.stringify(config)}\u0000${value}`;
  const cached = mermaidSvgCache.get(cacheKey);
  if (cached) return cached;

  const renderPromise = (async () => {
    // Only Mermaid labels using $$...$$ need MathJax. Waiting for it for every
    // diagram kept ordinary flowcharts stuck on the loading preview.
    if (mermaidUsesMathJax(value)) await loadMathJax();
    const mermaid = await getMermaid();
    mermaid.initialize(config);
    const safeIdentity = identity.replace(/[^a-zA-Z0-9_-]/g, "-");
    const { svg } = await mermaid.render(
      `diagram-${safeIdentity}-${revision}`,
      value
    );
    return svg;
  })();
  return cacheMermaidSvg(cacheKey, renderPromise);
}

/** 所有存活 Mermaid 预览的重渲染回调（主题切换时全部刷新） */
const renderers = new Set<() => void>();

/** Register a preview renderer that must refresh when the Mermaid theme changes. */
export function subscribeMermaidTheme(renderer: () => void): () => void {
  renderers.add(renderer);
  return () => renderers.delete(renderer);
}

let themeObserver: MutationObserver | null = null;
function watchThemeSwitch(): void {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => {
    for (const render of renderers) render();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}
watchThemeSwitch();

/**
 * 监听自定义主题 <style id="custom-theme"> 的注入与内容变化：
 * 主题管理器（themeManager）通过原地替换该 style 的 textContent 应用主题，
 * 不会触发 data-theme 的 MutationObserver，因此 mermaid 图表（其配置在渲染时
 * 从 CSS 变量读取）不会自动重渲染。这里补一个对 custom-theme 的监听，
 * 让切换 / 重新导入主题后图表立即按新配置刷新；主题被移除时回退到内置默认配置。
 */
function watchCustomTheme(): void {
  const rerenderAll = () => {
    for (const render of renderers) render();
  };
  const styleObserver = new MutationObserver(rerenderAll);
  const observed = new WeakSet<Element>();
  let lastHadStyle: boolean | null = null;

  const sync = () => {
    const style = document.getElementById("custom-theme");
    const has = !!style;
    if (style && !observed.has(style)) {
      styleObserver.observe(style, { childList: true, subtree: true });
      observed.add(style);
      rerenderAll();
    }
    if (has !== lastHadStyle) {
      lastHadStyle = has;
      if (!has) rerenderAll(); // 主题移除：回退默认 mermaid 配置
    }
  };

  sync();
  // 捕捉 custom-theme 的创建 / 移除（重新导入相同主题时只改内容，由 styleObserver 处理）
  new MutationObserver(sync).observe(document.head, { childList: true });
}
watchCustomTheme();
