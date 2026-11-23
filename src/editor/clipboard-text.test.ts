import { EditorState } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeClipboardCodeText,
  readClipboardText,
  writeClipboardText,
} from "./clipboard-text";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clipboard retry", () => {
  it("normalizes CRLF before calculating a CodeMirror paste caret", () => {
    const pasteText = normalizeClipboardCodeText(
      "first\r\nsecond\r\nthird\r\n"
    );
    const state = EditorState.create({ doc: "prefix" });
    const from = state.doc.length;
    const tr = state.update({
      changes: { from, insert: pasteText },
      selection: { anchor: from + pasteText.length },
    });

    expect(pasteText).toBe("first\nsecond\nthird");
    expect(tr.newDoc.toString()).toBe("prefixfirst\nsecond\nthird");
    expect(tr.newSelection.main.head).toBe(tr.newDoc.length);
  });

  it("retries a transient clipboard write failure", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("clipboard busy"))
      .mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
      userAgent: "",
    });

    await writeClipboardText("plain text");

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith("plain text");
  });

  it("retries when the clipboard initially reads as empty", async () => {
    const readText = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("copied text");
    vi.stubGlobal("navigator", {
      clipboard: { readText },
      userAgent: "",
    });

    await expect(readClipboardText()).resolves.toBe("copied text");
    expect(readText).toHaveBeenCalledTimes(2);
  });
});
