/*
 * mathjax.ts — 应用内唯一的公式引擎（MathJax 4.1.3）。
 *
 * 编辑器显示使用 SVG 输出；复制/Word 导出复用同一 MathJax TeX 输入树生成
 * MathML。组件从本地 `/mathjax/tex-svg.js` 按需加载，不依赖 CDN。
 */

interface MathJaxApi {
  version: string;
  tex2svg(tex: string, options?: { display?: boolean }): HTMLElement;
  tex2mml(tex: string, options?: { display?: boolean }): string;
  loader?: {
    paths?: Record<string, string>;
  };
  tex2svgPromise?(
    tex: string,
    options?: { display?: boolean }
  ): Promise<HTMLElement>;
  tex2mmlPromise?(
    tex: string,
    options?: { display?: boolean }
  ): Promise<string>;
}

declare global {
  interface Window {
    MathJax?: MathJaxApi;
  }
}

const MATHJAX_SCRIPT_ID = "notemark-mathjax";
const MATHJAX_SCRIPT_PATH = "mathjax/tex-svg.js";
const MATHJAX_FONT_PATH = "mathjax/fonts/newcm";
const MATHJAX_CACHE_LIMIT = 100;
const MATHJAX_READY_RETRIES = 100;
const MATHJAX_READY_INTERVAL_MS = 20;
const MATHJAX_FONT_RETRY_LIMIT = 500;
const MATHJAX_FONT_RETRY_INTERVAL_MS = 20;

const svgCache = new Map<string, string>();
let loadPromise: Promise<MathJaxApi> | null = null;

function cacheSvg(key: string, html: string): void {
  if (svgCache.size >= MATHJAX_CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value;
    if (oldest) svgCache.delete(oldest);
  }
  svgCache.set(key, html);
}

function cloneSvgContainer(html: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = html;
  const container = template.content.firstElementChild;
  if (!(container instanceof HTMLElement)) {
    throw new Error("MathJax 未返回有效的 SVG 容器");
  }
  return container;
}

function configureMathJaxFontPath(api: MathJaxApi): void {
  if (!api.loader?.paths) return;
  api.loader.paths["mathjax-newcm"] = new URL(
    MATHJAX_FONT_PATH,
    document.baseURI
  ).href.replace(/\/$/, "");
}

function isMathJaxRetryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /retry|asynchronous action is required/i.test(error.message)
  );
}

async function renderSvgWithFontRetry(
  api: MathJaxApi,
  tex: string,
  displayMode: boolean
): Promise<HTMLElement> {
  let fontLoadStarted = false;
  for (let attempt = 0; attempt < MATHJAX_FONT_RETRY_LIMIT; attempt += 1) {
    try {
      return api.tex2svg(tex, { display: displayMode });
    } catch (error) {
      if (!isMathJaxRetryError(error) || !api.tex2svgPromise) throw error;
      if (!fontLoadStarted) {
        fontLoadStarted = true;
        // MathJax 4 用 retry 表示动态字形尚未加载。Promise 调用负责触发字体分块下载；
        // 当前版本在运行时切换本地字体根后 Promise 可能保持 pending，因此字体就绪后
        // 以同步渲染重试，而不是把内部加载时序暴露给调用方。
        void api
          .tex2svgPromise(tex, { display: displayMode })
          .catch(() => undefined);
      }
      await new Promise((resolve) =>
        window.setTimeout(resolve, MATHJAX_FONT_RETRY_INTERVAL_MS)
      );
    }
  }
  throw new Error("MathJax 动态字体加载超时");
}

async function waitForMathJaxApi(): Promise<MathJaxApi> {
  for (let attempt = 0; attempt < MATHJAX_READY_RETRIES; attempt += 1) {
    const api = window.MathJax;
    if (api && typeof api.tex2svg === "function" && typeof api.tex2mml === "function") {
      configureMathJaxFontPath(api);
      return api;
    }
    await new Promise((resolve) =>
      window.setTimeout(resolve, MATHJAX_READY_INTERVAL_MS)
    );
  }
  throw new Error("MathJax 初始化超时");
}

