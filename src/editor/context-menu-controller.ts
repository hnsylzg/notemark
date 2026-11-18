import {
  appendFloatingLayer,
  clampFloatingLayer,
} from "./floating-layer";

const DEFAULT_VIEWPORT_MARGIN = 6;

export interface ContextMenuHandle {
  close(): void;
}

interface PresentContextMenuOptions {
  menu: HTMLElement;
  clientX: number;
  clientY: number;
  margin?: number;
  onClose?: () => void;
}

/** 唯一的右键菜单呈现与生命周期控制器。 */
export function presentContextMenu({
  menu,
  clientX,
  clientY,
  margin = DEFAULT_VIEWPORT_MARGIN,
  onClose,
}: PresentContextMenuOptions): ContextMenuHandle {
  appendFloatingLayer(menu);
  clampFloatingLayer(menu, clientX, clientY, margin);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    menu.remove();
    onClose?.();
  };
  const onDown = (event: MouseEvent): void => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled]):not([hidden])'
      )
    ).filter((item) => !item.closest("[hidden]"));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(current + 1 + items.length) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(current - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      const active = document.activeElement;
      if (active instanceof HTMLElement && items.includes(active)) {
        event.preventDefault();
        active.click();
      }
    }
  };
  const onScroll = (): void => close();

  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);

  return { close };
}
