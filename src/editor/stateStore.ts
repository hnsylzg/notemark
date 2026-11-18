/**
 * Versioned application-state persistence.
 *
 * Desktop state is owned by the Rust persistence service and stored in SQLite
 * with WAL + synchronous=FULL. Browser mode uses localStorage only for Vite
 * preview, keeping the same key/value API without affecting desktop behavior.
 */
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const BROWSER_PREFIX = "notemark:state:";

export async function stateGet<T>(key: string): Promise<T | null> {
  if (!isTauri) {
    const text = localStorage.getItem(`${BROWSER_PREFIX}${key}`);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T | null>("state_get", { key });
}

export async function stateSet<T>(key: string, value: T): Promise<void> {
  if (!isTauri) {
    localStorage.setItem(`${BROWSER_PREFIX}${key}`, JSON.stringify(value));
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("state_set", { key, value });
}

export async function stateDelete(key: string): Promise<void> {
  if (!isTauri) {
    localStorage.removeItem(`${BROWSER_PREFIX}${key}`);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("state_delete", { key });
}
