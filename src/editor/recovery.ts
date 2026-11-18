/**
 * Crash-safe draft persistence.
 *
 * Drafts are kept in NoteMark's SQLite state database rather than beside the
 * source document, so recovery never creates surprise files in a notes folder.
 * Each window uses its own row to avoid concurrent windows overwriting drafts.
 */
const BROWSER_PREFIX = "notemark:recovery:";
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface RecoveryDraft {
  path: string | null;
  name: string;
  content: string;
  savedAt: number;
}

function isRecoveryDraft(value: unknown): value is RecoveryDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<RecoveryDraft>;
  return (
    (draft.path === null || typeof draft.path === "string") &&
    typeof draft.name === "string" &&
    typeof draft.content === "string" &&
    typeof draft.savedAt === "number"
  );
}

export async function loadRecoveryDraft(
  scope: string
): Promise<RecoveryDraft | null> {
  try {
    if (!isTauri) {
      const text = localStorage.getItem(`${BROWSER_PREFIX}${scope}`);
      const value: unknown = text ? JSON.parse(text) : null;
      return isRecoveryDraft(value) ? value : null;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    const value = await invoke<unknown>("recovery_get", { windowId: scope });
    return isRecoveryDraft(value) ? value : null;
  } catch (err) {
    console.warn("[NoteMark] load recovery draft failed:", err);
    return null;
  }
}

export async function saveRecoveryDraft(
  scope: string,
  draft: RecoveryDraft
): Promise<void> {
  if (!isTauri) {
    localStorage.setItem(`${BROWSER_PREFIX}${scope}`, JSON.stringify(draft));
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("recovery_set", { windowId: scope, draft });
}

export async function clearRecoveryDraft(scope: string): Promise<void> {
  try {
    if (!isTauri) {
      localStorage.removeItem(`${BROWSER_PREFIX}${scope}`);
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("recovery_delete", { windowId: scope });
  } catch (err) {
    console.warn("[NoteMark] clear recovery draft failed:", err);
  }
}
