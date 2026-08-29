/*
 * fileOps.ts — 文件操作封装层（Tauri v2）
 *
 * 职责：
 * - openFile()：打开 .md/.markdown/.txt 文件，返回 { path, name, content }
 * - saveFile()：保存到指定路径，或在没有路径时弹出“另存为”对话框
 * - newFile()：逻辑上“新建”，仅返回空标记（实际清空由调用方用 setMarkdown 完成）
 *
 * 依赖（Tauri v2 前端插件）：
 * - @tauri-apps/plugin-dialog  -> open / save
 * - @tauri-apps/plugin-fs     -> readTextFile / writeTextFile
 *
 * 这些 API 在非 Tauri 环境（纯 vite dev 浏览器）下会抛错，
 * 调用方应自行 try/catch 并向用户提示。
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

/** 可被打开/另存的文本扩展名 */
const TEXT_FILTERS = [
  {
    name: "Markdown",
    extensions: ["md", "markdown", "txt"],
  },
];

export interface OpenedFile {
  /** 文件完整路径（用于后续直接保存） */
  path: string;
  /** 文件名，用于标题栏展示 */
  name: string;
  /** 文件文本内容 */
  content: string;
}

/**
 * 打开文件对话框，选择单个 markdown/纯文本文件并读取内容。
 * @returns 用户取消则返回 null；否则返回文件信息
 */
export async function openFile(): Promise<OpenedFile | null> {
  const selected = await open({
    multiple: false,
    filters: TEXT_FILTERS,
  });

  // open() 在 multiple:false 时返回 string | null
  if (typeof selected !== "string") return null;

  const content = await readTextFile(selected);
  const name = selected.split(/[\\/]/).pop() || selected;

  return { path: selected, name, content };
}

export interface SaveResult {
  /** 实际写入的路径（可能是原有路径，也可能是另存为的新路径） */
  path: string;
  /** 文件名，用于标题栏展示 */
  name: string;
}

/**
 * 保存文件。
 * @param content 当前编辑器导出的 Markdown 文本
 * @param currentPath 当前已打开文件的路径；为空表示“新建未保存”
 * @returns 用户取消则返回 null；否则返回写入结果
 */
export async function saveFile(
  content: string,
  currentPath?: string | null
): Promise<SaveResult | null> {
  // 已有路径：直接覆盖保存
  if (currentPath) {
    await writeTextFile(currentPath, content);
    const name = currentPath.split(/[\\/]/).pop() || currentPath;
    return { path: currentPath, name };
  }

  // 无路径：弹出“另存为”对话框
  const target = await save({
    filters: TEXT_FILTERS,
    defaultPath: "untitled.md",
  });

  if (!target) return null; // 用户取消

  await writeTextFile(target, content);
  const name = target.split(/[\\/]/).pop() || target;
  return { path: target, name };
}

/**
 * 新建文件的逻辑标记。
 * 这里只负责把“无路径”状态返回给调用方；
 * 真正的清空由调用方用编辑器的 setMarkdown("") 完成。
 *
 * name 使用 "untitled"（不含扩展名），与 save() 的
 * defaultPath: "untitled.md" 保持一致，避免显示名与保存对话框默认名不一致。
 */
export function newFile(): { path: null; name: string } {
  return { path: null, name: "untitled" };
}
