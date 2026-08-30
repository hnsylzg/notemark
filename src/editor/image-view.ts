/*
 * image-view.ts — 图片相对路径解析 + 图片拖拽移动
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
 *
 * 为什么在这里实现「图片拖拽移动」而不是依赖 ProseMirror 内置拖拽：
 * Tauri 在 Windows 上开启原生文件拖放（dragDropEnabled=true）后，会劫持
 * 整个窗口的 HTML5 拖放（dragover / drop 不再派发，见 tauri issue #15138），
 * 编辑器内部的图片拖拽因此失效。这里用 mousedown / mousemove / mouseup
 * 自己模拟：按住图片拖出 ghost，松手后把图片节点从原位置搬到落点。
 * 它与原生文件拖放（拖 .md 打开、拖图片插入）互不干扰。
 */
import { $view, type $Node } from "@milkdown/kit/utils";
import { imageSchema } from "@milkdown/kit/preset/commonmark";
import type { EditorView } from "@milkdown/prose/view";
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

/**
 * 读取当前图片基准目录（末尾带分隔符；空表示未知）。
 * 粘贴图片等「需要往文档所在目录写文件」的场景复用这个目录，
 * 保证写入位置与解析位置始终一致。
 */
export function getImageBaseDir(): string {
  return imageBaseDir;
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

/* ============ 鼠标模拟图片拖拽 ============ */

/** 移动超过该像素数才视为拖拽（否则是一次普通点击，用于选中图片） */
const DRAG_THRESHOLD = 5;

/**
 * 按下图片时启动拖拽跟踪：
 * - 移动超过阈值 → 生成半透明 ghost 跟随鼠标，同时实时计算落点位置；
 * - 松手时若确实拖拽过 → 把图片节点搬到落点。
 * 监听挂在 window 上（捕获阶段），鼠标离开图片范围也能继续跟踪。
 */
function startImageDrag(view: EditorView, img: HTMLElement, start: MouseEvent): void {
  const from = view.posAtDOM(img, 0);
  const s: {
    moved: boolean;
    startX: number;
    startY: number;
    ghost: HTMLElement | null;
    dropPos: number;
  } = { moved: false, startX: start.clientX, startY: start.clientY, ghost: null, dropPos: -1 };

  const onMove = (e: MouseEvent): void => {
    if (!s.moved) {
      const dist = Math.hypot(e.clientX - s.startX, e.clientY - s.startY);
      if (dist < DRAG_THRESHOLD) return;
      s.moved = true;
      const ghost = img.cloneNode(true) as HTMLElement;
      Object.assign(ghost.style, {
        position: "fixed",
        pointerEvents: "none",
        opacity: "0.6",
        zIndex: "9999",
        maxWidth: "240px",
        maxHeight: "160px",
        left: "0px",
        top: "0px",
        margin: "0px",
      });
      document.body.appendChild(ghost);
      s.ghost = ghost;
      img.style.opacity = "0.35";
    }
    if (s.ghost) {
      s.ghost.style.left = `${e.clientX + 12}px`;
      s.ghost.style.top = `${e.clientY + 12}px`;
    }
    const coords = view.posAtCoords({ left: e.clientX, top: e.clientY });
    s.dropPos = coords ? coords.pos : -1;
  };

  const onUp = (e: MouseEvent): void => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    s.ghost?.remove();
    img.style.opacity = "";
    if (s.moved) {
      moveImageNode(view, from, s.dropPos);
      // 阻止 ProseMirror 把这次松手当普通点击（避免刚搬完又被选中/移动光标）
      e.preventDefault();
      e.stopPropagation();
    }
  };

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
}

/** 把 from 处的图片节点移动到 to 位置（to 为鼠标落点对应的文档位置） */
function moveImageNode(view: EditorView, from: number, to: number): void {
  if (to < 0 || Math.abs(to - from) <= 1) return; // 落在编辑区外 / 原地，忽略
  const doc = view.state.doc;
  const $from = doc.resolve(from);
  const node = $from.nodeAfter;
  if (!node || node.type.name !== "image") return;
  const size = node.nodeSize;
  // 删除自身后再插入：落点在原图之后的要减去被删掉的节点长度
  let insertAt = to > from ? to - size : to;
  insertAt = Math.max(0, Math.min(insertAt, doc.content.size - size));
  if (Math.abs(insertAt - from) <= 1) return; // 算下来还在原地
  const tr = view.state.tr;
  tr.delete(from, from + size);
  tr.insert(insertAt, node);
  view.dispatch(tr);
  view.focus();
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
    // 关掉浏览器对 img 的原生拖拽：HTML5 拖放在 Tauri 原生拖放下不可用，
    // 且会与下面的鼠标模拟拖拽打架（双重拖拽）。文字选区的拖拽不受影响。
    img.draggable = false;
    return {
      dom: img,
      handleDOMEvents: {
        mousedown: (view: EditorView, event: Event) => {
          const e = event as MouseEvent;
          if (e.button !== 0) return false;
          // 阻止浏览器把图片当拖拽源（原生图片拖拽在 Tauri 下不可用且会打架），
          // 但仍返回 false 让 ProseMirror 处理点击选中。
          e.preventDefault();
          startImageDrag(view, img, e);
          return false;
        },
      },
      update: (newNode) => {
        if (newNode.type !== node.type) return false;
        render(newNode.attrs);
        return true;
      },
    };
  }
);
