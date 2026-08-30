/*
 * image-drop.ts — 拖拽插入图片（仅浏览器调试环境）
 *
 * Tauri 下本插件会让位：原生 DragDrop 事件接管拖放
 * （src-tauri/src/lib.rs 把「真实路径 + 落点坐标」转发给前端，
 * App.vue 的 handleFileDrop 再分流成「打开文档 / 插入图片」）。
 * 原因是 HTML5 的 File 对象拿不到磁盘真实路径，拖入的 .md 无法打开。
 * 保留本插件是为了纯浏览器调试时依然能拖图插入。
 *
 * 与粘贴共用 image-files.ts 的保存逻辑，唯一区别是插入位置怎么定：
 * 粘贴用光标，拖放用鼠标落点（posAtCoords），符合「拖到哪插到哪」的直觉。
 *
 * ★ 为什么用 handleDOMEvents.drop，而不是 ProseMirror 的 handleDrop：
 * handleDrop 只在「dataTransfer 能解析出 Slice」时才被调用。
 * 从文件管理器拖图片进来时，dataTransfer 里只有 files，没有 text/html
 * 也没有 text/plain，parseFromClipboard 返回空，handleDrop 压根不会触发。
 * handleDOMEvents 是原生事件钩子，先于 PM 内部逻辑执行，不受这个限制。
 *
 * ★ 为什么还要处理 dragover：
 * 浏览器只在 dragover 被 preventDefault 后才派发 drop。
 * ProseMirror 不监听 dragover（源码里没有任何 dragover 注册），
 * 于是拖外部文件进来时默认行为生效，drop 事件压根不触发。
 * 只对图片文件放行，其余（拖文本、内部拖拽）交回默认。
 *
 * 用「有没有文件」来区分内外，而不是 handleDrop 的 moved 参数：
 * - 编辑器内部拖拽（挪动已有文字/图片）时，PM 写入 dataTransfer 的是
 *   序列化内容，files 为空 → 本插件返回 false，交回 PM 默认处理；
 * - 外部拖入文件时 files 非空 → 接管。
 * 这样内部移动、外部拖文本/网页链接都不会被误伤。
 */
import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import { importImages } from "./image-files";

/** 是否处于 Tauri 环境（Tauri 下由原生拖放事件接管，本插件让位） */
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** dataTransfer 里是否含图片文件（dragover 阶段只能读 items，读不到 files） */
function hasImageFile(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.items ?? []).some(
    (item) => item.kind === "file" && item.type.startsWith("image/")
  );
}

export const imageDropPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          dragover(_view, event) {
            if (isTauri) return false;
            if (!hasImageFile((event as DragEvent).dataTransfer)) return false;
            event.preventDefault();
            return true;
          },

          drop(view, event) {
            if (isTauri) return false;
            const dragEvent = event as DragEvent;
            const files = Array.from(
              dragEvent.dataTransfer?.files ?? []
            ).filter((f) => f.type.startsWith("image/"));
            // 无图片文件：内部拖拽移动、拖入文本或网页链接，都交回默认
            if (files.length === 0) return false;
            // 落点必须在编辑区内；拖到工具栏等区域时不处理
            const coords = view.posAtCoords({
              left: dragEvent.clientX,
              top: dragEvent.clientY,
            });
            if (!coords) return false;
            dragEvent.preventDefault();
            importImages(view, files, coords.pos);
            return true;
          },
        },
      },
    })
);
