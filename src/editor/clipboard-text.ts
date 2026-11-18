const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Windows CF_UNICODETEXT requires CRLF between lines. */
const WINDOWS_CLIPBOARD_NEWLINE = "\r\n";

function usesWindowsClipboardLineEndings(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Windows/i.test(navigator.userAgent)
  );
}

export function normalizeClipboardPlainText(
  text: string,
  windows = usesWindowsClipboardLineEndings()
): string {
  return windows
    ? text.replace(/\r\n|\r|\n/g, WINDOWS_CLIPBOARD_NEWLINE)
    : text;
}

export async function writeClipboardText(text: string): Promise<void> {
  const clipboardText = normalizeClipboardPlainText(text);
  if (isTauri) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(clipboardText);
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(clipboardText);
      return;
    }
  } catch {
    // Fall through to the desktop clipboard plugin.
  }
  throw new Error("当前环境无法写入剪贴板");
}

export async function readClipboardText(): Promise<string> {
  if (isTauri) {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return readText();
  }
  if (navigator.clipboard?.readText) return navigator.clipboard.readText();
  throw new Error("当前环境无法读取剪贴板");
}
