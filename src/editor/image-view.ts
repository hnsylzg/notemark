/*
 * image-view.ts — 图片相对路径解析
 *
 * 背景：Tauri 环境下，markdown 中的相对路径图片（![alt](img/logo.png)）
 * 默认按 WebView 页面 URL（应用资源）解析，而不是用户文件所在目录，
 * 导致图片 404 裂图。
 *
 * 这里覆盖 image 节点渲染：
 * - 相对路径基于“当前打开的 markdown 文件所在目录”拼成绝对路径，
 *   再经 convertFileSrc 转为可加载的 asset URL；
 * - 兼容 Windows 反斜杠路径（img\logo.png → img/logo.png）；
 * - 序列化仍输出原始相对路径，导入导出往返无损。
 */
import { $view, type $Node } from "@milkdown/kit/utils";
import { imageSchema } from "@milkdown/kit/preset/commonmark";
import { convertFileSrc } from "@tauri-apps/api/core";

/** 当前 markdown 文件所在目录（末尾带分隔符），空表示未知 */
let imageBaseDir = "";

/**
 * 由 App.vue 在打开/保存文件后调用，更新图片解析基准目录。
 * 新建未命名文件时传入 null 清空基准。
 * 基准目录变化后，会重新解析文档中已渲染的图片，
 * 兜底处理“先渲染后设置基准”的时序场景。
 */
export function setImageBaseDir(filePath: string | null): void {
  if (!filePath) {
    imageBaseDir = "";
  } else {
    const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    imageBaseDir = idx >= 0 ? filePath.slice(0, idx + 1) : "";
  }
  refreshRenderedImages();
}

/** 重新解析文档中所有已渲染图片的 src（用各自保存的原始 src） */
function refreshRenderedImages(): void {
  const imgs = document.querySelectorAll<HTMLImageElement>("img[data-md-src]");
  imgs.forEach((img) => {
    img.src = resolveImageSrc(img.dataset.mdSrc ?? "");
  });
}

/** 把 markdown 中的图片 src 解析为可加载 URL */
export function resolveImageSrc(src: string): string {
  // 完整 URL / data / blob：原样返回
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  // 根路径或未知基准：保持原样
  if (src.startsWith("/") || !imageBaseDir) return src;
  // Windows 反斜杠路径转正斜杠后，基于文件目录拼绝对路径
  const rel = src.replace(/\\/g, "/");
  const abs = imageBaseDir + rel;
  try {
    return convertFileSrc(abs);
  } catch {
    // 非 Tauri 环境（纯浏览器调试）回退为绝对路径
    return abs;
  }
}

export const imageView = $view(
  imageSchema.node as unknown as $Node,
  () => (node) => {
    const img = document.createElement("img");
    const render = (attrs: Record<string, unknown>): void => {
      const raw = String(attrs.src ?? "");
      // 保存原始 src，供基准目录变化后重新解析
      img.dataset.mdSrc = raw;
      img.src = resolveImageSrc(raw);
      img.alt = String(attrs.alt ?? "");
      if (attrs.title) img.title = String(attrs.title);
      else img.removeAttribute("title");
    };
    render(node.attrs);
    return {
      dom: img,
      update: (newNode) => {
        if (newNode.type !== node.type) return false;
        render(newNode.attrs);
        return true;
      },
    };
  }
);
