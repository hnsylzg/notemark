import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CODE_BLOCK_LINE_WRAP,
  applyCodeBlockLineWrap,
  getCodeBlockLineWrap,
  loadCodeBlockLineWrap,
  normalizeCodeBlockLineWrap,
  saveCodeBlockLineWrap,
  subscribeCodeBlockLineWrap,
} from "./code-block-line-wrap";

afterEach(() => {
  applyCodeBlockLineWrap(DEFAULT_CODE_BLOCK_LINE_WRAP);
  localStorage.removeItem("notemark:state:codeBlockLineWrap");
});

describe("code block line wrap", () => {
  it("accepts boolean values and preserves the current default", () => {
    expect(normalizeCodeBlockLineWrap(true)).toBe(true);
    expect(normalizeCodeBlockLineWrap(false)).toBe(false);
    expect(normalizeCodeBlockLineWrap("true")).toBe(
      DEFAULT_CODE_BLOCK_LINE_WRAP
    );
    expect(normalizeCodeBlockLineWrap(null)).toBe(
      DEFAULT_CODE_BLOCK_LINE_WRAP
    );
  });

  it("notifies subscribers only when the value changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCodeBlockLineWrap(listener);

    applyCodeBlockLineWrap(true);
    applyCodeBlockLineWrap(true);
    applyCodeBlockLineWrap(false);
    unsubscribe();
    applyCodeBlockLineWrap(true);

    expect(listener.mock.calls).toEqual([[true], [false]]);
    expect(getCodeBlockLineWrap()).toBe(true);
  });

  it("persists the selected value", async () => {
    await saveCodeBlockLineWrap(true);
    expect(await loadCodeBlockLineWrap()).toBe(true);

    await saveCodeBlockLineWrap(false);
    expect(await loadCodeBlockLineWrap()).toBe(false);
  });
});
