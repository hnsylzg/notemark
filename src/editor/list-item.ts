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
 * - 已勾选图标保留 currentColor 圆角外框，并用 currentColor 填充框内、
 *   绘制白色对勾，保证与各主题的主色都有足够对比度。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";
import {
  listItemBlockComponent,
  type ListItemBlockConfig,
} from "@milkdown/kit/component/list-item-block";

/** 无序列表圆点（实心圆，currentColor） */
export const bulletIcon = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>`;

/** 已勾选复选框：外框和填充跟随主题，对勾颜色可由主题变量覆盖 */
export const checkBoxCheckedIcon = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3.2" fill="currentColor" stroke="currentColor" stroke-width="1.5"/><path d="m4.5 8.2 2.4 2.4 4.6-5" fill="none" stroke="var(--mt-task-check-fg, #fff)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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

const TASK_WRAPPER_SELECTOR = '[data-task-checkbox="true"]';

export function syncTaskCheckboxA11y(root: HTMLElement): void {
  for (const wrapper of root.querySelectorAll<HTMLElement>(TASK_WRAPPER_SELECTOR)) {
    const label = wrapper.querySelector<HTMLElement>(
      ".label.checked, .label.unchecked"
    );
    if (!label) {
      wrapper.removeAttribute("role");
      wrapper.removeAttribute("aria-checked");
      wrapper.removeAttribute("aria-label");
      wrapper.removeAttribute("tabindex");
      delete wrapper.dataset.taskCheckbox;
      continue;
    }
    const checked = label.classList.contains("checked");
    wrapper.setAttribute("role", "checkbox");
    wrapper.setAttribute("aria-checked", String(checked));
    wrapper.setAttribute("aria-label", "任务完成状态");
    wrapper.tabIndex = 0;
  }

  for (const wrapper of root.querySelectorAll<HTMLElement>(
    ".milkdown-list-item-block .label-wrapper"
  )) {
    const label = wrapper.querySelector<HTMLElement>(
      ".label.checked, .label.unchecked"
    );
    if (!label) continue;
    wrapper.dataset.taskCheckbox = "true";
    wrapper.setAttribute("role", "checkbox");
    wrapper.setAttribute("aria-checked", String(label.classList.contains("checked")));
    wrapper.setAttribute("aria-label", "任务完成状态");
    wrapper.tabIndex = 0;
  }
}

/** 为第三方列表项 NodeView 补原生复选框的 ARIA 与 Space 键操作。 */
const taskCheckboxA11yPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          keydown(view, event) {
            if (event.key !== " " && event.key !== "Spacebar") return false;
            const target = event.target as Element | null;
            const wrapper = target?.closest<HTMLElement>(TASK_WRAPPER_SELECTOR);
            if (!wrapper) return false;

            const label = wrapper.querySelector<HTMLElement>(
              ".label.checked, .label.unchecked"
            );
            const item = wrapper.closest<HTMLElement>(
              ".milkdown-list-item-block"
            );
            if (!label || !item) return false;

            const pos = view.posAtDOM(item, 0);
            if (pos < 0 || pos > view.state.doc.content.size) return false;
            event.preventDefault();
            event.stopPropagation();
            view.dispatch(
              view.state.tr.setNodeAttribute(
                pos,
                "checked",
                !label.classList.contains("checked")
              )
            );
            return true;
          },
        },
      },
      view(view) {
        let frame = 0;
        const sync = () => {
          frame = 0;
          if (!view.isDestroyed) syncTaskCheckboxA11y(view.dom);
        };
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(sync);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(view.dom, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class"],
        });
        sync();
        return {
          update: schedule,
          destroy: () => {
            observer.disconnect();
            if (frame) cancelAnimationFrame(frame);
          },
        };
      },
    })
);

/** 注册给 getEditorPlugins() 的插件集合 */
export const listItemPlugins: MilkdownPlugin[] = [
  ...listItemBlockComponent,
  taskCheckboxA11yPlugin,
];
