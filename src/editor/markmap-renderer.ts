import type {
  RenderOptions,
  SVGStringOptions,
} from "@markmap/render";

const MARKMAP_SVG_CACHE_LIMIT = 100;
const markmapSvgCache = new Map<string, Promise<string>>();

type MarkmapRenderModule = typeof import("@markmap/render");
type Measurer = RenderOptions["measurer"];
type Theme = NonNullable<RenderOptions["theme"]>;

interface MarkmapCssConfig {
  input: Record<string, unknown>;
  colorScheme: NonNullable<SVGStringOptions["colorScheme"]>;
}

export interface MarkmapRenderOptions {
  /** Fill the SVG with Markmap's theme background. Defaults to transparent. */
  background?: boolean;
}

const isDarkTheme = () =>
  document.documentElement.dataset.theme === "dark";

function readMarkmapCssConfig(): MarkmapCssConfig {
  const el =
    document.querySelector<HTMLElement>(".milkdown .editor") ??
    document.querySelector<HTMLElement>(".milkdown");
  if (!el) {
    return {
      input: {},
      colorScheme: isDarkTheme() ? "dark" : "light",
    };
  }

  const style = getComputedStyle(el);
  const pick = (name: string) => style.getPropertyValue(name).trim();
  const input: Record<string, unknown> = {};
  const theme = pick("--markmap-theme");
  if (theme) input.theme = theme;
  const layout = pick("--markmap-layout");
  if (layout) input.layout = layout;
  const wrapWidth = Number.parseFloat(pick("--markmap-wrap-width"));
  if (Number.isFinite(wrapWidth) && wrapWidth >= 0) {
    input.wrapWidth = wrapWidth;
  }

  const requestedScheme = pick("--markmap-color-scheme").toLowerCase();
  const colorScheme =
    requestedScheme === "light" ||
    requestedScheme === "dark" ||
    requestedScheme === "auto"
      ? requestedScheme
      : isDarkTheme()
        ? "dark"
        : "light";

  return { input, colorScheme };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markmapInput(
  frontmatter: Record<string, unknown>,
  cssInput: Record<string, unknown>
): Record<string, unknown> {
  const documentOptions = isRecord(frontmatter.markmap)
    ? frontmatter.markmap
    : {};
  // Theme-level defaults are overridden by options written inside the document.
  return { ...cssInput, ...documentOptions };
}

function createMeasurer(render: MarkmapRenderModule): Measurer {
  if (
    typeof document !== "undefined" &&
    !navigator.userAgent.toLowerCase().includes("jsdom")
  ) {
    const context = document.createElement("canvas").getContext("2d");
    if (context) return render.createCanvasMeasurer(context);
  }
  return render.approximateMeasurer;
}

function cacheMarkmapSvg(key: string, promise: Promise<string>): Promise<string> {
  if (markmapSvgCache.size >= MARKMAP_SVG_CACHE_LIMIT) {
    const oldest = markmapSvgCache.keys().next().value;
    if (oldest) markmapSvgCache.delete(oldest);
  }
  markmapSvgCache.set(key, promise);
  void promise.catch(() => {
    if (markmapSvgCache.get(key) === promise) markmapSvgCache.delete(key);
  });
  return promise;
}

async function renderMarkmap(
  value: string,
  background: boolean
): Promise<string> {
  const [parseModule, render] = await Promise.all([
    import("@markmap/parse"),
    import("@markmap/render"),
  ]);
  const parsed = parseModule.parse(value);
  const config = readMarkmapCssConfig();
  const base: Partial<RenderOptions> & {
    measurer: Measurer;
    theme: Theme;
  } = {
    measurer: createMeasurer(render),
    theme: render.classicTheme,
    layout: render.treeLayout,
    plugins: render.defaultContentPlugins,
  };
  const resolved = render.resolveRenderOptions(
    base,
    markmapInput(parsed.frontmatter, config.input)
  );
  if (resolved.warnings.length > 0) {
    console.warn("[NoteMark] Markmap options:", resolved.warnings.join("; "));
  }

  const result = await render.renderTreeAsync(
    parsed.root,
    resolved.options
  );
  return render.toSVGString(result, {
    background,
    colorScheme: config.colorScheme,
  });
}

/** Render Markmap Markdown to theme-aware, self-contained SVG. */
export function renderMarkmapSvg(
  value: string,
  options: MarkmapRenderOptions = {}
): Promise<string> {
  const config = readMarkmapCssConfig();
  const background = options.background ?? false;
  const key = `${JSON.stringify(config)}\u0000${background}\u0000${value}`;
  const cached = markmapSvgCache.get(key);
  if (cached) return cached;
  return cacheMarkmapSvg(key, renderMarkmap(value, background));
}

const renderers = new Set<() => void>();

export function subscribeMarkmapTheme(renderer: () => void): () => void {
  renderers.add(renderer);
  return () => renderers.delete(renderer);
}

function notifyThemeChange(): void {
  for (const render of renderers) render();
}

let themeObserver: MutationObserver | null = null;
function watchThemeSwitch(): void {
  if (themeObserver) return;
  themeObserver = new MutationObserver(notifyThemeChange);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

function watchCustomTheme(): void {
  const styleObserver = new MutationObserver(notifyThemeChange);
  const observed = new WeakSet<Element>();
  let lastHadStyle: boolean | null = null;

  const sync = () => {
    const style = document.getElementById("custom-theme");
    const has = !!style;
    if (style && !observed.has(style)) {
      styleObserver.observe(style, { childList: true, subtree: true });
      observed.add(style);
      notifyThemeChange();
    }
    if (has !== lastHadStyle) {
      lastHadStyle = has;
      if (!has) notifyThemeChange();
    }
  };

  sync();
  new MutationObserver(sync).observe(document.head, { childList: true });
}

watchThemeSwitch();
watchCustomTheme();
