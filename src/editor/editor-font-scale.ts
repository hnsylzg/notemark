import { stateGet, stateSet } from "./stateStore";

const EDITOR_FONT_SCALE_KEY = "editorFontScale";
const BODY_FONT_SIZE_PROPERTY = "--mt-font-size-base";
const CODE_FONT_SIZE_PROPERTY = "--mt-code-font-size";
const SOURCE_FONT_SIZE_PROPERTY = "--mt-source-font-size";
const DEFAULT_BODY_FONT_SIZE = "15px";
const DEFAULT_CODE_FONT_SIZE = "14px";

export const DEFAULT_EDITOR_FONT_SCALE = 1;
export const MIN_EDITOR_FONT_SCALE = 0.8;
export const MAX_EDITOR_FONT_SCALE = 1.4;
export const EDITOR_FONT_SCALE_STEP = 0.05;

export interface AppliedEditorFontSizes {
  body: string | null;
  code: string | null;
  source: string | null;
}

/** Normalize persisted/user values to a stable 5% step and safe range. */
export function normalizeEditorFontScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_EDITOR_FONT_SCALE;
  }
  const stepped =
    Math.round(value / EDITOR_FONT_SCALE_STEP) * EDITOR_FONT_SCALE_STEP;
  return Number(
    Math.min(
      MAX_EDITOR_FONT_SCALE,
      Math.max(MIN_EDITOR_FONT_SCALE, stepped)
    ).toFixed(2)
  );
}

export function formatEditorFontScale(scale: number): string {
  return `${Math.round(normalizeEditorFontScale(scale) * 100)}%`;
}

export function stepEditorFontScale(
  scale: number,
  direction: -1 | 1
): number {
  return normalizeEditorFontScale(
    normalizeEditorFontScale(scale) + direction * EDITOR_FONT_SCALE_STEP
  );
}

function scalePx(value: string, fallback: string, scale: number): string {
  const source = value.trim() || fallback;
  const match = /^(-?(?:\d+|\d*\.\d+))px$/i.exec(source);
  if (!match) {
    return `calc((${source}) * ${scale})`;
  }
  return `${Math.round(Number(match[1]) * scale * 2) / 2}px`;
}

/**
 * Apply the user scale above the active theme. Inline variables are cleared
 * first so the theme's own body/code sizes remain the source values.
 */
export function applyEditorFontScale(
  root: HTMLElement | null,
  scale: number
): AppliedEditorFontSizes {
  const normalized = normalizeEditorFontScale(scale);
  if (!root) return { body: null, code: null, source: null };

  root.style.removeProperty(BODY_FONT_SIZE_PROPERTY);
  root.style.removeProperty(CODE_FONT_SIZE_PROPERTY);
  if (normalized === DEFAULT_EDITOR_FONT_SCALE) {
    return { body: null, code: null, source: null };
  }

  const computed = getComputedStyle(root);
  const body = scalePx(
    computed.getPropertyValue(BODY_FONT_SIZE_PROPERTY),
    DEFAULT_BODY_FONT_SIZE,
    normalized
  );
  const code = scalePx(
    computed.getPropertyValue(CODE_FONT_SIZE_PROPERTY),
    DEFAULT_CODE_FONT_SIZE,
    normalized
  );
  const source = scalePx(
    DEFAULT_CODE_FONT_SIZE,
    DEFAULT_CODE_FONT_SIZE,
    normalized
  );

  root.style.setProperty(BODY_FONT_SIZE_PROPERTY, body);
  root.style.setProperty(CODE_FONT_SIZE_PROPERTY, code);
  return { body, code, source };
}

/** Apply the source-mode editor size to its host outside `.milkdown`. */
export function applySourceFontScale(
  root: HTMLElement | null,
  sourceSize: string | null
): void {
  if (!root) return;
  if (sourceSize) {
    root.style.setProperty(SOURCE_FONT_SIZE_PROPERTY, sourceSize);
  } else {
    root.style.removeProperty(SOURCE_FONT_SIZE_PROPERTY);
  }
}

export async function loadEditorFontScale(): Promise<number> {
  try {
    return normalizeEditorFontScale(
      await stateGet<number>(EDITOR_FONT_SCALE_KEY)
    );
  } catch (error) {
    console.warn("[NoteMark] load editor font scale failed:", error);
    return DEFAULT_EDITOR_FONT_SCALE;
  }
}

export async function saveEditorFontScale(scale: number): Promise<void> {
  await stateSet(EDITOR_FONT_SCALE_KEY, normalizeEditorFontScale(scale));
}
