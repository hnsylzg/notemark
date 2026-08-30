/*
 * workspace.ts — 侧边栏「文件」面板的工作区能力（Tauri v2）
 *
 * 职责：
 * - pickFolder()：弹出目录选择对话框，返回选中的目录路径
 * - listWorkspace(dir)：列出目录下的子目录与 Markdown 文件（单层，不递归）
 * - readMarkdownFile(path)：读取文本文件内容（UTF-8 优先，GBK 回退）
 * - parentDir(dir)：上级目录（用于「返回上级」）
 * - load/saveWorkspaceDir：持久化当前工作目录（下次启动自动恢复）
 * - load/saveSidebarOpen：持久化侧边栏展开状态
 * - load/push/remove/clearRecentFiles：最近打开文件的列表持久化（上限 10 条）
 *
 * 设计要点：
 * - 所有 Tauri API 均动态 import，纯浏览器（vite dev）环境下调用会静默失败，
 *   不会导致模块加载报错。
 * - 只读单层目录：递归扫描大目录会明显卡顿，且侧边栏以「就近文件」为主，
 *   需要更深的层级时用户可继续点进子目录。
 * - 依赖的 Tauri 权限均已具备：fs:allow-read-dir、fs:allow-read-file、
 *   fs:allow-read-text-file、dialog:default、store:default。
 */

import { open } from "@tauri-apps/plugin-dialog";

/** 是否处于 Tauri 环境（纯浏览器 vite dev 下不调用 Tauri API） */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 侧边栏列出的文本扩展名 */
const TEXT_EXT = /\.(md|markdown|txt)$/i;

/** 一个目录项（子目录或文件） */
export interface WorkspaceItem {
  /** 名称（含扩展名），用于展示 */
  name: string;
  /** 完整路径，用于打开/进入 */
  path: string;
}

/** 一次目录扫描的结果 */
export interface WorkspaceListing {
  /** 子目录列表（按名称排序） */
  dirs: WorkspaceItem[];
  /** 文本文件列表（按名称排序） */
  files: WorkspaceItem[];
}

/** store 文件名（与 themeManager 共用同一个 settings.json） */
const STORE_FILE = "settings.json";
/** 当前工作目录的持久化 key */
const WORKSPACE_DIR_KEY = "workspaceDir";
/** 侧边栏展开状态的持久化 key */
const SIDEBAR_OPEN_KEY = "sidebarOpen";

/** 加载持久化 store；非 Tauri 环境会抛错，由调用方 catch */
async function getStore() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(STORE_FILE);
}

/**
 * 弹出目录选择对话框。
 * @returns 选中的目录路径；用户取消或非 Tauri 环境返回 null
 */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择要浏览的文件夹",
    });
    return typeof selected === "string" ? selected : null;
  } catch (err) {
    console.warn("[NoteMark] pick folder failed:", err);
    return null;
  }
}

/**
 * 列出目录下的子目录与文本文件（单层）。
 * @returns { dirs, files }；目录不可读（不存在/被移动/无权限）或非 Tauri 环境返回 null
 */
export async function listWorkspace(
  dir: string
): Promise<WorkspaceListing | null> {
  if (!isTauri || !dir) return null;
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const entries = await readDir(dir);
    const dirs: WorkspaceItem[] = [];
    const files: WorkspaceItem[] = [];
    for (const entry of entries) {
      // 跳过隐藏项（.git / .vscode 等）
      if (entry.name.startsWith(".")) continue;
      const path = await join(dir, entry.name);
      if (entry.isDirectory) dirs.push({ name: entry.name, path });
      else if (TEXT_EXT.test(entry.name)) files.push({ name: entry.name, path });
    }
    const byName = (a: WorkspaceItem, b: WorkspaceItem) =>
      a.name.localeCompare(b.name, "zh");
    return { dirs: dirs.sort(byName), files: files.sort(byName) };
  } catch (err) {
    // 目录已被删除/移动或无权限：返回 null，由调用方清空面板而不是停在无效目录
    console.warn("[NoteMark] list workspace failed:", err);
    return null;
  }
}