export function loadMathJax(): Promise<MathJaxApi> {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<MathJaxApi>((resolve, reject) => {
    const existing = window.MathJax;
    if (existing && typeof existing.tex2svg === "function") {
      configureMathJaxFontPath(existing);
      resolve(existing);
      return;
    }

    // 配置必须在组件脚本执行前写入 window.MathJax。
    window.MathJax = {
      startup: { typeset: false },
      loader: {
        paths: {
          "mathjax-newcm": new URL(
            MATHJAX_FONT_PATH,
            document.baseURI
          ).href.replace(/\/$/, ""),
        },
      },
      options: {
        enableMenu: false,
        enableAssistiveMml: false,
        enableExplorer: false,
        enableEnrichment: false,
        menuOptions: {
          settings: {
            enrich: false,
            speech: false,
            braille: false,
            assistiveMml: false,
          },
        },
      },
      svg: { fontCache: "local" },
    } as unknown as MathJaxApi;

    const existingScript = document.getElementById(MATHJAX_SCRIPT_ID);
    const script =
      existingScript instanceof HTMLScriptElement
        ? existingScript
        : document.createElement("script");
    script.id = MATHJAX_SCRIPT_ID;
    script.addEventListener("load", () => {
      void waitForMathJaxApi().then(resolve, reject);
    });
    script.addEventListener("error", () => {
      reject(new Error("MathJax 组件加载失败"));
    });
    if (!script.isConnected) {
      script.src = new URL(MATHJAX_SCRIPT_PATH, document.baseURI).href;
      document.head.appendChild(script);
    } else {
      void waitForMathJaxApi().then(resolve, reject);
    }
  });
  return loadPromise;
}

/**
 * MathJax 4 的部分同步转换会因动态扩展返回 retry 错误；此时改用 Promise API。
 * 普通公式走同步路径，避免不必要的等待。
 */
async function withAsyncFallback<T>(
  sync: () => T,
  asyncFallback: (() => Promise<T>) | undefined
): Promise<T> {
  try {
    return sync();
  } catch (error) {
    if (!asyncFallback) throw error;
    return asyncFallback();
  }
}

export async function renderMathJaxSvg(
  tex: string,
  displayMode: boolean
): Promise<HTMLElement> {
  const key = `${displayMode ? "block" : "inline"}:${tex}`;
  const cached = svgCache.get(key);
  if (cached) return cloneSvgContainer(cached);

  const api = await loadMathJax();
  const container = await renderSvgWithFontRetry(api, tex, displayMode);
  // 显示层不参与键盘/鼠标交互；点击必须落到公式 NodeView 上进入源码编辑。
  container.removeAttribute("tabindex");
  container.setAttribute("tabindex", "-1");
  cacheSvg(key, container.outerHTML);
  return container;
}

/** 已加载 MathJax 后的同步 SVG 输出，供只接受同步返回值的第三方渲染器使用。 */
export function mathJaxSvgStringSync(
  tex: string,
  displayMode: boolean
): string {
  const api = window.MathJax;
  if (!api || typeof api.tex2svg !== "function") {
    throw new Error("MathJax 尚未加载");
  }
  return api.tex2svg(tex, { display: displayMode }).outerHTML;
}

/** 已加载 MathJax 后的同步 MathML 输出。 */
export function mathJaxMathMlSync(
  tex: string,
  displayMode: boolean
): string {
  const api = window.MathJax;
  if (!api || typeof api.tex2mml !== "function") {
    throw new Error("MathJax 尚未加载");
  }
  return api.tex2mml(tex, { display: displayMode });
}

/** 使用与显示完全相同的 MathJax TeX 输入树生成 MathML。 */
export async function texToMathMl(
  tex: string,
  displayMode: boolean
): Promise<string> {
  const api = await loadMathJax();
  return withAsyncFallback(
    () => api.tex2mml(tex, { display: displayMode }),
    api.tex2mmlPromise
      ? () => api.tex2mmlPromise!(tex, { display: displayMode })
      : undefined
  );
}
