import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readClipboardText,
  writeClipboardText,
} from "./clipboard-text";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clipboard retry", () => {
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
