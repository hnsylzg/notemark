/**
 * Text decoding shared by every Markdown entry point.
 *
 * Tauri's readTextFile always assumes UTF-8. Windows users still commonly
 * keep notes as ANSI/GBK, so decode strictly as UTF-8 first and fall back to
 * GBK only when the byte stream is not valid UTF-8.
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    try {
      return new TextDecoder("gbk", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
    }
  }
}
