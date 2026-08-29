<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from "vue";
import "@/editor/theme/index.css";
import {
  createEditor,
  getMarkdown,
  setMarkdown,
  getCaretRatio,
  setCaretByRatio,
} from "@/editor/index";
import { openFile, saveFile, newFile } from "@/editor/fileOps";
import { setImageBaseDir } from "@/editor/image-view";
import {
  applyDarkMode,
  applyInstalledTheme,
  getActiveThemePath,
  importCustomTheme,
  isDarkMode,
  listInstalledThemes,
  loadCustomTheme,
  loadDarkModePreference,
  openThemesDir,
  resetToDefaultTheme,
  saveDarkModePreference,
} from "@/editor/themeManager";

// 是否处于 Tauri 环境（纯浏览器 vite dev 下不调用 Tauri API）
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 新建文档的默认内容（空文档） */
const INITIAL_CONTENT = "";

// 编辑器挂载容器
const editorHost = ref<HTMLElement | null>(null);
// 持有 editor 实例，便于卸载时销毁与读写
let editorInstance: ReturnType<typeof createEditor> | null = null;

// 文件状态
const currentPath = ref<string | null>(null);
const displayName = ref<string>("untitled");
/**
 * 最后一次保存/加载时的内容快照，用于判断是否有未保存修改。
 * 初始值设为 INITIAL_CONTENT：启动时的示例内容不算“未保存修改”，
 * 避免用户未做任何编辑时关闭窗口也被拦截。
 */
const savedContent = ref<string | null>(INITIAL_CONTENT);
/** 是否有未保存的修改（工具栏显示 ● 标记） */
const isDirty = ref(false);

// 源码模式：查看/编辑 Markdown 原文（WYSIWYG ⇄ 源码）
/** 是否处于源码模式 */
const sourceMode = ref(false);
/** 源码模式下 textarea 的当前内容（进入源码模式时的快照 + 用户后续编辑） */
const sourceDraft = ref("");
/** 源码 textarea 元素（进入源码模式时聚焦） */
const sourceTextarea = ref<HTMLTextAreaElement | null>(null);

// 主题菜单状态
/** 主题下拉菜单是否展开 */
const themeMenuOpen = ref(false);
/** 主题菜单容器（用于点击外部时收起菜单） */
const themeMenuWrap = ref<HTMLElement | null>(null);
/** 菜单状态栏文案：显示当前主题，以及最近一次导入的结果（成功/取消/失败原因） */
const themeStatus = ref<string>(formatThemeStatus());
/** 固定主题目录下已安装的主题列表（打开菜单时刷新） */
const installedThemes = ref<{ name: string; filePath: string }[]>([]);

function formatThemeStatus(): string {
  const p = getActiveThemePath();
  if (!p) return "当前：内置主题";
  if (p === "浏览器导入（临时）") return p;
  const name = p.split(/[\\/]/).pop()?.replace(/\.css$/i, "") || p;
  return `当前：${name}`;
}

/** 导入/重置/启动加载后刷新状态栏 */
function refreshThemeStatus() {
  themeStatus.value = formatThemeStatus();
}

/** 刷新固定主题目录下的已安装主题列表 */
async function refreshThemeList() {
  installedThemes.value = await listInstalledThemes();
}

/** 是否为深色模式（同步 <html data-theme> 当前值） */
const isDark = ref<boolean>(isDarkMode());

/** 切换深色模式：应用 + 持久化偏好 */
async function toggleDarkMode() {
  isDark.value = !isDark.value;
  applyDarkMode(isDark.value);
  await saveDarkModePreference(isDark.value);
}

type WebviewWindow = Awaited<
  ReturnType<typeof import("@tauri-apps/api/webviewWindow").getCurrentWebviewWindow>
>;
let webview: WebviewWindow | null = null;

/** 同步窗口标题与工具栏文件名 */
function updateTitle(name: string) {
  displayName.value = name;
  if (isTauri && webview) {
    webview.setTitle(`MilkTypo - ${name}`);
  }
}

/** 编辑器内容变化回调（listenerCtx.markdownUpdated） */
function onEditorChange(markdown: string) {
  isDirty.value = markdown !== savedContent.value;
}

