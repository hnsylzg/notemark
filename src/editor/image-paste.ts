/*
 * image-paste.ts — 粘贴图片
 *
 * 只负责「决定要不要接管这次粘贴、插在哪」，
 * 保存与插入的公共逻辑在 image-files.ts。
 *
 * 关键取舍：只在「纯图片粘贴」时接管。
 * 网页复制、Word 图文混排会同时带 text/html 或 text/plain，
 * 那种情况交给 Milkdown 默认解析 —— 为了几张图丢掉整段文字不值得。
 */
import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import { importImages } from "./image-files";

export const imagePastePlugin = $prose(
  () =>
    new Plugin({
      props: {
        handlePaste(view, event) {
          const files = pickImageFiles(event.clipboardData);
          if (files.length === 0) return false; // 非图片粘贴，走默认流程
          event.preventDefault();
          // 保存是异步的，不能让 handlePaste 变成 async（PM 要求同步返回）
          importImages(view, files, view.state.selection.from);
          return true;
        },
      },
    })
);

/**
 * 取出剪贴板里的图片文件。
 * 剪贴板同时含 text/html 或 text/plain 时返回空数组，交还给默认流程。
 */
function pickImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.getData("text/html") || data.getData("text/plain")) return [];
  return Array.from(data.files ?? []).filter((f) => f.type.startsWith("image/"));
}
