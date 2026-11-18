/**
 * Runtime file-scope grants and durable text writes.
 *
 * Tauri dialogs add the path the user selected to the plugin scopes, but
 * command-line files, drag/drop files, persisted workspaces and recovery
 * drafts do not pass through a dialog. The backend command below grants only
 * the exact document directory that the user explicitly opened.
 */
export async function grantPathAccess(
  path: string | null | undefined,
  includeParent = true
): Promise<void> {
  if (!path || !("__TAURI_INTERNALS__" in window)) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("grant_path_access", { path, includeParent });
}

/**
 * Write through the Rust command that:
 * - validates the target against the dynamic fs scope;
 * - writes and fsyncs a sibling temporary file;
 * - keeps one `.notemark-bak` copy of the previous file;
 * - replaces the target atomically (MoveFileExW on Windows).
 */
export async function writeTextFileAtomic(
  path: string,
  content: string
): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) {
    throw new Error("原子保存仅在 NoteMark 桌面端可用。");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("atomic_write_text", { path, content });
}

/** Atomically write binary or export data. Documents use the backup variant above. */
export async function writeBytesAtomic(
  path: string,
  data: Uint8Array,
  backup = false
): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) {
    throw new Error("原子保存仅在 NoteMark 桌面端可用。");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("atomic_write_file", {
    path,
    data: Array.from(data),
    backup,
  });
}

/** Open a local file/folder after backend authorization. */
export async function openAuthorizedPath(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_authorized_path", { path });
}

/** Reveal a local file/folder in the system file manager. */
export async function revealAuthorizedPath(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_authorized_path", { path });
}
