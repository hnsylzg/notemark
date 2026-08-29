/*
 * list-item.ts — 列表项 NodeView（list-item-block）与任务列表 SVG 复选框
 *
 * 背景：
 * - gfm 的任务列表只输出 <li data-item-type="task" data-checked>…</li> 结构，无任何样式；
 * - 本项目注册 @milkdown/kit/component/list-item-block（Vue NodeView），完全接管列表项渲染：
 *     <div class="milkdown-list-item-block">
 *       <li class="list-item">
 *         <div class="label-wrapper">图标</div>
 *         <div class="children">内容</div>
 *       </li>
 *     </div>
 * - 勾选框改用 SVG 图标（替换原 ::marker ☐/☑ 字符方案）：
 *   点击 label 由组件内部 onPointerdown → setNodeAttribute('checked') 自动切换，
 *   checked 属性经 gfm 序列化回 [x] / [ ]，markdown 往返无损。
 *
 * 图标说明：
 * - renderLabel 返回的字符串是 HTML，由组件内 DOMPurify sanitize 后 innerHTML 注入；
 * - 图标颜色不写死：fill/stroke 用 currentColor，随 .label-wrapper 的 color
 *   （主题变量 --mt-color-*，由 CSS 侧控制）；
 * - 已勾选图标的白色对勾固定 #fff（GitHub 同款做法，与主题色对比度最佳）。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import {
  listItemBlockComponent,
  type ListItemBlockConfig,
} from "@milkdown/kit/component/list-item-block";

/** 无序列表圆点（实心圆，currentColor） */
export const bulletIcon = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>`;

/** 已勾选复选框：主题色圆角方块 + 白色对勾 */
export const checkBoxCheckedIcon = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3.2" fill="currentColor"/><path d="m4.5 8.2 2.4 2.4 4.6-5" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** 未勾选复选框：空心圆角方块（currentColor 描边） */
export const checkBoxUncheckedIcon = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;

/**
 * 列表项 label 渲染：
 * - 普通无序列表 → 实心圆点图标
 * - 普通有序列表 → 数字文本（如 "1."，颜色/字重由 CSS 控制）
 * - 任务列表 → 勾选/未勾选 SVG 方块（点击切换由组件内置）
 */
export const renderListItemLabel: ListItemBlockConfig["renderLabel"] = ({
  label,
  listType,
  checked,
}) => {
  if (checked == null) {
    if (listType === "bullet") return bulletIcon;
    return label;
  }
  return checked ? checkBoxCheckedIcon : checkBoxUncheckedIcon;
};

/** 注册给 getEditorPlugins() 的插件集合 */
export const listItemPlugins: MilkdownPlugin[] = [...listItemBlockComponent];
