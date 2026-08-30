<script setup lang="ts">
/*
 * Sidebar.vue — 可展开/收拢的侧边栏（Typora 风格）
 *
 * 两个面板：
 * - 文件：浏览当前工作目录的子目录与 Markdown 文件，点击即打开
 * - 大纲：当前文档的标题列表，点击跳转定位
 *
 * 组件只负责展示与事件派发，数据获取（目录扫描、文件读取、大纲收集）
 * 全部由 App.vue 通过 props 传入，便于后续替换为其它数据源。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import type {
  BlankAction,
  DirAction,
  FileAction,
  WorkspaceItem,
} from "@/editor/workspace";
import type { HeadingItem } from "@/editor/index";

const props = defineProps<{
  /** 是否展开（false 时宽度收拢为 0） */
  open: boolean;
  /** 当前工作目录完整路径；null 表示尚未选择 */
  dir: string | null;
  /** 当前目录下的子目录 */
  dirs: WorkspaceItem[];
  /** 当前目录下的文本文件 */
  files: WorkspaceItem[];
  /** 当前正在编辑的文件路径，用于高亮 */
  currentPath: string | null;
  /** 当前文档的大纲条目 */
  headings: HeadingItem[];
  /** 是否处于 Tauri 环境（非 Tauri 下「打开文件夹」不可用） */
  isTauri: boolean;
}>();

const emit = defineEmits<{
  /** 收起侧边栏 */
  (e: "close"): void;
  /** 选择新的工作目录 */
  (e: "pick-folder"): void;
  /** 进入某个子目录 */
  (e: "enter-dir", path: string): void;
  /** 返回上级目录 */
  (e: "go-parent"): void;
  /** 打开某个文件 */
  (e: "open-file", path: string): void;
  /** 跳转到大纲中的某个标题 */
  (e: "goto-heading", pos: number): void;
  /** 文件项右键菜单动作 */
  (e: "file-action", action: FileAction, item: WorkspaceItem): void;
  /** 目录项右键菜单动作 */
  (e: "dir-action", action: DirAction, item: WorkspaceItem): void;
  /** 文件面板空白处右键菜单动作 */
  (e: "blank-action", action: BlankAction): void;
}>();

/** 当前面板 */
const tab = ref<"files" | "outline">("files");

/* ============ 右键菜单 ============ */

/** 菜单作用目标：文件 / 目录 / 面板空白处 */
type MenuTarget =
  | { kind: "file"; item: WorkspaceItem }
  | { kind: "dir"; item: WorkspaceItem }
  | { kind: "blank" };

/** 菜单状态；为 null 时隐藏 */
const menu = ref<{ x: number; y: number; target: MenuTarget } | null>(null);

/** 打开右键菜单（坐标基于视口，菜单用 fixed 定位） */
function openMenu(e: MouseEvent, target: MenuTarget) {
  // 夹紧到视口内，避免菜单被窗口边缘截断
  const x = Math.max(4, Math.min(e.clientX, window.innerWidth - 184));
  const y = Math.max(4, Math.min(e.clientY, window.innerHeight - 196));
  menu.value = { x, y, target };
}

/** 关闭右键菜单 */
function closeMenu() {
  menu.value = null;
}

/** 点击菜单项：按目标类型派发对应事件后关闭菜单 */
function act(action: string) {
  const target = menu.value?.target;
  if (!target) return;
  closeMenu();
  if (target.kind === "file") {
    emit("file-action", action as FileAction, target.item);
  } else if (target.kind === "dir") {
    emit("dir-action", action as DirAction, target.item);
  } else {
    emit("blank-action", action as BlankAction);
  }
}

/** 点击菜单外部 / 滚动 / 窗口失焦时关闭 */
function onDocumentClick() {
  if (menu.value) closeMenu();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && menu.value) closeMenu();
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", closeMenu);
  window.removeEventListener("blur", closeMenu);
});

/** 当前展示的目录名（取路径最后一段） */
function shortName(path: string | null): string {
  if (!path) return "未选择目录";
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  const last = parts[parts.length - 1];
  // 盘符根目录（C:\）时直接返回盘符
  return last || trimmed;
}

/** 文件/目录是否命中当前文件（用于高亮） */
function isActive(path: string): boolean {
  return !!props.currentPath && props.currentPath === path;
}
</script>