/**
 * 读取文本文件内容，自适应 UTF-8 / GBK 编码。
 *
 * 背景：readTextFile 固定按 UTF-8 解码，而 Windows 记事本新建的
 * txt/md 默认是 ANSI/GBK 编码，按 UTF-8 解码会出现 U+FFFD 替换字符。
 * 这里改为二进制读取：先按 UTF-8 解码（去 BOM），
 * 若出现替换字符则回退用 GBK 解码。
 */
export async function readMarkdownFile(path: string): Promise<string> {
  const { readFile, readTextFile } = await import("@tauri-apps/plugin-fs");
  try {
    const bytes = await readFile(path);
    if (bytes.length === 0) return "";
    const utf8 = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
    if (!utf8.includes("\uFFFD")) return utf8;
    try {
      return new TextDecoder("gbk").decode(bytes);
    } catch {
      return utf8; // 运行环境不支持 gbk 时回退 UTF-8 结果
    }
  } catch (err) {
    // readFile 不可用时回退到 readTextFile（权限更早就已具备）
    console.warn("[NoteMark] readFile unavailable, fallback to readTextFile:", err);
    return readTextFile(path);
  }
}

/** 取上级目录；已在盘符根目录时返回 null（表示不能再往上） */
export function parentDir(dir: string): string | null {
  const trimmed = dir.replace(/[\\/]+$/, "");
  // 盘符根目录（C:\）或 Unix 根（/）没有上级
  if (/^[a-zA-Z]:$/.test(trimmed) || trimmed === "" ) return null;
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  if (parent === "") return null;
  // 保留盘符后的反斜杠：C:\a → C:\ （父级为根目录，仍需可进入）
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** 读取上次的工作目录；无记录 / 非 Tauri 返回 null */
export async function loadWorkspaceDir(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const store = await getStore();
    const value = await store.get<string>(WORKSPACE_DIR_KEY);
    return typeof value === "string" && value ? value : null;
  } catch (err) {
    console.warn("[NoteMark] load workspace dir failed:", err);
    return null;
  }
}

/** 清除持久化的工作目录（目录已失效时调用，避免下次启动仍尝试恢复） */
export async function clearWorkspaceDir(): Promise<void> {
  if (!isTauri) return;
  try {
    const store = await getStore();
    await store.delete(WORKSPACE_DIR_KEY);
    await store.save();
  } catch (err) {
    console.warn("[NoteMark] clear workspace dir failed:", err);
  }
}

/** 持久化当前工作目录（失败仅告警） */
export async function saveWorkspaceDir(dir: string): Promise<void> {
  if (!isTauri) return;
  try {
    const store = await getStore();
    await store.set(WORKSPACE_DIR_KEY, dir);
    await store.save();
  } catch (err) {
    console.warn("[NoteMark] save workspace dir failed:", err);
  }
}

/** 读取侧边栏展开状态；无记录 / 非 Tauri 返回 null（由调用方决定默认值） */
export async function loadSidebarOpen(): Promise<boolean | null> {
  if (!isTauri) return null;
  try {
    const store = await getStore();
    const value = await store.get<boolean>(SIDEBAR_OPEN_KEY);
    return typeof value === "boolean" ? value : null;
  } catch (err) {
    console.warn("[NoteMark] load sidebar state failed:", err);
    return null;
  }
}

/** 持久化侧边栏展开状态（失败仅告警） */
export async function saveSidebarOpen(open: boolean): Promise<void> {
  if (!isTauri) return;
  try {
    const store = await getStore();
    await store.set(SIDEBAR_OPEN_KEY, open);
    await store.save();
  } catch (err) {
    console.warn("[NoteMark] save sidebar state failed:", err);
  }
}

/** 最近打开文件的持久化 key */
const RECENT_FILES_KEY = "recentFiles";
/** 最近打开文件列表的条数上限 */
const RECENT_LIMIT = 10;

/** 最近打开文件条目 */
export interface RecentFile {
  /** 文件完整路径，用于再次打开 */
  path: string;
  /** 文件名，用于列表展示 */
  name: string;
}

