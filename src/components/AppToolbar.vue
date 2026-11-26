<script setup lang="ts">
import {
  MAX_EDITOR_FONT_SCALE,
  MIN_EDITOR_FONT_SCALE,
  formatEditorFontScale,
} from "@/editor/editor-font-scale";
import type { EditorContentWidthMode } from "@/editor/editor-content-width";
import type { RecentFile } from "@/editor/workspace";

interface InstalledTheme {
  name: string;
  filePath: string;
}

defineProps<{
  sidebarOpen: boolean;
  needsSave: boolean;
  displayName: string;
  recentFiles: RecentFile[];
  installedThemes: InstalledTheme[];
  activeThemePath: string | null;
  isDark: boolean;
  isTauri: boolean;
  sourceMode: boolean;
  recentMenuOpen: boolean;
  saveMenuOpen: boolean;
  exportMenuOpen: boolean;
  themeMenuOpen: boolean;
  fontScale: number;
  contentWidth: EditorContentWidthMode;
  codeBlockLineWrap: boolean;
}>();

const emit = defineEmits<{
  toggleSidebar: [];
  newFile: [];
  openFile: [];
  toggleRecentMenu: [];
  openRecent: [path: string];
  clearRecent: [];
  save: [];
  toggleSaveMenu: [];
  saveAs: [];
  toggleExportMenu: [];
  export: [format: "html" | "pdf" | "docx" | "txt"];
  toggleThemeMenu: [];
  decreaseFontScale: [];
  increaseFontScale: [];
  resetFontScale: [];
  setContentWidth: [mode: EditorContentWidthMode];
  setCodeBlockLineWrap: [enabled: boolean];
  toggleDarkMode: [];
  useDefaultTheme: [];
  switchTheme: [theme: InstalledTheme];
  importTheme: [];
  openThemeFolder: [];
  toggleSourceMode: [];
}>();

function dirOfPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function isDefaultThemeActive(activeThemePath: string | null): boolean {
  return activeThemePath === null;
}

function isThemeActive(
  theme: InstalledTheme,
  activeThemePath: string | null
): boolean {
  return activeThemePath?.toLowerCase() === theme.filePath.toLowerCase();
}

const contentWidthOptions: Array<{
  value: EditorContentWidthMode;
  label: string;
}> = [
  { value: "standard", label: "标准" },
  { value: "adaptive", label: "自适应" },
  { value: "full", label: "全宽" },
];
</script>