<template>
  <aside
    class="mt-sidebar"
    :class="{ 'mt-sidebar--closed': !open }"
    :aria-hidden="!open"
  >
    <!-- 面板切换 + 收起 -->
    <div class="mt-sidebar__head">
      <div class="mt-sidebar__tabs" role="tablist">
        <button
          class="mt-sidebar__tab"
          :class="{ 'mt-sidebar__tab--active': tab === 'files' }"
          role="tab"
          :aria-selected="tab === 'files'"
          @click="tab = 'files'"
        >文件</button>
        <button
          class="mt-sidebar__tab"
          :class="{ 'mt-sidebar__tab--active': tab === 'outline' }"
          role="tab"
          :aria-selected="tab === 'outline'"
          @click="tab = 'outline'"
        >大纲</button>
      </div>
      <button
        class="mt-sidebar__collapse"
        title="收起侧边栏"
        aria-label="收起侧边栏"
        @click="emit('close')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
    </div>

    <!-- 文件面板（空白处右键：新建 / 刷新） -->
    <div
      v-show="tab === 'files'"
      class="mt-sidebar__body"
      @contextmenu.prevent="openMenu($event, { kind: 'blank' })"
    >
      <div class="mt-sidebar__toolbar">
        <button
          class="mt-sidebar__action"
          :disabled="!isTauri"
          :title="isTauri ? '选择要浏览的文件夹' : '桌面端可用'"
          @click="emit('pick-folder')"
        >打开文件夹</button>
      </div>
      <div class="mt-sidebar__cwd" :title="dir ?? ''">{{ shortName(dir) }}</div>

      <ul class="mt-sidebar__list">
        <!-- 返回上级 -->
        <li v-if="dir">
          <button class="mt-sidebar__row" @click="emit('go-parent')">
            <svg class="mt-sidebar__icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span class="mt-sidebar__label">..</span>
          </button>
        </li>
        <!-- 子目录 -->
        <li v-for="d in dirs" :key="d.path">
          <button
            class="mt-sidebar__row"
            :title="d.name"
            @click="emit('enter-dir', d.path)"
            @contextmenu.prevent.stop="openMenu($event, { kind: 'dir', item: d })"
          >
            <svg class="mt-sidebar__icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span class="mt-sidebar__label">{{ d.name }}</span>
          </button>
        </li>
        <!-- 文件 -->
        <li v-for="f in files" :key="f.path">
          <button
            class="mt-sidebar__row"
            :class="{ 'mt-sidebar__row--active': isActive(f.path) }"
            :title="f.name"
            @click="emit('open-file', f.path)"
            @contextmenu.prevent.stop="openMenu($event, { kind: 'file', item: f })"
          >
            <svg class="mt-sidebar__icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              <polyline points="14 3 14 8 19 8" />
            </svg>
            <span class="mt-sidebar__label">{{ f.name }}</span>
          </button>
        </li>
      </ul>

      <p v-if="!dir" class="mt-sidebar__empty">
        点击「打开文件夹」浏览 Markdown 文件
      </p>
      <p v-else-if="!dirs.length && !files.length" class="mt-sidebar__empty">
        当前目录没有子目录或 Markdown 文件
      </p>
    </div>

    <!-- 大纲面板 -->
    <div v-show="tab === 'outline'" class="mt-sidebar__body">
      <ul class="mt-sidebar__list">
        <li v-for="(h, i) in headings" :key="`${h.pos}-${i}`">
          <button
            class="mt-sidebar__row mt-sidebar__row--heading"
            :style="{ paddingLeft: `${8 + (h.level - 1) * 14}px` }"
            :title="h.text"
            @click="emit('goto-heading', h.pos)"
          >
            <span class="mt-sidebar__label">{{ h.text }}</span>
          </button>
        </li>
      </ul>
      <p v-if="!headings.length" class="mt-sidebar__empty">当前文档暂无标题</p>
    </div>

    <!-- 右键菜单（fixed 定位，坐标已在打开时夹紧到视口内） -->
    <div
      v-if="menu"
      class="mt-ctxmenu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <template v-if="menu.target.kind === 'file'">
        <button class="mt-ctxmenu__item" role="menuitem" @click="act('open')">打开</button>
        <button class="mt-ctxmenu__item" role="menuitem" @click="act('copyPath')">复制路径</button>
        <button class="mt-ctxmenu__item" role="menuitem" @click="act('reveal')">在文件管理器中显示</button>
        <div class="mt-ctxmenu__sep" role="separator"></div>
        <button class="mt-ctxmenu__item" role="menuitem" @click="act('rename')">重命名…</button>
        <button
          class="mt-ctxmenu__item mt-ctxmenu__item--danger"
          role="menuitem"
          @click="act('delete')"
        >删除</button>
      </template>

      <template v-else-if="menu.target.kind === 'dir'">
        <button class="mt-ctxmenu__item" role="menuitem" @click="act('reveal')">在文件管理器中显示</button>
      </template>

      <template v-else>
        <button class="mt-ctxmenu__item" role="menuitem" @click="act('newFile')">新建 Markdown 文件</button>
        <div class="mt-ctxmenu__sep" role="separator"></div>
        <button class="mt-ctxmenu__item" role="menuitem" @click="act('refresh')">刷新</button>
      </template>
    </div>
  </aside>
