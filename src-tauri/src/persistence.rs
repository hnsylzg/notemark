use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const SCHEMA_VERSION: i64 = 1;
const RECOVERY_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_MAX_DRAFTS: i64 = 20;
const RECOVERY_MAX_CONTENT_BYTES: usize = 32 * 1024 * 1024;
const AUTHORIZED_PATHS_MAX: i64 = 500;

pub struct PersistenceDb {
  connection: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraft {
  path: Option<String>,
  name: String,
  content: String,
  saved_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
  pub x: i32,
  pub y: i32,
  pub width: u32,
  pub height: u32,
  pub maximized: bool,
}

impl PersistenceDb {
  pub fn open(app: &AppHandle) -> Result<Self, String> {
    let dir = app
      .path()
      .app_data_dir()
      .map_err(|e| e.to_string())?
      .join("state");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let connection = Connection::open(dir.join("notemark.sqlite3")).map_err(|e| e.to_string())?;
    connection
      .busy_timeout(std::time::Duration::from_secs(5))
      .map_err(|e| e.to_string())?;
    connection
      .execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recovery_drafts (
          window_id TEXT PRIMARY KEY,
          path TEXT,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS authorized_paths (
          path TEXT PRIMARY KEY COLLATE NOCASE,
          authorized_at INTEGER NOT NULL
        );
        ",
      )
      .map_err(|e| e.to_string())?;
    connection
      .pragma_update(None, "user_version", SCHEMA_VERSION)
      .map_err(|e| e.to_string())?;
    let db = Self {
      connection: Mutex::new(connection),
    };
    if let Err(error) = db.migrate_legacy_json(app) {
      log::warn!("[NoteMark] legacy persistence migration failed: {error}");
    }
    db.cleanup()?;
    Ok(db)
  }

  fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    self
      .connection
      .lock()
      .map_err(|_| "持久化数据库锁已损坏".to_string())
  }

  fn cleanup(&self) -> Result<(), String> {
    let cutoff = now_ms() - RECOVERY_TTL_MS;
    let connection = self.connection()?;
    connection
      .execute(
        "DELETE FROM recovery_drafts WHERE updated_at < ?1",
        [cutoff],
      )
      .map_err(|e| e.to_string())?;
    connection
      .execute(
        "
        DELETE FROM recovery_drafts
        WHERE window_id NOT IN (
          SELECT window_id FROM recovery_drafts
          ORDER BY updated_at DESC LIMIT ?1
        )
        ",
        [RECOVERY_MAX_DRAFTS],
      )
      .map_err(|e| e.to_string())?;
    connection
      .execute(
        "
        DELETE FROM app_state
        WHERE key LIKE 'windowState:%'
          AND key NOT IN (
            SELECT key FROM app_state
            WHERE key LIKE 'windowState:%'
            ORDER BY updated_at DESC LIMIT 20
          )
        ",
        [],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  }

  fn migrate_legacy_json(&self, app: &AppHandle) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Err(error) = self.migrate_settings(&app_data.join("settings.json")) {
      log::warn!("[NoteMark] migrate settings.json failed: {error}");
    }
    if let Err(error) = self.migrate_recovery(&app_data.join("recovery.json")) {
      log::warn!("[NoteMark] migrate recovery.json failed: {error}");
    }
    if let Err(error) =
      self.migrate_authorized_paths(&app_data.join("permissions").join("authorized-paths.json"))
    {
      log::warn!("[NoteMark] migrate authorized-paths.json failed: {error}");
    }
    if let Err(error) = self.migrate_window_state(&app_data.join(".window-state.json")) {
      log::warn!("[NoteMark] migrate .window-state.json failed: {error}");
    }
    Ok(())
  }

