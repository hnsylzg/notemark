/*
 * themeManager.ts — 自定义主题管理器（Tauri v2）
 *
 * 职责：
 * - applyCustomTheme(css)：将用户 CSS 注入全局 <style id="custom-theme">，
 *   已存在则原地替换 textContent（主题切换/覆盖，单次重绘、无闪烁）
 * - resetToDefaultTheme()：移除注入标签 + 清除持久化的主题路径，恢复内置主题
 * - importCustomTheme()：弹 .css 文件对话框 → 读取内容 → 校验 → 注入 →
 *   复制到固定主题目录（appDataDir/themes）→ 持久化
 * - listInstalledThemes()：列出固定主题目录下全部已安装主题（Typora 风格菜单）
 * - applyInstalledTheme(filePath)：一键切换到某个已安装主题
 * - openThemesDir()：在系统文件管理器中打开主题目录
 * - loadCustomTheme()：应用启动时读取上次保存的主题路径并自动加载
 *
 * 设计要点：
 * - 主题集中存放在固定目录 appDataDir/themes，导入即复制（Typora 风格），
 *   菜单显示已安装主题列表，点击一键切换
 * - 不修改 src/editor/theme/index.css，用户主题完全独立，通过 CSS 层叠覆盖生效
 *   （自定义 <style> 追加在 <head> 末尾，优先级高于内置主题）
 * - 用户主题禁止 @import（安全与可控性），导入时校验并拒绝
 * - 持久化使用 @tauri-apps/plugin-store，仅保存“当前生效主题的文件路径”；
 *   动态 import，避免非 Tauri 环境（纯 vite dev 浏览器）加载失败
 * - 非 Tauri 环境下对话框 / 文件系统 / store 均不可用，导入仅临时生效
 */

import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

/** 是否处于 Tauri 环境（纯浏览器 vite dev 下不调用 Tauri API） */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 当前生效的自定义主题文件路径；null 表示内置主题 */
let activeThemePath: string | null = null;

/** 查询当前生效的自定义主题文件路径（供 UI 展示“是否已生效”） */
export function getActiveThemePath(): string | null {
  return activeThemePath;
}

/** 注入自定义主题样式的全局 <style> 标签 id */
const CUSTOM_THEME_STYLE_ID = "custom-theme";
/** 深色模式下注入“用户主题暗色块”的 <style> 标签 id */
const CUSTOM_THEME_DARK_STYLE_ID = "custom-theme-dark";
/** 最近一次应用的自定义主题中暗色块内容；无则空串 */
let customDarkCss = "";
/** store 文件名（@tauri-apps/plugin-store 的持久化文件） */
const STORE_FILE = "settings.json";
/** store 中保存主题路径的 key */
const THEME_PATH_KEY = "customThemePath";
/** 固定主题目录名（位于 appDataDir 之下） */
const THEMES_DIR_NAME = "themes";

/**
 * 读取主题文件内容，自适应 UTF-8 / GBK 编码。
 *
 * 背景：readTextFile 固定按 UTF-8 解码，而 Windows 记事本新建的
 * 文件默认是 ANSI/GBK 编码。含中文注释的 GBK CSS 被按 UTF-8 解码后
 * 会变成乱码，导致整条样式规则解析失败、主题“导入成功但毫无变化”。
 * 这里改为二进制读取：
 * 1. 先用 UTF-8 解码（并去掉 BOM）；
 * 2. 若出现替换字符 U+FFFD（说明内容不是合法 UTF-8），回退用 GBK 解码。
 * 注：WebView2（Windows）/ WebKit（Linux）的 TextDecoder 均支持 gbk。
 */
async function readThemeCss(path: string): Promise<string> {
  try {
    const bytes = await readFile(path);
    if (bytes.length === 0) return "";
    const utf8 = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
    if (!utf8.includes("\uFFFD")) return utf8;
    try {
      return new TextDecoder("gbk").decode(bytes);
    } catch {
      return utf8; // 运行环境不支持 gbk 时回退为 UTF-8 解码结果
    }
  } catch (err) {
    // readFile（二进制）不可用时（例如 dev 进程未重启、
    // fs:allow-read-file 权限尚未编译进应用），回退到 readTextFile。
    // 其对应权限 fs:allow-read-text-file 从一开始就存在，保证 UTF-8 文件仍可导入。
    console.warn("[MilkTypo] readFile unavailable, fallback to readTextFile:", err);
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return readTextFile(path);
  }
}

/**
 * 获取注入标签；不存在则创建并追加到 <head> 末尾。
 * 追加在末尾保证层叠优先级高于内置主题（index.css 经 Vite 注入的 <style>）。
 */
function getOrCreateStyleEl(id: string = CUSTOM_THEME_STYLE_ID): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