/** 读取最近打开的文件列表（最近使用的排在最前）；无记录 / 非 Tauri 返回空数组 */
export async function loadRecentFiles(): Promise<RecentFile[]> {
  if (!isTauri) return [];
  try {
    const store = await getStore();
    const value = await store.get<RecentFile[]>(RECENT_FILES_KEY);
    if (!Array.isArray(value)) return [];
    // 过滤掉结构损坏的条目，避免渲染时报错
    return value.filter(
      (f): f is RecentFile => !!f && typeof f.path === "string" && typeof f.name === "string"
    );
  } catch (err) {
    console.warn("[NoteMark] load recent files failed:", err);
    return [];
  }
}

/**
 * 记录一次文件使用：已存在则提到最前，超出上限的旧记录被丢弃。
 * @returns 更新后的完整列表，供调用方同步内存状态
 */
export async function pushRecentFile(file: RecentFile): Promise<RecentFile[]> {
  if (!isTauri) return [];
  const list = await loadRecentFiles();
  // Windows 路径大小写不敏感，统一按小写比较，避免同一文件留下两条记录
  const next = [
    file,
    ...list.filter((f) => f.path.toLowerCase() !== file.path.toLowerCase()),
  ].slice(0, RECENT_LIMIT);
  await saveRecentFiles(next);
  return next;
}

/** 从列表中移除指定路径（文件已被删除/移动时调用） */
export async function removeRecentFile(path: string): Promise<RecentFile[]> {
  if (!isTauri) return [];
  const list = await loadRecentFiles();
  const next = list.filter((f) => f.path.toLowerCase() !== path.toLowerCase());
  await saveRecentFiles(next);
  return next;
}

/** 清空最近打开文件列表 */
export async function clearRecentFiles(): Promise<void> {
  await saveRecentFiles([]);
}

/** 写入最近文件列表（失败仅告警，不影响主流程） */
async function saveRecentFiles(list: RecentFile[]): Promise<void> {
  if (!isTauri) return;
  try {
    const store = await getStore();
    await store.set(RECENT_FILES_KEY, list);
    await store.save();
  } catch (err) {
    console.warn("[NoteMark] save recent files failed:", err);
  }
}

/* ============ 侧边栏右键菜单动作（Sidebar.vue 与 App.vue 共用） ============ */

/** 文件项右键菜单支持的动作 */
export type FileAction = "open" | "copyPath" | "reveal" | "rename" | "delete";
/** 目录项右键菜单支持的动作 */
export type DirAction = "reveal";
/** 文件面板空白处右键菜单支持的动作 */
export type BlankAction = "newFile" | "refresh";

/* ============ 文件管理操作（右键菜单） ============ */

/** 重命名（或移动）文件/目录 */
export async function renamePath(
  oldPath: string,
  newPath: string
): Promise<void> {
  const { rename } = await import("@tauri-apps/plugin-fs");
  await rename(oldPath, newPath);
}

/**
 * 把文件/目录移入系统回收站（可恢复）。
 *
 * 走后端自定义命令 trash_delete（Rust 的 trash crate）：
 * 前端 fs 插件只有 remove，属于直接删除、无法恢复，
 * 因此回收站能力必须在 Rust 侧实现。
 */
export async function trashPath(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<void>("trash_delete", { path });
}

/** 判断路径是否存在（检查失败按“不存在”处理） */
export async function pathExists(path: string): Promise<boolean> {
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(path);
  } catch (err) {
    console.warn("[NoteMark] exists check failed:", err);
    return false;
  }
}

/** 在系统文件管理器中定位并选中该路径 */
export async function revealInFileManager(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** 新建文本文件（默认写入空内容） */
export async function createTextFile(
  path: string,
  content = ""
): Promise<void> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(path, content);
}

/** 拼接目录与文件名（跨平台分隔符） */
export async function joinPath(dir: string, name: string): Promise<string> {
  const { join } = await import("@tauri-apps/api/path");
  return join(dir, name);
}

/** 补齐 Markdown 扩展名：已有 .md/.markdown/.txt 时原样返回 */
export function ensureMarkdownExt(name: string): string {
  return /\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`;
}