</template>

<style scoped>
/* 侧边栏容器：展开 240px，收拢 0（配合 overflow 隐藏内容） */
.mt-sidebar {
  flex: 0 0 240px;
  width: 240px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--mt-border, #eaeaea);
  background: var(--mt-sidebar-bg, var(--mt-toolbar-bg, #fafafa));
  color: var(--mt-fg, #333);
  font-size: 13px;
  user-select: none;
  transition: width 0.18s ease, flex-basis 0.18s ease;
}

.mt-sidebar--closed {
  flex-basis: 0;
  width: 0;
  border-right: none;
  /* 收拢后彻底移出可交互范围：避免隐藏内容仍能被 Tab 聚焦 */
  visibility: hidden;
}

/* 头部：面板切换 + 收起按钮 */
.mt-sidebar__head {
  flex: 0 0 auto;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-bottom: 1px solid var(--mt-border, #eaeaea);
}

.mt-sidebar__tabs {
  display: flex;
  gap: 2px;
  min-width: 0;
}

.mt-sidebar__tab {
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 13px;
  color: var(--mt-muted, #888);
  cursor: pointer;
  white-space: nowrap;
}

.mt-sidebar__tab:hover {
  background: var(--mt-hover, #f0f0f0);
}

.mt-sidebar__tab--active {
  color: var(--mt-fg, #333);
  font-weight: 600;
  background: var(--mt-active, #e6e6e6);
}

.mt-sidebar__collapse {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--mt-muted, #888);
  cursor: pointer;
}

.mt-sidebar__collapse:hover {
  background: var(--mt-hover, #f0f0f0);
  color: var(--mt-fg, #333);
}

/* 面板主体：可滚动 */
.mt-sidebar__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0 12px;
}

.mt-sidebar__toolbar {
  display: flex;
  gap: 6px;
  padding: 0 8px 6px;
}

.mt-sidebar__action {
  flex: 1 1 auto;
  background: transparent;
  border: 1px solid var(--mt-border, #e0e0e0);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--mt-fg, #333);
  cursor: pointer;
}

.mt-sidebar__action:hover:not(:disabled) {
  background: var(--mt-hover, #f0f0f0);
}

.mt-sidebar__action:disabled {
  color: var(--mt-muted, #999);
  cursor: not-allowed;
  opacity: 0.6;
}

/* 当前目录名（超长省略） */
.mt-sidebar__cwd {
  padding: 2px 10px 6px;
  font-size: 12px;
  color: var(--mt-muted, #888);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mt-sidebar__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

/* 一行条目（目录 / 文件 / 大纲项） */
.mt-sidebar__row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px;
  background: transparent;
  border: none;
  text-align: left;
  font-size: 13px;
  line-height: 1.4;
  color: var(--mt-fg, #333);
  cursor: pointer;
  overflow: hidden;
}

.mt-sidebar__row:hover {
  background: var(--mt-hover, #f0f0f0);
}

/* 当前打开的文件 */
.mt-sidebar__row--active {
  color: var(--mt-accent, #2563eb);
  font-weight: 600;
  background: var(--mt-active, #e6e6e6);
}

.mt-sidebar__icon {
  flex: 0 0 auto;
  color: var(--mt-muted, #888);
}

.mt-sidebar__row--active .mt-sidebar__icon {
  color: var(--mt-accent, #2563eb);
}

.mt-sidebar__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 大纲项：层级靠左缩进，弱化的层级线提示 */
.mt-sidebar__row--heading {
  color: var(--mt-fg, #333);
}

.mt-sidebar__empty {
  margin: 8px 0 0;
  padding: 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--mt-muted, #888);
}

/* 右键菜单：fixed 定位，坐标由打开事件夹紧到视口内 */
.mt-ctxmenu {
  position: fixed;
  z-index: 200;
  min-width: 168px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--mt-bg, #ffffff);
  border: 1px solid var(--mt-border, #e0e0e0);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.mt-ctxmenu__item {
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

.mt-ctxmenu__item:hover {
  background: var(--mt-hover, #f0f0f0);
}

/* 破坏性操作（删除）：文字与悬停底均用危险色系 */
.mt-ctxmenu__item--danger {
  color: var(--mt-danger, #d33);
}

.mt-ctxmenu__item--danger:hover {
  background: var(--mt-danger-soft, #fdecea);
  color: var(--mt-danger, #d33);
}

.mt-ctxmenu__sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--mt-border, #e0e0e0);
}
</style>