/**
 * 将 CSS 中的 :root 选择器改写为 ":root, .milkdown"。
 *
 * 背景：内置 tokens.css 把变量显式声明在 .milkdown 根节点上
 * （.milkdown { --mt-bg: var(--mt-color-bg); ... }）。按 CSS 变量继承规则，
 * .milkdown 元素有显式声明就不会继承 :root 上的同名变量，
 * 所以用户主题只写 :root { --mt-bg: ... } 时编辑区“看不到”这些变量。
 * 改写后变量同时作用于 .milkdown 根节点，实现“写 :root 即可全局换肤”。
 * @media 块内的 :root 也会被一并改写（改写后仍为合法 CSS）。
 */
function scopeRootVars(css: string): string {
  return css.replace(/(^|[,}])\s*:root\b/g, "$1:root, .milkdown");
}

/**
 * 校验 CSS 是否包含被禁止的 @import（安全与可控性）。
 * 先剥离注释再检测，避免注释文本（如“禁止 @import”）被误判；
 * 真正的 @import 语句必须位于行首（CSS 规范要求置于样式表开头），
 * 故用行首锚点匹配，精准区分语句与注释/字符串中的字面文本。
 */
function assertNoImport(css: string): void {
  const code = css
    .replace(/\/\*[\s\S]*?\*\//g, "") // 去掉块注释 /* ... */
    .replace(/\/\/.*$/gm, ""); // 去掉行注释 // ...
  if (/^\s*@import\b/m.test(code)) {
    throw new Error("自定义主题不允许包含 @import 语句，请将全部样式直接写入该文件。");
  }
}

/**
 * 从用户主题中提取所有 @media (prefers-color-scheme: dark) { ... } 块的内容。
 *
 * 背景：Chromium / WebView2 尚未实现“color-scheme 改变 prefers-color-scheme
 * 匹配结果”的规范行为，因此应用「深色模式」开关无法让用户主题里的该媒体查询
 * 生效。这里在应用层解析出暗色块内容，深色模式开启时由 applyCustomDarkCss
 * 单独注入 <style id="custom-theme-dark">（原生 @media 仍保留在 custom-theme
 * 中，用于跟随系统主题，两者叠加结果一致，无冲突）。
 */
function extractMediaDarkBlocks(css: string): string {
  const out: string[] = [];
  const re = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/gi;
  while (re.exec(css) !== null) {
    const bodyStart = re.lastIndex; // '{' 之后的第一个字符
    let depth = 1;
    let i = bodyStart;
    let inString = false;
    let quote = "";
    while (i < css.length && depth > 0) {
      const ch = css[i];
      if (inString) {
        if (ch === quote) inString = false;
        else if (ch === "\\") i++;
      } else if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      }
      i++;
    }
    if (depth !== 0) break; // 遇到未闭合的 @media 块，放弃后续解析
    out.push(css.slice(bodyStart, i - 1));
    re.lastIndex = i; // 跳过已消费的块，避免嵌套 @media 重复匹配
  }
  return out.join("\n");
}

/**
 * 根据当前深色模式状态，注入/移除“用户主题暗色块”。
 * 标签追加在 custom-theme 之后（head 末尾），保证深色模式下
 * 用户暗色分支按加载顺序覆盖用户亮色分支与内置暗色。
 */
function applyCustomDarkCss(): void {
  if (!customDarkCss || !isDarkMode()) {
    document.getElementById(CUSTOM_THEME_DARK_STYLE_ID)?.remove();
    return;
  }
  getOrCreateStyleEl(CUSTOM_THEME_DARK_STYLE_ID).textContent = customDarkCss;
}

/**
 * 注入/替换自定义主题。
 * @param css 用户主题 CSS 内容
 */
export function applyCustomTheme(css: string): void {
  assertNoImport(css);
  // 原地替换 textContent：浏览器单次样式重算，切换过程远小于 100ms，
  // 且不触碰编辑器 DOM，不影响内容滚动位置。
  const normalized = scopeRootVars(css);
  getOrCreateStyleEl().textContent = normalized;
  // 同步暗色块：若当前处于深色模式，立即用新主题的暗色分支重绘。
  customDarkCss = extractMediaDarkBlocks(css);
  applyCustomDarkCss();
  console.log(
    `[MilkTypo] custom theme applied (${normalized.length} chars; dark blocks: ${customDarkCss.length} chars; head has ${document.head.querySelectorAll("style").length} style tags)`
  );
}

/**
 * 恢复内置主题：移除自定义 <style> 标签，并清除持久化的主题路径。
 * 移除后编辑器回到内置 theme/index.css 的默认样式；
 * 只有同时清掉 store 里的 customThemePath，下次启动 loadCustomTheme()
 * 才不会又把上次导入的主题自动加载回来。
 */
