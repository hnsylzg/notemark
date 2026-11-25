import { stateGet, stateSet } from "./stateStore";

const EDITOR_CONTENT_WIDTH_KEY = "editorContentWidth";
const CONTENT_WIDTH_ATTRIBUTE = "data-content-width";

export type EditorContentWidthMode = "standard" | "adaptive" | "full";

export const DEFAULT_EDITOR_CONTENT_WIDTH: EditorContentWidthMode = "standard";

export function normalizeEditorContentWidth(
  value: unknown
): EditorContentWidthMode {
  return value === "adaptive" || value === "full"
    ? value
    : DEFAULT_EDITOR_CONTENT_WIDTH;
}

export function applyEditorContentWidth(
  root: HTMLElement | null,
  mode: EditorContentWidthMode
): void {
  if (!root) return;
  root.setAttribute(CONTENT_WIDTH_ATTRIBUTE, normalizeEditorContentWidth(mode));
}

export async function loadEditorContentWidth(): Promise<EditorContentWidthMode> {
  try {
    return normalizeEditorContentWidth(
      await stateGet<EditorContentWidthMode>(EDITOR_CONTENT_WIDTH_KEY)
    );
  } catch (error) {
    console.warn("[NoteMark] load editor content width failed:", error);
    return DEFAULT_EDITOR_CONTENT_WIDTH;
  }
}

export async function saveEditorContentWidth(
  mode: EditorContentWidthMode
): Promise<void> {
  await stateSet(
    EDITOR_CONTENT_WIDTH_KEY,
    normalizeEditorContentWidth(mode)
  );
}