<template>
  <header class="mt-toolbar">
    <div class="mt-toolbar__left">
      <button
        class="mt-btn mt-btn--icon"
        :class="{ 'mt-btn--icon-on': sidebarOpen }"
        :title="sidebarOpen ? '收起侧边栏' : '展开侧边栏'"
        :aria-expanded="sidebarOpen"
        aria-label="切换侧边栏"
        @click="emit('toggleSidebar')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
      </button>
    </div>

    <div class="mt-toolbar__center">
      <span class="mt-file-name">
        <span v-if="needsSave" class="mt-dirty-dot" aria-hidden="true"></span>{{ displayName }}
      </span>
    </div>

    <div class="mt-toolbar__right">
      <button class="mt-btn mt-btn--icon" title="新建" aria-label="新建" @click="emit('newFile')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <line x1="9" y1="14" x2="15" y2="14" />
        </svg>
      </button>

      <div class="mt-split">
        <button class="mt-btn mt-btn--icon mt-split__main" title="打开" aria-label="打开" @click="emit('openFile')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
        </button>
        <button
          class="mt-btn mt-btn--icon mt-split__arrow"
          title="最近打开"
          aria-label="最近打开"
          :aria-expanded="recentMenuOpen"
          @click.stop="emit('toggleRecentMenu')"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <div v-if="recentMenuOpen" class="mt-theme-menu mt-theme-menu--recent" role="menu">
          <div class="mt-theme-menu__status" aria-hidden="true">最近打开</div>
          <template v-if="recentFiles.length">
            <button
              v-for="file in recentFiles"
              :key="file.path"
              class="mt-theme-menu__item mt-recent__item"
              role="menuitem"
              :title="file.path"
              @click="emit('openRecent', file.path)"
            >
              <span class="mt-recent__name">{{ file.name }}</span>
              <span class="mt-recent__dir">{{ dirOfPath(file.path) }}</span>
            </button>
            <div class="mt-theme-menu__sep" role="separator"></div>
            <button class="mt-theme-menu__item mt-theme-menu__item--muted" role="menuitem" @click="emit('clearRecent')">
              清空列表
            </button>
          </template>
          <div v-else class="mt-theme-menu__empty">（暂无记录）</div>
        </div>
      </div>

      <div class="mt-split">
        <button class="mt-btn mt-btn--icon mt-split__main" title="保存 (Ctrl+S)" aria-label="保存" @click="emit('save')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
        </button>
        <button
          class="mt-btn mt-btn--icon mt-split__arrow"
          title="另存为 (Ctrl+Shift+S)"
          aria-label="另存为"
          :aria-expanded="saveMenuOpen"
          @click.stop="emit('toggleSaveMenu')"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <div v-if="saveMenuOpen" class="mt-theme-menu" role="menu">
          <button class="mt-theme-menu__item" role="menuitem" @click="emit('saveAs')">另存为…</button>
        </div>
      </div>

      <div class="mt-theme-wrap">
        <button class="mt-btn mt-btn--icon" title="导出" aria-label="导出" @click.stop="emit('toggleExportMenu')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
        <div v-if="exportMenuOpen" class="mt-theme-menu" role="menu">
          <button class="mt-theme-menu__item" role="menuitem" @click="emit('export', 'html')">HTML 网页（.html）</button>
          <button class="mt-theme-menu__item" role="menuitem" @click="emit('export', 'pdf')">PDF 文档（.pdf）</button>
          <button class="mt-theme-menu__item" role="menuitem" @click="emit('export', 'docx')">Word 文档（.docx）</button>
          <div class="mt-theme-menu__sep" role="separator"></div>
          <button class="mt-theme-menu__item" role="menuitem" @click="emit('export', 'txt')">纯文本（.txt）</button>
        </div>
      </div>

      <div class="mt-toolbar__sep" role="separator"></div>

      <div class="mt-theme-wrap">
        <button class="mt-btn mt-btn--icon" title="主题" aria-label="主题" @click.stop="emit('toggleThemeMenu')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" stroke="none" />
            <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" stroke="none" />
            <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" stroke="none" />
            <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" stroke="none" />
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
          </svg>
        </button>
        <div v-if="themeMenuOpen" class="mt-theme-menu" role="menu">
          <div class="mt-theme-menu__font-row" role="group" aria-label="字号">
            <span class="mt-theme-menu__font-label">字号</span>
            <button
              class="mt-theme-menu__font-step"
              title="缩小字号 (Ctrl+-)"
              aria-label="缩小字号"
              role="menuitem"
              :disabled="fontScale <= MIN_EDITOR_FONT_SCALE"
              @click="emit('decreaseFontScale')"
            >
              A−
            </button>
            <button
              class="mt-theme-menu__font-value"
              title="恢复 100%（跟随主题）"
              aria-label="恢复默认字号"
              role="menuitem"
              @click="emit('resetFontScale')"
            >
              {{ formatEditorFontScale(fontScale) }}
            </button>
            <button
              class="mt-theme-menu__font-step"
              title="放大字号 (Ctrl+=)"
              aria-label="放大字号"
              role="menuitem"
              :disabled="fontScale >= MAX_EDITOR_FONT_SCALE"
              @click="emit('increaseFontScale')"
            >
              A+
            </button>
          </div>
          <div
            class="mt-theme-menu__width-row"
            role="group"
            aria-label="文档宽度"
          >
            <span class="mt-theme-menu__font-label">宽度</span>
            <button
              v-for="option in contentWidthOptions"
              :key="option.value"
              class="mt-theme-menu__width-option"
              :class="{
                'mt-theme-menu__width-option--active':
                  contentWidth === option.value,
              }"
              role="menuitemradio"
              :aria-checked="contentWidth === option.value"
              @click="emit('setContentWidth', option.value)"
            >
              {{ option.label }}
            </button>
          </div>
          <button
            class="mt-theme-menu__item"
            role="menuitem"
            @click="emit('setCodeBlockLineWrap', !codeBlockLineWrap)"
          >
            代码块自动换行：{{ codeBlockLineWrap ? "开" : "关" }}
          </button>
          <button class="mt-theme-menu__item" role="menuitem" @click="emit('toggleDarkMode')">
            深色模式：{{ isDark ? "开" : "关" }}
          </button>
          <div class="mt-theme-menu__sep" role="separator"></div>
          <button
            class="mt-theme-menu__item"
            :class="{ 'mt-theme-menu__item--active': isDefaultThemeActive(activeThemePath) }"
            role="menuitem"
            @click="emit('useDefaultTheme')"
          >
            内置主题（默认）
          </button>
          <template v-if="installedThemes.length">
            <button
              v-for="theme in installedThemes"
              :key="theme.filePath"
              class="mt-theme-menu__item"
              :class="{ 'mt-theme-menu__item--active': isThemeActive(theme, activeThemePath) }"
              role="menuitem"
              @click="emit('switchTheme', theme)"
            >
              {{ theme.name }}
            </button>
          </template>
          <div class="mt-theme-menu__sep" role="separator"></div>
          <button class="mt-theme-menu__item" role="menuitem" @click="emit('importTheme')">导入自定义主题...</button>
          <button v-if="isTauri" class="mt-theme-menu__item" role="menuitem" @click="emit('openThemeFolder')">打开主题文件夹</button>
        </div>
      </div>

      <button
        class="mt-btn mt-btn--icon"
        :class="{ 'mt-btn--icon-on': sourceMode }"
        title="源码模式"
        aria-label="源码模式"
        @click="emit('toggleSourceMode')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