export async function resetToDefaultTheme(): Promise<void> {
  document.getElementById(CUSTOM_THEME_STYLE_ID)?.remove();
  document.getElementById(CUSTOM_THEME_DARK_STYLE_ID)?.remove();
  customDarkCss = "";
  activeThemePath = null;
  if (!isTauri) return;
  try {
    const store = await getStore();
    await store.delete(THEME_PATH_KEY);
    await store.save();
  } catch (err) {
    console.warn("[MilkTypo] clear theme path failed:", err);
  }
}

/** 加载持久化 store（@tauri-apps/plugin-store） */
async function getStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(STORE_FILE);
}

/** 保存最近一次导入的主题路径（失败仅告警，不影响主流程） */
async function saveThemePath(path: string): Promise<void> {
  try {
    const store = await getStore();
    await store.set(THEME_PATH_KEY, path);
    await store.save();
  } catch (err) {
    console.warn("[MilkTypo] save theme path failed:", err);
  }
}

/** 读取上次保存的主题路径；无记录或读取失败返回 null */
async function loadThemePath(): Promise<string | null> {
  try {
    const store = await getStore();
    const value = await store.get<string>(THEME_PATH_KEY);
    return typeof value === "string" && value ? value : null;
  } catch (err) {
    console.warn("[MilkTypo] load theme path failed:", err);
    return null;
  }
}

/**
 * 应用启动时加载上次导入的自定义主题。
 * 无记录 / 文件已被移动删除 / 非 Tauri 环境时静默跳过，不阻塞启动。
 */
export async function loadCustomTheme(): Promise<void> {
  if (!isTauri) return;
  try {
    const path = await loadThemePath();
    if (!path) return;
    const css = await readThemeCss(path);
    applyCustomTheme(css);
    activeThemePath = path;
  } catch (err) {
    console.warn("[MilkTypo] load custom theme failed:", err);
  }
}

/** 浏览器导入的占位来源名（不参与持久化） */
const BROWSER_IMPORT_LABEL = "浏览器导入（临时）";

/**
 * 非 Tauri（浏览器预览）环境下的文件选择：<input type="file"> + FileReader。
 * 与 Tauri 对话框返回绝对路径不同，这里只能拿到文件内容，
 * 因此仅“应用样式”，不保存路径、不做启动自动加载。
 */
function pickCssFileInBrowser(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".css,text/css";
    input.style.display = "none";
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
        reader.addEventListener("error", () => resolve(null));
        reader.readAsText(file);
      },
      { once: true }
    );
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * 打开文件对话框导入自定义主题（仅 .css，支持一次多选）。
 * - Tauri 环境：原生文件对话框 + fs 读取 → 逐个校验 → 复制到固定主题目录
 *   appDataDir/themes（重名自动加 -1、-2… 序号，可共存多个）→ 最后一个作为当前主题
 * - 非 Tauri（浏览器预览）：<input type="file"> 读取，仅应用不持久化
 * @returns 成功导入的主题数量（0=用户取消或未选择文件）
 * @throws 读取失败 / 含 @import 被拒绝时向上抛出，由调用方提示用户
 */
export async function importCustomTheme(): Promise<number> {
  if (!isTauri) {
    const css = await pickCssFileInBrowser();
    if (css === null) return 0; // 用户取消
    applyCustomTheme(css); // 内部校验 @import，违规会抛错
    activeThemePath = BROWSER_IMPORT_LABEL;
    return 1;
  }

  const selected = await open({
    multiple: true,
    filters: [{ name: "CSS", extensions: ["css"] }],
  });
  // multiple:true 时 open() 返回 string[]；兼容 string | null
  const files = Array.isArray(selected)
    ? selected
    : typeof selected === "string"
      ? [selected]
      : [];
  if (files.length === 0) return 0; // 用户取消

  // 逐个校验 + 复制到固定主题目录；最后一个作为当前生效主题
  const dir = await ensureThemesDir();
  let lastTarget: string | null = null;
  for (const file of files) {
    const css = await readThemeCss(file);
    applyCustomTheme(css); // 内部校验 @import，违规会抛错

    // 复制到固定主题目录；源文件已在主题目录内（重复导入）时跳过复制
    let targetPath = file;
    if (dir && !isPathInside(dir, file)) {
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const { join } = await import("@tauri-apps/api/path");
      targetPath = await join(dir, await uniqueThemeFileName(dir, file));
      await writeFile(targetPath, new TextEncoder().encode(css));
    }
    lastTarget = targetPath;
  }
  if (lastTarget) {
    activeThemePath = lastTarget;
    await saveThemePath(lastTarget);
  }
  return files.length;
}

/* ============ 固定主题目录（Typora 风格：集中存放 + 菜单切换） ============ */

/**
 * 获取/创建固定主题目录 appDataDir/themes。
 * @returns 目录绝对路径；非 Tauri 环境或创建失败返回 null
 */
