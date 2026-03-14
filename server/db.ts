import Database from 'better-sqlite3'
import { resolve } from 'path'

const DB_PATH = resolve(import.meta.dirname, '..', 'data', 'dashboard.db')

export function initDb(): Database.Database {
  const db = new Database(DB_PATH)

  // Enable WAL mode for better concurrent read/write
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL DEFAULT '',
      transcript_path TEXT DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active',
      last_activity TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      notification_type TEXT,
      tool_name TEXT,
      subagent_id TEXT,
      timestamp TEXT NOT NULL,
      raw_payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE IF NOT EXISTS insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'transcript',
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_insights_session ON insights(session_id);
    CREATE INDEX IF NOT EXISTS idx_insights_timestamp ON insights(timestamp);
  `)

  // Safe migration: ADD COLUMN silently no-ops if column already exists (SQLite behavior)
  try { db.exec(`ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }

  return db
}

export type { Database }