  fn migrate_settings(&self, file: &Path) -> Result<(), String> {
    let Some(values) = read_json_object(file)? else {
      return Ok(());
    };
    let mut connection = self.connection()?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    for (key, value) in values {
      tx.execute(
        "INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?3)",
        params![key, value.to_string(), now],
      )
      .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    archive_migrated_file(file);
    Ok(())
  }

  fn migrate_recovery(&self, file: &Path) -> Result<(), String> {
    let Some(values) = read_json_object(file)? else {
      return Ok(());
    };
    let mut connection = self.connection()?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    for (key, value) in values {
      let Some(window_id) = key.strip_prefix("draft:") else {
        continue;
      };
      let Ok(draft) = serde_json::from_value::<RecoveryDraft>(value) else {
        continue;
      };
      tx.execute(
        "
        INSERT OR IGNORE INTO recovery_drafts (window_id, path, name, content, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ",
        params![
          window_id,
          draft.path,
          draft.name,
          draft.content,
          draft.saved_at
        ],
      )
      .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    archive_migrated_file(file);
    Ok(())
  }

  fn migrate_authorized_paths(&self, file: &Path) -> Result<(), String> {
    let Some(paths) = read_json_array(file)? else {
      return Ok(());
    };
    let mut connection = self.connection()?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    for path in paths {
      if let Some(path) = path.as_str() {
        tx.execute(
          "INSERT OR IGNORE INTO authorized_paths (path, authorized_at) VALUES (?1, ?2)",
          params![path, now],
        )
        .map_err(|e| e.to_string())?;
      }
    }
    tx.commit().map_err(|e| e.to_string())?;
    archive_migrated_file(file);
    Ok(())
  }

  fn migrate_window_state(&self, file: &Path) -> Result<(), String> {
    let Some(values) = read_json_object(file)? else {
      return Ok(());
    };
    let mut connection = self.connection()?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    let now = now_ms();
    for (label, value) in values {
      let Ok(state) = serde_json::from_value::<WindowState>(value) else {
        continue;
      };
      tx.execute(
        "INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?3)",
        params![
          format!("windowState:{label}"),
          serde_json::to_string(&state).map_err(|e| e.to_string())?,
          now
        ],
      )
      .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    archive_migrated_file(file);
    Ok(())
  }

  pub fn state_get(&self, key: &str) -> Result<Option<Value>, String> {
    let connection = self.connection()?;
    let value: Option<String> = connection
      .query_row("SELECT value FROM app_state WHERE key = ?1", [key], |row| {
        row.get(0)
      })
      .optional()
      .map_err(|e| e.to_string())?;
    value
      .map(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
      .transpose()
  }

  pub fn state_set(&self, key: &str, value: Value) -> Result<(), String> {
    let connection = self.connection()?;
    connection
      .execute(
        "
        INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        ",
        params![key, value.to_string(), now_ms()],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  }

  pub fn state_delete(&self, key: &str) -> Result<(), String> {
    let connection = self.connection()?;
    connection
      .execute("DELETE FROM app_state WHERE key = ?1", [key])
      .map_err(|e| e.to_string())?;
    Ok(())
  }

  pub fn recovery_get(&self, window_id: &str) -> Result<Option<RecoveryDraft>, String> {
    let connection = self.connection()?;
    connection
      .query_row(
        "
        SELECT path, name, content, updated_at
        FROM recovery_drafts WHERE window_id = ?1
        ",
        [window_id],
        |row| {
          Ok(RecoveryDraft {
            path: row.get(0)?,
            name: row.get(1)?,
            content: row.get(2)?,
            saved_at: row.get(3)?,
          })
        },
      )
      .optional()
      .map_err(|e| e.to_string())
  }

  pub fn recovery_set(&self, window_id: &str, draft: RecoveryDraft) -> Result<(), String> {
    if draft.content.len() > RECOVERY_MAX_CONTENT_BYTES {
      return Err("恢复草稿超过 32 MB 上限".to_string());
    }
    let mut connection = self.connection()?;
    let tx = connection.transaction().map_err(|e| e.to_string())?;
    tx.execute(
      "
      INSERT INTO recovery_drafts (window_id, path, name, content, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(window_id) DO UPDATE SET
        path = excluded.path,
        name = excluded.name,
        content = excluded.content,
        updated_at = excluded.updated_at
      ",
      params![
        window_id,
        draft.path,
        draft.name,
        draft.content,
        draft.saved_at
      ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
      "
      DELETE FROM recovery_drafts
      WHERE window_id NOT IN (
        SELECT window_id FROM recovery_drafts
        ORDER BY updated_at DESC LIMIT ?1
      )
      ",
      [RECOVERY_MAX_DRAFTS],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
  }

  pub fn recovery_delete(&self, window_id: &str) -> Result<(), String> {
    let connection = self.connection()?;
    connection
      .execute(
        "DELETE FROM recovery_drafts WHERE window_id = ?1",
        [window_id],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  }

  pub fn window_state_get(&self, label: &str) -> Result<Option<WindowState>, String> {
    let value = self.state_get(&format!("windowState:{label}"))?;
    value
      .map(|value| serde_json::from_value(value).map_err(|e| e.to_string()))
      .transpose()
  }

  pub fn window_state_set(&self, label: &str, state: WindowState) -> Result<(), String> {
    self.state_set(
      &format!("windowState:{label}"),
      serde_json::to_value(state).map_err(|e| e.to_string())?,
    )
  }

  pub fn remember_authorized_path(&self, path: &Path) -> Result<(), String> {
    let connection = self.connection()?;
    connection
      .execute(
        "
        INSERT INTO authorized_paths (path, authorized_at) VALUES (?1, ?2)
        ON CONFLICT(path) DO UPDATE SET authorized_at = excluded.authorized_at
        ",
        params![path.to_string_lossy(), now_ms()],
      )
      .map_err(|e| e.to_string())?;
    connection
      .execute(
        "
        DELETE FROM authorized_paths WHERE path NOT IN (
          SELECT path FROM authorized_paths
          ORDER BY authorized_at DESC LIMIT ?1
        )
        ",
        [AUTHORIZED_PATHS_MAX],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  }

  pub fn authorized_paths(&self) -> Result<Vec<String>, String> {
    let connection = self.connection()?;
    let mut stmt = connection
      .prepare(
        "
        SELECT path FROM authorized_paths
        ORDER BY authorized_at DESC LIMIT ?1
        ",
      )
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([AUTHORIZED_PATHS_MAX], |row| row.get::<_, String>(0))
      .map_err(|e| e.to_string())?;
    rows
      .collect::<Result<Vec<_>, _>>()
      .map_err(|e| e.to_string())
  }
}

#[tauri::command]
pub async fn state_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
  db_call(app, move |db| db.state_get(&key)).await
}

#[tauri::command]
pub async fn state_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
  db_call(app, move |db| db.state_set(&key, value)).await
}

#[tauri::command]
pub async fn state_delete(app: AppHandle, key: String) -> Result<(), String> {
  db_call(app, move |db| db.state_delete(&key)).await
}

#[tauri::command]
pub async fn recovery_get(
  app: AppHandle,
  window_id: String,
) -> Result<Option<RecoveryDraft>, String> {
  db_call(app, move |db| db.recovery_get(&window_id)).await
}

#[tauri::command]
pub async fn recovery_set(
  app: AppHandle,
  window_id: String,
  draft: RecoveryDraft,
) -> Result<(), String> {
  db_call(app, move |db| db.recovery_set(&window_id, draft)).await
}

#[tauri::command]
pub async fn recovery_delete(app: AppHandle, window_id: String) -> Result<(), String> {
  db_call(app, move |db| db.recovery_delete(&window_id)).await
}

async fn db_call<T, F>(app: AppHandle, operation: F) -> Result<T, String>
where
  T: Send + 'static,
  F: FnOnce(&PersistenceDb) -> Result<T, String> + Send + 'static,
{
  tauri::async_runtime::spawn_blocking(move || {
    let db = app.state::<PersistenceDb>();
    operation(db.inner())
  })
  .await
  .map_err(|error| format!("持久化任务失败: {error}"))?
}

fn now_ms() -> i64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|duration| duration.as_millis() as i64)
    .unwrap_or(0)
}

fn read_json_object(file: &Path) -> Result<Option<serde_json::Map<String, Value>>, String> {
  if !file.exists() {
    return Ok(None);
  }
  let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
  match serde_json::from_str::<Value>(&text) {
    Ok(Value::Object(values)) => Ok(Some(values)),
    Ok(_) => Err(format!("{} 不是 JSON 对象", file.to_string_lossy())),
    Err(error) => Err(format!("无法迁移 {}: {error}", file.to_string_lossy())),
  }
}

fn read_json_array(file: &Path) -> Result<Option<Vec<Value>>, String> {
  if !file.exists() {
    return Ok(None);
  }
  let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
  match serde_json::from_str::<Value>(&text) {
    Ok(Value::Array(values)) => Ok(Some(values)),
    Ok(_) => Err(format!("{} 不是 JSON 数组", file.to_string_lossy())),
    Err(error) => Err(format!("无法迁移 {}: {error}", file.to_string_lossy())),
  }
}

fn archive_migrated_file(file: &Path) {
  if !file.exists() {
    return;
  }
  let extension = file
    .extension()
    .and_then(|value| value.to_str())
    .unwrap_or("json");
  let target = file.with_extension(format!("{extension}.migrated"));
  if !target.exists() {
    let _ = std::fs::rename(file, target);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn memory_db() -> PersistenceDb {
    let connection = Connection::open_in_memory().unwrap();
    connection
      .execute_batch(
        "
        CREATE TABLE app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE recovery_drafts (
          window_id TEXT PRIMARY KEY,
          path TEXT,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE authorized_paths (
          path TEXT PRIMARY KEY COLLATE NOCASE,
          authorized_at INTEGER NOT NULL
        );
        ",
      )
      .unwrap();
    PersistenceDb {
      connection: Mutex::new(connection),
    }
  }

  #[test]
  fn state_round_trip_and_delete() {
    let db = memory_db();
    db.state_set("workspaceDir", Value::String("E:/notes".into()))
      .unwrap();
    assert_eq!(
      db.state_get("workspaceDir").unwrap(),
      Some(Value::String("E:/notes".into()))
    );
    db.state_delete("workspaceDir").unwrap();
    assert_eq!(db.state_get("workspaceDir").unwrap(), None);
  }

  #[test]
  fn recovery_round_trip() {
    let db = memory_db();
    let draft = RecoveryDraft {
      path: Some("E:/notes/demo.md".into()),
      name: "demo.md".into(),
      content: "# Demo".into(),
      saved_at: now_ms(),
    };
    db.recovery_set("main", draft).unwrap();
    assert_eq!(db.recovery_get("main").unwrap().unwrap().content, "# Demo");
    db.recovery_delete("main").unwrap();
    assert!(db.recovery_get("main").unwrap().is_none());
  }

  #[test]
  fn authorized_paths_are_deduplicated_case_insensitively() {
    let db = memory_db();
    db.remember_authorized_path(Path::new("E:/Notes/A.md"))
      .unwrap();
    db.remember_authorized_path(Path::new("e:/notes/a.md"))
      .unwrap();
    assert_eq!(db.authorized_paths().unwrap().len(), 1);
  }

  #[test]
  fn legacy_settings_are_migrated_and_archived() {
    let db = memory_db();
    let dir = std::env::temp_dir().join(format!(
      "notemark-persistence-{}-{}",
      std::process::id(),
      now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("settings.json");
    std::fs::write(&file, r#"{"workspaceDir":"E:/notes","sidebarOpen":true}"#).unwrap();

    db.migrate_settings(&file).unwrap();
    assert_eq!(
      db.state_get("workspaceDir").unwrap(),
      Some(Value::String("E:/notes".into()))
    );
    assert_eq!(
      db.state_get("sidebarOpen").unwrap(),
      Some(Value::Bool(true))
    );
    assert!(!file.exists());
    assert!(dir.join("settings.json.migrated").exists());

    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn legacy_recovery_json_is_migrated() {
    let db = memory_db();
    let dir = std::env::temp_dir().join(format!(
      "notemark-recovery-{}-{}",
      std::process::id(),
      now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("recovery.json");
    std::fs::write(
      &file,
      r##"{"draft:main":{"path":"E:/notes/demo.md","name":"demo.md","content":"# Demo","savedAt":123}}"##,
    )
    .unwrap();

    db.migrate_recovery(&file).unwrap();
    let draft = db.recovery_get("main").unwrap().unwrap();
    assert_eq!(draft.content, "# Demo");
    assert_eq!(draft.saved_at, 123);
    assert!(!file.exists());

    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn window_state_round_trip_and_legacy_migration() {
    let db = memory_db();
    let state = WindowState {
      x: 120,
      y: 80,
      width: 1100,
      height: 760,
      maximized: false,
    };
    db.window_state_set("main", state).unwrap();
    assert_eq!(db.window_state_get("main").unwrap(), Some(state));

    let dir = std::env::temp_dir().join(format!(
      "notemark-window-state-{}-{}",
      std::process::id(),
      now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(".window-state.json");
    std::fs::write(
      &file,
      r#"{"doc-test":{"x":200,"y":100,"width":1000,"height":720,"maximized":true}}"#,
    )
    .unwrap();
    db.migrate_window_state(&file).unwrap();
    assert_eq!(
      db.window_state_get("doc-test").unwrap(),
      Some(WindowState {
        x: 200,
        y: 100,
        width: 1000,
        height: 720,
        maximized: true,
      })
    );
    assert!(!file.exists());

    let _ = std::fs::remove_dir_all(dir);
  }
}