async function ensureThemesDir(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const dir = await join(await appDataDir(), THEMES_DIR_NAME);
    await mkdir(dir, { recursive: true }); // 已存在时静默成功
    return dir;
  } catch (err) {
    console.warn("[MilkTypo] ensure themes dir failed:", err);
    return null;
  }
}

/** 判断 file 是否位于 dir 目录之内（用于跳过“复制到自己”的重复导入） */
function isPathInside(dir: string, file: string): boolean {
  const d = dir.replace(/[\\/]+$/, "").toLowerCase();
  return (
    file.toLowerCase().startsWith(`${d}\\`) ||
    file.toLowerCase().startsWith(`${d}/`)
  );
}

/**
 * 为导入的主题生成目录中不冲突的文件名：
 * 清洗源文件名（去 Windows 非法字符）后，若与已有主题重名，
 * 自动追加 -1、-2… 序号（同名主题可以共存多个，不再互相覆盖）。
 */
async function uniqueThemeFileName(
  dir: string,
  srcPath: string
): Promise<string> {
  const base = srcPath.split(/[\\/]/).pop() || "theme.css";
  const stem =
    base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\.css$/i, "") ||
    "theme";
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const names = new Set((await readDir(dir)).map((e) => e.name.toLowerCase()));
    if (!names.has(`${stem}.css`)) return `${stem}.css`;
    for (let i = 1; i < 1000; i++) {
      const candidate = `${stem}-${i}.css`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
  } catch (err) {
    console.warn("[MilkTypo] check theme name conflict failed:", err);
  }
  return `${stem}.css`;
}

/**
 * 列出固定主题目录下所有已安装的 .css 主题。
 * @returns 按名称排序的 [{ name（不含 .css）, filePath }]；非 Tauri / 失败返回 []
 */
export async function listInstalledThemes(): Promise<
  { name: string; filePath: string }[]
> {
  const dir = await ensureThemesDir();
  if (!dir) return [];
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const entries = await readDir(dir);
    const themes = await Promise.all(
      entries
        .filter((e) => !e.isDirectory && /\.css$/i.test(e.name))
        .map(async (e) => ({
          name: e.name.replace(/\.css$/i, ""),
          filePath: await join(dir, e.name),
        }))
    );
    return themes.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  } catch (err) {
    console.warn("[MilkTypo] list themes failed:", err);
    return [];
  }
}

/** 一键切换到固定目录中某个已安装主题：读取 → 校验 → 注入 → 持久化为当前主题 */
export async function applyInstalledTheme(filePath: string): Promise<void> {
  const css = await readThemeCss(filePath);
  applyCustomTheme(css); // 内部校验 @import，违规会抛错
  activeThemePath = filePath;
  await saveThemePath(filePath);
}

/** 在系统文件管理器中打开主题目录（返回目录路径；失败返回 null） */
export async function openThemesDir(): Promise<string | null> {
  const dir = await ensureThemesDir();
  if (!dir) return null;
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(dir);
    return dir;
  } catch (err) {
    console.warn("[MilkTypo] open themes dir failed:", err);
    return null;
  }
}

/* ============ 深色模式（应用级） ============ */

/** store 中保存深色模式偏好的 key */
const DARK_MODE_KEY = "darkMode";

/**
 * 应用/取消深色模式：设置或移除 <html data-theme="dark">。
 * 由 dark.css 消费；其中 color-scheme: dark 的声明会让用户主题里的
 * @media (prefers-color-scheme: dark) { ... } 分支跟随应用开关生效。
 */
export function applyDarkMode(dark: boolean): void {
  const el = document.documentElement;
  if (dark) el.dataset.theme = "dark";
  else delete el.dataset.theme;
  // 同步注入/移除用户主题的暗色块（若存在）
  applyCustomDarkCss();
}

/** 当前是否为深色模式 */
export function isDarkMode(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

/** 读取持久化的深色模式偏好；无记录 / 非 Tauri 环境返回 null */
export async function loadDarkModePreference(): Promise<boolean | null> {
  if (!isTauri) return null;
  try {
    const store = await getStore();
    const value = await store.get<boolean>(DARK_MODE_KEY);
    return typeof value === "boolean" ? value : null;
  } catch (err) {
    console.warn("[MilkTypo] load dark mode preference failed:", err);
    return null;
  }
}

/** 持久化深色模式偏好（失败仅告警，不影响主流程） */
export async function saveDarkModePreference(dark: boolean): Promise<void> {
  if (!isTauri) return;
  try {
    const store = await getStore();
    await store.set(DARK_MODE_KEY, dark);
    await store.save();
  } catch (err) {
    console.warn("[MilkTypo] save dark mode preference failed:", err);
  }
}
