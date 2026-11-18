import { describe, expect, it } from "vitest";
import { decodeTextBytes } from "./textEncoding";

describe("decodeTextBytes", () => {
  it("decodes UTF-8 and strips a BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]);
    expect(decodeTextBytes(bytes)).toBe("中文");
  });

  it("falls back to GBK for Windows ANSI text", () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeTextBytes(bytes)).toBe("中文");
  });

  it("handles empty files", () => {
    expect(decodeTextBytes(new Uint8Array())).toBe("");
  });
});