/* 工具栏拆为组件后必须自带 scoped 样式；父 App 的 scoped CSS 不会穿透子组件内部。 */
.mt-toolbar {
  position: relative;
  flex: 0 0 auto;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 14px;
  border-bottom: 1px solid var(--mt-border, #eaeaea);
  background: var(--mt-toolbar-bg, #fafafa);
  font-size: 13px;
  color: var(--mt-fg, #333);
  user-select: none;
}

.mt-toolbar__left,
.mt-toolbar__right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  white-space: nowrap;
}

.mt-toolbar__center {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  --mt-side-safe: 260px;
  max-width: calc(100% - 2 * var(--mt-side-safe));
  text-align: center;
  overflow: hidden;
}

.mt-file-name {
  color: var(--mt-muted, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  display: inline-block;
  vertical-align: middle;
}

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
  white-space: nowrap;
  flex-shrink: 0;
}

.mt-btn:hover {
  background: var(--mt-hover, #f0f0f0);
}

.mt-btn:active {
  background: var(--mt-active, #e6e6e6);
}

.mt-btn--icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  padding: 0;
}

.mt-btn--icon-on {
  background: var(--mt-active, #e6e6e6);
  border-color: var(--mt-border, #e0e0e0);
  color: var(--mt-fg, #333);
}

.mt-btn--icon-on:hover {
  background: var(--mt-hover, #f0f0f0);
  border-color: var(--mt-border, #e0e0e0);
  color: var(--mt-fg, #333);
}

.mt-split {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

.mt-split__main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.mt-split__arrow {
  width: 18px;
  margin-left: -1px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.mt-toolbar__sep {
  width: 1px;
  height: 16px;
  margin: 0 2px;
  background: var(--mt-border, #e0e0e0);
  flex-shrink: 0;
}

.mt-theme-menu--recent {
  min-width: 220px;
  max-width: 320px;
}

.mt-recent__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  max-width: 100%;
}

.mt-recent__name,
.mt-recent__dir {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mt-recent__dir {
  font-size: 11px;
  color: var(--mt-muted, #888);
}

.mt-theme-menu__item--muted {
  color: var(--mt-muted, #888);
}

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

.mt-theme-menu__font-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 26px 42px 26px;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 10px;
}

.mt-theme-menu__font-label {
  font-size: 13px;
  line-height: 1.4;
  color: var(--mt-fg, #333);
  white-space: nowrap;
}

.mt-theme-menu__font-step,
.mt-theme-menu__font-value {
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--mt-fg, #333);
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.mt-theme-menu__font-step:hover,
.mt-theme-menu__font-value:hover {
  background: var(--mt-hover, #f0f0f0);
}

.mt-theme-menu__font-step:disabled {
  cursor: default;
  opacity: 0.35;
}

.mt-theme-menu__font-value {
  color: var(--mt-muted, #888);
  font-variant-numeric: tabular-nums;
}

.mt-theme-menu__width-row {
  display: grid;
  grid-template-columns: auto repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: 4px;
  padding: 2px 6px 4px 10px;
}

.mt-theme-menu__width-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  box-sizing: border-box;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--mt-fg, #333);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  white-space: nowrap;
}

.mt-theme-menu__width-option:hover {
  background: var(--mt-hover, #f0f0f0);
}

.mt-theme-menu__width-option--active {
  background: var(--mt-color-primary-soft, #e8f0fe);
  color: var(--mt-color-primary, #2563eb);
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

.mt-theme-menu__item--active {
  color: var(--mt-accent, #2563eb);
}

.mt-theme-menu__item--active::before {
  content: "✓ ";
}

.mt-theme-menu__sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--mt-border, #e0e0e0);
}

.mt-theme-menu__empty {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--mt-muted, #888);
}

</style>
