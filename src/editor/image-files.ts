/*
 * image-files.ts — 图片文件导入的公共逻辑（粘贴与拖拽共用）
 *
 * 职责：把一批图片 File 存进「文档目录 / assets /」，并在指定位置插入图片节点。
 * 不关心图片从哪来，入口由 image-paste.ts（剪贴板）与 image-drop.ts（拖放）调用。
 *
 * 为什么单独拆一层：粘贴和拖放只有「插入位置怎么定」不同
 * （粘贴用光标、拖放用鼠标落点），保存与插入的部分完全一致，
 * 放一份才能避免两处逻辑各自漂移。
 *
 * 行为（对齐 Typora）：
 * - 图片写入「当前文档所在目录 / assets /」；
 * - 文档里插入相对路径 ![](assets/xxx.png)，由 image-view.ts 解析渲染，
 *   文档与 assets 一起移动时图片依然可用；
 * - 文档未保存（没有所在目录）时提示先保存，不产生任何临时图片。
 *
 * 设计要点：
 * - 写文件是异步的，而 ProseMirror 的 handlePaste / handleDrop 要求同步返回，
 *   所以调用方只负责拦截与定位，保存插入在这里异步进行。
 * - 非 Tauri 环境（纯浏览器调试）无法写磁盘，回退为 data URL，
 *   且不要求文档已保存 —— 保证本地调试时功能依然可用。
 * - 「必须先保存」的约束只在 Tauri 下生效：写文件需要知道文档所在目录。
 */
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/prose/view";
import { getImageBaseDir } from "./image-view";

/** 图片存放的子目录名（相对当前文档所在目录） */
const ASSETS_DIR = "assets";

/** 是否处于 Tauri 环境 */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * 导入一批图片文件的统一入口。
 * @param anchorPos 插入起点：粘贴传光标位置，拖放传落点坐标换算出的位置
 */
export function importImages(
  view: EditorView,
  files: File[],
  anchorPos: number
): void {
  // 非 Tauri（纯浏览器调试）写不了磁盘，直接内嵌 base64。
  // 必须排在「要求先保存」之前：浏览器里根本没有保存目录。
  if (!isTauri) {
    void insertImageFiles(view, files, null, anchorPos);
    return;
  }
  const baseDir = getImageBaseDir();
  if (!baseDir) {
    alert(
      "请先保存文档（Ctrl+S）后再粘贴或拖入图片 —— 需要知道文档所在目录，才能把图片存到旁边的 assets 文件夹。"
    );
    return;
  }
  void insertImageFiles(view, files, baseDir, anchorPos);
}

/**
 * 依次保存并插入多张图片，每插一张推进一次位置。
 * @param baseDir 文档所在目录；null 表示写不了磁盘，回退内嵌 data URL
 */
async function insertImageFiles(
  view: EditorView,
  files: File[],
  baseDir: string | null,
  anchorPos: number
): Promise<void> {
  // 写文件期间用户可能继续输入，anchorPos 只能作为起点
  let pos = Math.min(anchorPos, view.state.doc.content.size);
  for (const file of files) {
    const src = await saveImageFile(file, baseDir);
    if (!src) continue;
    const node = view.state.schema.nodes.image?.createAndFill({ src, alt: "" });
    if (!node) continue;
    const at = Math.min(pos, view.state.doc.content.size);
    view.dispatch(view.state.tr.insert(at, node));
    pos = at + node.nodeSize;
  }
}

/**
 * 从磁盘路径导入图片（Tauri 原生拖放走这条路）。
 * 与 importImages 的区别只在数据来源：这里是完整路径，那边是 File 对象。
 */
export function importImagePaths(
  editor: Editor,
  paths: string[],
  anchorPos: number
): void {
  const baseDir = getImageBaseDir();
  if (!baseDir) {
    alert(
      "请先保存文档（Ctrl+S）后再拖入图片 —— 需要知道文档所在目录，才能把图片存到旁边的 assets 文件夹。"
    );
    return;
  }
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    void insertImagePaths(view, paths, baseDir, anchorPos);
  });
}

/** 依次读取路径对应的图片并插入，每插一张推进一次位置 */
async function insertImagePaths(
  view: EditorView,
  paths: string[],
  baseDir: string,
  anchorPos: number
): Promise<void> {
  let pos = Math.min(anchorPos, view.state.doc.content.size);
  for (const path of paths) {
    const src = await saveImageFromPath(path, baseDir);
    if (!src) continue;
    const node = view.state.schema.nodes.image?.createAndFill({ src, alt: "" });
    if (!node) continue;
    const at = Math.min(pos, view.state.doc.content.size);
    view.dispatch(view.state.tr.insert(at, node));
    pos = at + node.nodeSize;
  }
}

/** 读取磁盘上的图片并复制进 assets；失败返回 null（已提示用户） */
async function saveImageFromPath(
  path: string,
  baseDir: string
): Promise<string | null> {
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(path);
    const name = path.split(/[\\/]/).pop() ?? `image-${stamp()}.png`;
    return await writeImageToAssets(bytes, name, baseDir);
  } catch (err) {
    console.error("[NoteMark] import image from path failed:", err);
    alert(`导入图片失败：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 把一张图片写入「文档目录 / assets /」。
 * @returns 写进 markdown 的相对路径；失败返回 null（已提示用户）
 */
async function saveImageFile(
  file: File,
  baseDir: string | null
): Promise<string | null> {
  if (baseDir === null) return await toDataUrl(file);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return await writeImageToAssets(bytes, fileNameOf(file), baseDir);
  } catch (err) {
    console.error("[NoteMark] save image failed:", err);
    alert(`保存图片失败：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 把图片字节写入 assets 目录（粘贴、拖放、路径导入三条路共用）。
 * @returns 写进 markdown 的相对路径：文档整体挪走时 assets 一起走，图片仍可解析
 */
async function writeImageToAssets(
  bytes: Uint8Array,
  fileName: string,
  baseDir: string
): Promise<string> {
  const { join } = await import("@tauri-apps/api/path");
  const { mkdir, writeFile, exists } = await import("@tauri-apps/plugin-fs");
  const dir = await join(baseDir, ASSETS_DIR);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  const name = await uniqueName(dir, sanitizeName(fileName));
  await writeFile(await join(dir, name), bytes);
  return `${ASSETS_DIR}/${name}`;
}

/* ============ 文件名 ============ */

/** 剪贴板截图没有文件名，按时间戳生成；复制/拖入的图片文件沿用原名 */
function fileNameOf(file: File): string {
  const raw = (file.name ?? "").trim();
  if (raw && /\.[a-z0-9]{2,5}$/i.test(raw)) return sanitizeName(raw);
  return `image-${stamp()}.${extOf(file.type)}`;
}

/** MIME → 扩展名（未知统一按 png） */
function extOf(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "image/bmp") return "bmp";
  if (mime === "image/svg+xml") return "svg";
  return "png";
}

/** 去掉 Windows / Unix 通用的文件名非法字符 */
function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

/** yyyyMMdd-HHmmss */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 同名文件已存在时追加序号（-1、-2…），避免覆盖旧图 */
async function uniqueName(dir: string, name: string): Promise<string> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  if (!(await exists(await join(dir, name)))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 999; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!(await exists(await join(dir, candidate)))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** File → data URL（非 Tauri 环境的回退方案） */
function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
