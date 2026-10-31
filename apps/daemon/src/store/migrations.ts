import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  up(db: Database.Database): void
}

/**
 * Schema migrations, keyed on PRAGMA user_version. Append only: never edit a shipped migration.
 * Every statement is idempotent-safe because each migration runs once, inside a transaction, together
 * with the user_version bump.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core tables',
    up(db) {
      db.exec(`
        CREATE TABLE events (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          ts            TEXT NOT NULL,
          source        TEXT NOT NULL,
          session_id    TEXT,
          hook_event    TEXT NOT NULL,
          tool_use_id   TEXT,
          payload_json  TEXT NOT NULL,
          dedupe_key    TEXT UNIQUE
        );
        CREATE INDEX events_session ON events(session_id, id);
        CREATE INDEX events_ts ON events(ts);

        CREATE TABLE projects (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          root_path   TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'active',
          tags_json   TEXT NOT NULL DEFAULT '[]',
          color       TEXT NOT NULL,
          hub_note    TEXT
        );

        CREATE TABLE sessions (
          id            TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL REFERENCES projects(id),
          title         TEXT NOT NULL,
          source        TEXT NOT NULL,
          kind          TEXT NOT NULL,
          status        TEXT NOT NULL,
          model         TEXT NOT NULL,
          cwd           TEXT NOT NULL,
          branch        TEXT,
          started_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          current_tool  TEXT,
          cost_usd      REAL NOT NULL DEFAULT 0,
          context_pct   REAL NOT NULL DEFAULT 0,
          summary       TEXT,
          related_notes_json TEXT,
          error         TEXT
        );
        CREATE INDEX sessions_updated ON sessions(updated_at);

        CREATE TABLE agents (
          session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          id            TEXT NOT NULL,
          ord           INTEGER NOT NULL,
          parent_id     TEXT,
          type          TEXT NOT NULL,
          status        TEXT NOT NULL,
          last_message  TEXT NOT NULL DEFAULT '',
          description   TEXT,
          current_tool  TEXT,
          PRIMARY KEY (session_id, id)
        );

        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          ord             INTEGER NOT NULL,
          project_id      TEXT,
          title           TEXT NOT NULL,
          description     TEXT,
          col             TEXT NOT NULL,
          priority        TEXT NOT NULL,
          session_ids_json TEXT NOT NULL DEFAULT '[]',
          source          TEXT NOT NULL,
          branch          TEXT,
          pr_url          TEXT,
          updated_at      TEXT NOT NULL
        );

        CREATE TABLE approvals (
          id            TEXT PRIMARY KEY,
          ord           INTEGER NOT NULL,
          kind          TEXT NOT NULL,
          title         TEXT NOT NULL,
          detail        TEXT NOT NULL,
          requested_at  TEXT NOT NULL,
          session_id    TEXT,
          status        TEXT NOT NULL,
          risk          TEXT NOT NULL,
          tier          TEXT NOT NULL,
          preview       TEXT,
          area          TEXT NOT NULL,
          ref_id        TEXT,
          origin        TEXT NOT NULL DEFAULT 'lane',
          decided_at    TEXT
        );
        CREATE INDEX approvals_status ON approvals(status);

        CREATE TABLE chat_messages (
          ord         INTEGER PRIMARY KEY AUTOINCREMENT,
          id          TEXT NOT NULL UNIQUE,
          role        TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          modality    TEXT NOT NULL,
          parts_json  TEXT NOT NULL
        );

        CREATE TABLE audit (
          ord           INTEGER PRIMARY KEY AUTOINCREMENT,
          id            TEXT NOT NULL UNIQUE,
          at            TEXT NOT NULL,
          actor         TEXT NOT NULL,
          action        TEXT NOT NULL,
          target        TEXT NOT NULL,
          outcome       TEXT NOT NULL,
          sent_to_cloud TEXT,
          detail        TEXT,
          sensitive     INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE kv (
          key         TEXT PRIMARY KEY,
          value_json  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
      `)
    },
  },
  {
    version: 2,
    name: 'agent events, usage, lane sessions',
    up(db) {
      db.exec(`
        CREATE TABLE agent_events (
          ord         INTEGER PRIMARY KEY AUTOINCREMENT,
          id          TEXT NOT NULL UNIQUE,
          ts          TEXT NOT NULL,
          session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          agent_id    TEXT,
          hook_event  TEXT NOT NULL,
          tool_name   TEXT,
          summary     TEXT NOT NULL,
          level       TEXT NOT NULL DEFAULT 'info'
        );
        CREATE INDEX agent_events_session ON agent_events(session_id, ord);

        CREATE TABLE usage (
          day       TEXT NOT NULL,
          lane      TEXT NOT NULL,
          model     TEXT NOT NULL,
          cost_usd  REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (day, lane, model)
        );

        CREATE TABLE lane_sessions (
          session_id  TEXT PRIMARY KEY,
          lane        TEXT NOT NULL,
          created_at  TEXT NOT NULL
        );
      `)
    },
  },
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export class MigrationError extends Error {
  override name = 'MigrationError'
}

/**
 * Bring `db` up to the latest schema. Safe to call repeatedly. Refuses a database written by a newer daemon,
 * because running old code against a newer schema silently corrupts data.
 */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): { from: number; to: number } {
  const from = Number(db.pragma('user_version', { simple: true }))
  const latest = migrations[migrations.length - 1]?.version ?? 0
  if (from > latest) {
    throw new MigrationError(`database schema version ${from} is newer than this daemon supports (${latest}); upgrade the daemon`)
  }
  let current = from
  for (const m of migrations) {
    if (m.version <= current) continue
    const run = db.transaction(() => {
      m.up(db)
      // user_version cannot be a bound parameter; the value is a trusted integer from the migration list.
      db.pragma(`user_version = ${Math.trunc(m.version)}`)
    })
    run()
    current = m.version
  }
  return { from, to: current }
}