// ==================== 源码模式 ====================

/** 进入源码模式：以当前编辑器序列化结果填充草稿 */
function enterSourceMode() {
  if (sourceMode.value || !editorInstance) return;
  // 记录 WYSIWYG 光标比例，切到源码后还原到对应位置
  const ratio = getCaretRatio(editorInstance);
  sourceDraft.value = getMarkdown(editorInstance);
  sourceMode.value = true;
  nextTick(() => {
    const el = sourceTextarea.value;
    if (!el) return;
    if (ratio != null) {
      const pos = Math.round(ratio * el.value.length);
      el.setSelectionRange(pos, pos);
    }
    el.focus();
  });
}

/** 退出源码模式：把草稿应用回编辑器（重新解析渲染）。setMarkdown 会触发
 *  markdownUpdated → onEditorChange，脏标记随之按新内容重新计算。 */
function exitSourceMode() {
  if (!sourceMode.value || !editorInstance) return;
  const editor = editorInstance;
  const el = sourceTextarea.value;
  // 记录 textarea 光标比例，切回 WYSIWYG 后还原（保持阅读位置）
  const ratio =
    el && el.value.length > 0
      ? Math.min(1, Math.max(0, (el.selectionStart ?? el.value.length) / el.value.length))
      : null;
  setMarkdown(editor, sourceDraft.value);
  sourceMode.value = false;
  nextTick(() => {
    if (ratio != null) {
      setCaretByRatio(editor, ratio);
    } else {
      document.querySelector<HTMLElement>(".milkdown .editor")?.focus();
    }
  });
}

/** 切换源码模式 */
function toggleSourceMode() {
  if (sourceMode.value) exitSourceMode();
  else enterSourceMode();
}

/** 源码 textarea 输入：更新草稿与脏标记 */
function onSourceInput(e: Event) {
  sourceDraft.value = (e.target as HTMLTextAreaElement).value;
  isDirty.value = sourceDraft.value !== savedContent.value;
}

/** 获取当前内容：源码模式下返回草稿，否则返回编辑器序列化结果 */
function getCurrentContent(): string {
  if (!editorInstance) return "";
  return sourceMode.value ? sourceDraft.value : getMarkdown(editorInstance);
}

/** 打开/新建后若处于源码模式，把编辑器新内容同步进草稿 */
function syncSourceDraft() {
  if (sourceMode.value && editorInstance) {
    sourceDraft.value = getMarkdown(editorInstance);
  }
}

type SaveAction = "save" | "discard" | "cancel";

/**
 * “未保存修改”确认框状态。
 * 为 null 时隐藏；显示时持有提示消息与 resolve 回调。
 * 采用前端自绘对话框而非 Tauri ask()，避免依赖 dialog 插件权限，
 * 保证浏览器与桌面端行为一致。
 */
const confirmState = ref<{
  message: string;
  resolve: (action: SaveAction) => void;
} | null>(null);

/** 弹出确认框，等待用户在“保存 / 不保存 / 取消”中作出选择 */
function askSaveConfirm(message: string): Promise<SaveAction> {
  return new Promise((resolve) => {
    confirmState.value = { message, resolve };
  });
}

/** 用户点击确认框按钮后触发，把选择交还给等待中的流程 */
function resolveConfirm(action: SaveAction) {
  confirmState.value?.resolve(action);
  confirmState.value = null;
}

