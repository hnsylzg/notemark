const THEME_VARIABLES = [
  "--mt-color-fg",
  "--mt-color-fg-soft",
  "--mt-color-fg-muted",
  "--mt-color-bg",
  "--mt-color-bg-soft",
  "--mt-color-bg-elevated",
  "--mt-color-primary",
  "--mt-color-primary-soft",
  "--mt-color-border",
  "--mt-color-border-strong",
  "--mt-color-selection",
  "--mt-color-link",
  "--mt-font-sans",
  "--mt-font-mono",
  "--mt-font-size-base",
  "--mt-line-height-base",
  "--mt-content-width",
  "--mt-content-padding",
] as const;

/** Copy editor theme tokens to a viewport-level floating surface. */
export function inheritEditorTheme(element: HTMLElement): void {
  const source = document.querySelector<HTMLElement>(".milkdown");
  if (!source) return;
  const computed = getComputedStyle(source);

  for (const name of THEME_VARIABLES) {
    const value = computed.getPropertyValue(name);
    if (value) element.style.setProperty(name, value);
  }

  for (let index = 0; index < computed.length; index += 1) {
    const name = computed.item(index);
    if (!name.startsWith("--mt-")) continue;
    const value = computed.getPropertyValue(name);
    if (value) element.style.setProperty(name, value);
  }
}

/** Mount a menu outside editor and sidebar clipping containers. */
export function appendFloatingLayer(element: HTMLElement): void {
  inheritEditorTheme(element);
  document.body.appendChild(element);
}

/** Keep a fixed-position floating surface inside every viewport edge. */
export function clampFloatingLayer(
  element: HTMLElement,
  x: number,
  y: number,
  margin = 6
): { left: number; top: number } {
  element.style.left = "0px";
  element.style.top = "0px";
  const rect = element.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
  const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
  const left = Math.max(margin, Math.min(x, maxLeft));
  const top = Math.max(margin, Math.min(y, maxTop));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  return { left, top };
}
