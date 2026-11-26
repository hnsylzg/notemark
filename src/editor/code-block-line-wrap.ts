import { stateGet, stateSet } from "./stateStore";

const CODE_BLOCK_LINE_WRAP_KEY = "codeBlockLineWrap";

export const DEFAULT_CODE_BLOCK_LINE_WRAP = false;

type CodeBlockLineWrapListener = (enabled: boolean) => void;

let currentValue = DEFAULT_CODE_BLOCK_LINE_WRAP;
const listeners = new Set<CodeBlockLineWrapListener>();

export function normalizeCodeBlockLineWrap(value: unknown): boolean {
  return typeof value === "boolean"
    ? value
    : DEFAULT_CODE_BLOCK_LINE_WRAP;
}

export function getCodeBlockLineWrap(): boolean {
  return currentValue;
}

export function applyCodeBlockLineWrap(enabled: boolean): void {
  const next = normalizeCodeBlockLineWrap(enabled);
  if (next === currentValue) return;
  currentValue = next;
  for (const listener of listeners) listener(next);
}

export function subscribeCodeBlockLineWrap(
  listener: CodeBlockLineWrapListener
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadCodeBlockLineWrap(): Promise<boolean> {
  try {
    return normalizeCodeBlockLineWrap(
      await stateGet<boolean>(CODE_BLOCK_LINE_WRAP_KEY)
    );
  } catch (error) {
    console.warn("[NoteMark] load code block line wrap failed:", error);
    return DEFAULT_CODE_BLOCK_LINE_WRAP;
  }
}

export async function saveCodeBlockLineWrap(
  enabled: boolean
): Promise<void> {
  await stateSet(
    CODE_BLOCK_LINE_WRAP_KEY,
    normalizeCodeBlockLineWrap(enabled)
  );
}