async function handleOpen() {
  if (!isTauri || !editorInstance) return;
  // 有未保存修改时先询问是否保存，避免内容丢失
  if (isDirty.value) {
    const action = await askSaveConfirm("当前文档有未保存的修改，是否先保存？");
    if (action === "cancel") return; // 取消，中止打开
    if (action === "save") {
      const saved = await handleSave();
      if (!saved) return; // 保存被取消/失败，中止打开
    }
  }
  try {
    const file = await openFile();
    if (!file) return; // 用户取消
    currentPath.value = file.path;
    // 必须先设置图片基准目录，再渲染文档，
    // 否则首次渲染时相对路径图片会按 WebView 页面 URL 解析导致裂图。
    setImageBaseDir(file.path);
    await setMarkdown(editorInstance, file.content);
    updateTitle(file.name);
    // 快照必须用“编辑器序列化结果”而非文件原文：
    // setMarkdown 会触发 markdownUpdated，其回调拿到的文本是序列化结果，
    // 若文件带 CRLF 换行等差异，与原文比较会产生误报。
    // 等渲染完成后再以序列化结果作为脏检查基准。
    await nextTick();
    if (editorInstance) {
      savedContent.value = getMarkdown(editorInstance);
      isDirty.value = false;
      syncSourceDraft();
    }
  } catch (err) {
    console.error("[MilkTypo] open failed:", err);
    alert(`打开失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 保存文件。返回是否真正完成保存（用户取消或失败返回 false）。 */
async function handleSave(): Promise<boolean> {
  if (!isTauri || !editorInstance) return false;
  try {
    const content = getCurrentContent();
    const result = await saveFile(content, currentPath.value);
    if (!result) return false; // 用户取消
    currentPath.value = result.path;
    setImageBaseDir(result.path);
    updateTitle(result.name);
    savedContent.value = content;
    isDirty.value = false;
    return true;
  } catch (err) {
    console.error("[MilkTypo] save failed:", err);
    alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function handleNew() {
  if (!editorInstance) return;
  // 有未保存修改时先询问是否保存，避免内容丢失
  if (isDirty.value) {
    const action = await askSaveConfirm("当前文档有未保存的修改，是否先保存？");
    if (action === "cancel") return; // 取消，中止新建
    if (action === "save") {
      const saved = await handleSave();
      if (!saved) return; // 保存被取消/失败，中止新建
    }
  }
  setMarkdown(editorInstance, "");
  const fresh = newFile();
  currentPath.value = fresh.path;
  setImageBaseDir(fresh.path);
  updateTitle(fresh.name);
  // 与打开文件一致：等渲染完成后用序列化结果作为脏检查基准
  await nextTick();
  if (editorInstance) {
    savedContent.value = getMarkdown(editorInstance);
    isDirty.value = false;
    syncSourceDraft();
  }
}

// ==================== 主题菜单 ====================

/** 展开 / 收起主题下拉菜单（展开时刷新已安装主题列表） */
function toggleThemeMenu() {
  themeMenuOpen.value = !themeMenuOpen.value;
  if (themeMenuOpen.value) {
    refreshThemeList().catch((e) =>
      console.warn("[MilkTypo] refresh theme list failed:", e)
    );
  }
}

/** 切换回内置主题（默认）：移除自定义主题 <style> 标签，并清除持久化路径 */
async function useDefaultTheme() {
  themeMenuOpen.value = false;
  await resetToDefaultTheme();
  refreshThemeStatus();
}

/** 切换到固定主题目录中的某个已安装主题 */
async function switchTheme(theme: { name: string; filePath: string }) {
  themeMenuOpen.value = false;
  try {
    await applyInstalledTheme(theme.filePath);
    refreshThemeStatus();
  } catch (err) {
    console.error("[MilkTypo] apply theme failed:", err);
    themeStatus.value = `切换失败：${err instanceof Error ? err.message : String(err)}`;
    alert(`切换主题失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 在系统文件管理器中打开主题文件夹（Typora 风格，可手动放 CSS 进去） */
async function openThemeFolder() {
  themeMenuOpen.value = false;
  const dir = await openThemesDir();
  if (!dir) alert("无法打开主题文件夹");
}

/** 该已安装主题是否为当前生效主题 */
function isThemeActive(theme: { name: string; filePath: string }): boolean {
  const p = getActiveThemePath();
  return p !== null && p.toLowerCase() === theme.filePath.toLowerCase();
}

/** 当前是否处于内置主题 */
function isDefaultThemeActive(): boolean {
  return getActiveThemePath() === null;
}

/** 导入自定义主题：文件对话框（支持多选）→ 校验 → 复制到固定目录 → 应用 */
async function importTheme() {
  themeMenuOpen.value = false;
  try {
    const count = await importCustomTheme();
    if (count > 0) {
      refreshThemeStatus();
      await refreshThemeList().catch((e) =>
        console.warn("[MilkTypo] refresh theme list failed:", e)
      );
      alert(
        count === 1
          ? "自定义主题已应用。"
          : `已导入 ${count} 个主题，最后一个已应用，可在主题菜单中切换。`
      );
    } else {
      themeStatus.value = "已取消：未选择主题文件";
    }
  } catch (err) {
    console.error("[MilkTypo] import theme failed:", err);
    themeStatus.value = `导入失败：${err instanceof Error ? err.message : String(err)}`;
    alert(`导入主题失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 点击主题菜单外部区域时收起菜单 */
function onDocumentClick(e: MouseEvent) {
  if (themeMenuOpen.value && !themeMenuWrap.value?.contains(e.target as Node)) {
    themeMenuOpen.value = false;
  }
  // 编辑器内点击超链接：交给系统浏览器打开
  const target = e.target as Element | null;
  const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  // 锚点链接（#xxx）在编辑器内没有跳转目标，忽略
  if (!href || href.startsWith("#")) return;
  e.preventDefault();
  openExternalLink(href).catch((err) =>
    console.error("[MilkTypo] open link failed:", err)
  );
}

/** 用系统默认程序打开链接；支持 http(s)/mailto 与本地相对路径（./xxx.md 等） */
async function openExternalLink(href: string): Promise<void> {
  if (!href || href.startsWith("#")) return;
  // 带协议的链接：仅支持 http(s)/mailto，其余协议（tel:/javascript:/data: 等）忽略
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (!/^(https?:|mailto:)/i.test(href)) return;
    try {
      if (isTauri) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(href);
      } else {
        windowOpenNewTab(href);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[MilkTypo] open link failed:", err);
      alert(`无法打开链接：${msg}`);
    }
    return;
  }
  // 本地相对路径（./xxx.md、../xxx.md、xxx.md）：基于当前文档所在目录解析后打开
  if (isTauri) {
    const baseDir = currentPath.value
      ? currentPath.value.replace(/[\\/][^\\/]*$/, "")
      : null;
    if (!baseDir) {
      console.warn("[MilkTypo] 当前文档未保存，无法解析相对链接:", href);
      return;
    }
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(resolveLocalPath(baseDir, href));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[MilkTypo] open local link failed:", err);
      alert(`无法打开 ${href}：${msg}`);
    }
  } else {
    // 浏览器环境（vite dev）：交给浏览器按相对地址打开
    windowOpenNewTab(href);
  }
}

/** 在新标签页打开 URL；弹窗被拦截时兜底用临时 <a> 模拟点击（同一用户手势内有效） */
function windowOpenNewTab(url: string) {
  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener,noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

/** 将相对路径解析为基于 baseDir 的绝对路径（处理 .、.. 与重复分隔符） */
function resolveLocalPath(baseDir: string, rel: string): string {
  const stack = baseDir.split(/[\\/]+/).filter(Boolean);
  const hasDrive = /^[a-zA-Z]:/.test(baseDir);
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      // 不允许跳出盘符根目录
      if (stack.length > (hasDrive ? 1 : 0)) stack.pop();
    } else {
      stack.push(seg);
    }
  }
  const drive = hasDrive ? `${stack.shift()}\\` : "";
  return `${drive}${stack.join("\\")}`;
}

// 全局快捷键：Ctrl/Cmd + O / S / N / Shift+T（主题菜单）
function onKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (mod && e.shiftKey && key === "t") {
    // 打开主题菜单（浏览器默认的“恢复已关闭标签页”会被覆盖）
    e.preventDefault();
    toggleThemeMenu();
  } else if (key === "o") {
    e.preventDefault();
    handleOpen();
  } else if (key === "s") {
    e.preventDefault();
    handleSave();
  } else if (key === "n") {
    e.preventDefault();
    handleNew();
  } else if (key === "/") {
    // 源码模式快捷键（Typora 风格 Ctrl+/）。
    // 焦点在 milkdown 编辑器内时交给 CodeMirror（代码块注释），不拦截。
    const inMilkdown = (e.target as HTMLElement).closest?.(".milkdown");
    if (!inMilkdown) {
      e.preventDefault();
      toggleSourceMode();
    }
  }
}

/** 非 Tauri（浏览器）环境的关闭前确认：有未保存修改时触发原生提示 */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (isDirty.value) {
    e.preventDefault();
    e.returnValue = "";
  }
}

onMounted(() => {
  try {
    if (!editorHost.value) return;

    editorInstance = createEditor(editorHost.value, INITIAL_CONTENT, onEditorChange);
    // 真正创建编辑器（视图在这里挂载）
    editorInstance.create().then(() => {
      // 初始内容不算“未保存修改”：create 完成后建立内容快照
      if (editorInstance) {
        savedContent.value = getMarkdown(editorInstance);
        isDirty.value = false;
      }
    });
  } catch (err) {
    // 临时诊断：把运行时错误显示在页面上，便于排查白屏
    const host = editorHost.value;
    if (host) {
      host.innerHTML = `<pre style="color:red;white-space:pre-wrap;padding:16px">[MilkTypo init error]\n${
        err instanceof Error ? err.stack || err.message : String(err)
      }</pre>`;
    }
    console.error("[MilkTypo] editor init failed:", err);
  }

  // 在 Tauri 环境下获取 webview 句柄：设置窗口标题 + 拦截关闭
  if (isTauri) {
    import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) => {
        webview = getCurrentWebviewWindow();
        webview.setTitle(`MilkTypo - ${displayName.value}`);
        // 关闭窗口前：有未保存修改时先询问是否保存，而不是直接关掉。
        // 注意：未调用 preventDefault 时，@tauri-apps/api 会自动调用 destroy() 关闭窗口；
        // 调用 preventDefault 后则必须由我们显式 destroy() 完成关闭。
        webview.onCloseRequested(async (event) => {
          if (!isDirty.value) return; // 无未保存修改，不拦截，交由 Tauri 正常关闭
          event.preventDefault(); // 先拦截本次关闭
          try {
            const action = await askSaveConfirm("文档有未保存的修改，是否保存？");
            if (action === "cancel") return; // 取消关闭，留在当前窗口
            if (action === "save") {
              const saved = await handleSave();
              if (!saved) return; // 保存被取消/失败，留在当前窗口
            }
            webview?.destroy(); // 保存成功或选择不保存：真正关闭窗口
          } catch (err) {
            // 兜底：任何异常都不能让窗口卡死，强制关闭
            console.error("[MilkTypo] close confirm failed:", err);
            webview?.destroy().catch(() => {});
          }
        });
      })
      .catch((e) => console.error("[MilkTypo] webview init failed:", e));
  } else {
    // 浏览器环境兜底：beforeunload 原生提示
    window.addEventListener("beforeunload", onBeforeUnload);
  }

  window.addEventListener("keydown", onKeydown);
  document.addEventListener("click", onDocumentClick);
  // 应用启动时自动加载上次导入的自定义主题（非 Tauri / 无记录时内部静默跳过）
  loadCustomTheme()
    .then(() => refreshThemeStatus())
    .catch((e) => console.warn("[MilkTypo] auto-load theme failed:", e));
  // 刷新固定主题目录下的已安装主题列表（供菜单展示）
  refreshThemeList().catch((e) =>
    console.warn("[MilkTypo] refresh theme list failed:", e)
  );

  // 应用启动时恢复深色模式偏好（无记录时保持默认浅色）
  loadDarkModePreference()
    .then((dark) => {
      if (dark === null) return;
      isDark.value = dark;
      applyDarkMode(dark);
    })
    .catch((e) => console.warn("[MilkTypo] load dark mode failed:", e));
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("click", onDocumentClick);
  window.removeEventListener("beforeunload", onBeforeUnload);
  editorInstance?.destroy();
  editorInstance = null;
});
</script>

<template>
  <!-- 满屏无干扰布局：模拟 Typora 沉浸式写作 -->
  <div class="milktypo-app">
    <!-- 固定顶部极简工具栏（不随编辑区滚动） -->
    <header class="mt-toolbar">
      <div class="mt-toolbar__left" aria-hidden="true"></div>
      <div class="mt-toolbar__center">
        <span class="mt-file-name">
          <span v-if="isDirty" class="mt-dirty-dot" aria-hidden="true"></span>{{ displayName }}
        </span>
      </div>
      <div class="mt-toolbar__right">
        <div ref="themeMenuWrap" class="mt-theme-wrap">
          <button class="mt-btn" @click.stop="toggleThemeMenu">主题</button>
          <div v-if="themeMenuOpen" class="mt-theme-menu" role="menu">
            <div class="mt-theme-menu__status" aria-hidden="true">
              {{ themeStatus }}
            </div>
            <button
              class="mt-theme-menu__item"
              role="menuitem"
              @click="toggleDarkMode"
            >
              深色模式：{{ isDark ? "开" : "关" }}
            </button>

            <div class="mt-theme-menu__sep" role="separator"></div>

            <button
              class="mt-theme-menu__item"
              :class="{ 'mt-theme-menu__item--active': isDefaultThemeActive() }"
              role="menuitem"
              @click="useDefaultTheme"
            >
              内置主题（默认）
            </button>

            <template v-if="installedThemes.length">
              <button
                v-for="t in installedThemes"
                :key="t.filePath"
                class="mt-theme-menu__item"
                :class="{ 'mt-theme-menu__item--active': isThemeActive(t) }"
                role="menuitem"
                @click="switchTheme(t)"
              >
                {{ t.name }}
              </button>
            </template>
            <div v-else-if="isTauri" class="mt-theme-menu__empty">
              （尚未导入主题）
            </div>

            <div class="mt-theme-menu__sep" role="separator"></div>

            <button
              class="mt-theme-menu__item"
              role="menuitem"
              @click="importTheme"
            >
              导入自定义主题...
            </button>
            <button
              v-if="isTauri"
              class="mt-theme-menu__item"
              role="menuitem"
              @click="openThemeFolder"
            >
              打开主题文件夹
            </button>
          </div>
        </div>
        <button class="mt-btn" @click="handleNew">新建</button>
        <button class="mt-btn" @click="handleOpen">打开</button>
        <button class="mt-btn" @click="handleSave">保存</button>
        <button
          class="mt-btn"
          :class="{ 'mt-btn--active': sourceMode }"
          title="源码模式（Ctrl+/）"
          @click="toggleSourceMode"
        >源码</button>
      </div>
    </header>

    <!-- 编辑区：占据工具栏下方全部剩余高度 -->
    <main class="mt-editor-wrap">
      <div
        ref="editorHost"
        class="mt-editor"
        :class="{ 'mt-editor--hidden': sourceMode }"
      ></div>
      <!-- 源码模式：用 textarea 查看/编辑 Markdown 原文。
           v-show 而非 v-if，保证 editorHost 不被销毁、milkdown 视图常驻。 -->
      <textarea
        v-show="sourceMode"
        ref="sourceTextarea"
        class="mt-source"
        :value="sourceDraft"
        spellcheck="false"
        placeholder="Markdown 源码"
        @input="onSourceInput"
      ></textarea>
    </main>

    <!-- 未保存修改确认对话框（保存 / 不保存 / 取消） -->
    <div v-if="confirmState" class="mt-modal-mask" @click.self="resolveConfirm('cancel')">
      <div class="mt-modal" role="dialog" aria-modal="true" aria-label="未保存的修改">
        <p class="mt-modal__message">{{ confirmState.message }}</p>
        <div class="mt-modal__actions">
          <button class="mt-btn mt-btn--danger" @click="resolveConfirm('discard')">不保存</button>
          <button class="mt-btn" @click="resolveConfirm('cancel')">取消</button>
          <button class="mt-btn mt-btn--primary" @click="resolveConfirm('save')">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.milktypo-app {
  position: fixed;
  inset: 0;
  margin: 0;
  padding: 0;
  border: none;
  outline: none;
  box-shadow: none;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--mt-bg, #ffffff);
}

/* 固定顶部工具栏：Typora 风格极简 */
.mt-toolbar {
  flex: 0 0 auto;
  height: 40px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 14px;
  border-bottom: 1px solid var(--mt-border, #eaeaea);
  background: var(--mt-toolbar-bg, #fafafa);
  font-size: 13px;
  color: var(--mt-fg, #333);
  user-select: none;
}

.mt-toolbar__center {
  min-width: 0;
  text-align: center;
}

.mt-toolbar__right {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 8px;
}

.mt-file-name {
  color: var(--mt-muted, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40vw;
  display: inline-block;
  vertical-align: middle;
}

/* 未保存修改的圆点标记 */
.mt-dirty-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--mt-dirty, #e74c3c);
  margin-right: 6px;
}

.mt-btn {
  background: transparent;
  border: 1px solid var(--mt-border, #e0e0e0);
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 13px;
  color: var(--mt-fg, #333);
  cursor: pointer;
  line-height: 1.4;
}

.mt-btn:hover {
  background: var(--mt-hover, #f0f0f0);
}

.mt-btn:active {
  background: var(--mt-active, #e6e6e6);
}

.mt-btn--primary {
  background: var(--mt-accent, #2563eb);
  border-color: var(--mt-accent, #2563eb);
  color: #fff;
}

.mt-btn--primary:hover {
  background: var(--mt-accent-hover, #1d4ed8);
  border-color: var(--mt-accent-hover, #1d4ed8);
}

.mt-btn--danger {
  color: var(--mt-danger, #d33);
}

/* 主题下拉菜单 */
.mt-theme-wrap {
  position: relative;
}

.mt-theme-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 100;
  min-width: 180px;
  max-width: 260px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--mt-bg, #ffffff);
  border: 1px solid var(--mt-border, #e0e0e0);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.mt-theme-menu__status {
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--mt-muted, #888);
  border-bottom: 1px solid var(--mt-border, #e0e0e0);
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}

.mt-theme-menu__item {
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--mt-fg, #333);
  cursor: pointer;
  white-space: nowrap;
}

.mt-theme-menu__item:hover {
  background: var(--mt-hover, #f0f0f0);
}

/* 当前生效主题高亮 */
.mt-theme-menu__item--active {
  color: var(--mt-accent, #2563eb);
  font-weight: 600;
}

.mt-theme-menu__item--active::before {
  content: "✓ ";
}

/* 菜单分组分隔线 */
.mt-theme-menu__sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--mt-border, #e0e0e0);
}

/* 无已安装主题时的提示 */
.mt-theme-menu__empty {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--mt-muted, #888);
}

/* 未保存修改确认对话框 */
.mt-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
}

.mt-modal {
  min-width: 300px;
  max-width: 420px;
  background: var(--mt-bg, #ffffff);
  border-radius: 8px;
  padding: 18px 20px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
}

.mt-modal__message {
  margin: 0 0 16px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--mt-fg, #333);
  white-space: pre-wrap;
}

.mt-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 编辑区容器：占据剩余高度并允许内部滚动 */
.mt-editor-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* editorHost：实际可滚动区域，撑满可用高度。
   Milkdown 会在此容器内新建唯一的 .milkdown 根节点，
   主题样式由 theme/index.css 在该 .milkdown 上生效。 */
.mt-editor {
  width: 100%;
  height: 100%;
  min-height: 100%;
  overflow-y: auto;
  border: none;
  outline: none;
  box-shadow: none;
}

/* 源码模式下隐藏编辑器（display:none 而非销毁 DOM，保证 milkdown 视图常驻） */
.mt-editor--hidden {
  display: none;
}

/* 源码模式 textarea：等宽字体、跟随主题深浅色、软换行 */
.mt-source {
  width: 100%;
  height: 100%;
  display: block;
  box-sizing: border-box;
  padding: 24px 32px;
  border: none;
  outline: none;
  resize: none;
  background: var(--mt-bg, #ffffff);
  color: var(--mt-fg, #333);
  font-family: var(
    --mt-font-mono,
    "SFMono-Regular",
    "JetBrains Mono",
    Consolas,
    "Liberation Mono",
    Menlo,
    Courier,
    monospace
  );
  font-size: 14px;
  line-height: 1.7;
  tab-size: 4;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.mt-source::placeholder {
  color: var(--mt-muted, #888);
}

/* 源码模式按钮激活态 */
.mt-btn--active {
  background: var(--mt-accent, #2563eb);
  border-color: var(--mt-accent, #2563eb);
  color: #fff;
}

.mt-btn--active:hover {
  background: var(--mt-accent-hover, #1d4ed8);
  border-color: var(--mt-accent-hover, #1d4ed8);
}
</style>
