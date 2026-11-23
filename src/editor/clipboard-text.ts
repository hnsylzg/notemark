const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Windows CF_UNICODETEXT requires CRLF between lines. */
const WINDOWS_CLIPBOARD_NEWLINE = "\r\n";
/** Windows 剪贴板可能被其他进程短暂占用，首尾共重试约 80ms。 */
const CLIPBOARD_RETRY_DELAYS_MS = [0, 20, 60] as const;

function usesWindowsClipboardLineEndings(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Windows/i.test(navigator.userAgent)
  );
}

function wait(delay: number): Promise<void> {
  return delay > 0
    ? new Promise((resolve) => setTimeout(resolve, delay))
    : Promise.resolve();
}

async function retryClipboardWrite(
  writeText: (text: string) => Promise<void>,
  text: string
): Promise<void> {
  let lastError: unknown;
  for (const delay of CLIPBOARD_RETRY_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    try {
      await writeText(text);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function retryClipboardRead(
  readText: () => Promise<string>
): Promise<string> {
  let lastError: unknown;
  for (const delay of CLIPBOARD_RETRY_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    try {
      const text = await readText();
      // 插件偶尔会在剪贴板刚切换所有者时返回空串，稍后重试。
      if (text) return text;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return "";
}

export function normalizeClipboardPlainText(
  text: string,
  windows = usesWindowsClipboardLineEndings()
): string {
  return windows
    ? text.replace(/\r\n|\r|\n/g, WINDOWS_CLIPBOARD_NEWLINE)
    : text;
}

/** CodeMirror counts every line break as one position; CRLF must be normalized before inserting. */
export function normalizeClipboardCodeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

export async function writeClipboardText(text: string): Promise<void> {
  const clipboardText = normalizeClipboardPlainText(text);
  let pluginError: unknown;
  if (isTauri) {
    try {
      const { writeText } = await import(
        "@tauri-apps/plugin-clipboard-manager"
      );
      await retryClipboardWrite(writeText, clipboardText);
      return;
    } catch (error) {
      pluginError = error;
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await retryClipboardWrite(
        (value) => navigator.clipboard.writeText(value),
        clipboardText
      );
      return;
    } catch (error) {
      pluginError ??= error;
    }
  }
  if (pluginError) throw pluginError;
  throw new Error("当前环境无法写入剪贴板");
}

export async function readClipboardText(): Promise<string> {
  let pluginError: unknown;
  if (isTauri) {
    try {
      const { readText } = await import(
        "@tauri-apps/plugin-clipboard-manager"
      );
      return await retryClipboardRead(readText);
    } catch (error) {
      pluginError = error;
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      return await retryClipboardRead(() => navigator.clipboard.readText());
    } catch (error) {
      pluginError ??= error;
    }
  }
  if (pluginError) throw pluginError;
  throw new Error("当前环境无法读取剪贴板");
}
