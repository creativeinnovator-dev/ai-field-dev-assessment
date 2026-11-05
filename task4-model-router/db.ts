import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// we only store a hash of the api key, not the key itself
export const hashKey = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex");

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS tenants (
      api_key_hash      TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      tokens_per_minute INTEGER NOT NULL DEFAULT 50000
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id      INTEGER PRIMARY KEY,
      tenant  TEXT    NOT NULL,
      ts      INTEGER NOT NULL,  -- ms
      tokens  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_tenant_ts ON token_usage (tenant, ts);

    CREATE TABLE IF NOT EXISTS request_log (
      request_id  TEXT PRIMARY KEY,
      tenant      TEXT,
      provider    TEXT,
      status      INTEGER NOT NULL,
      error_type  TEXT,
      tokens      INTEGER,
      latency_ms  INTEGER NOT NULL,
      detail      TEXT,  -- internal only, not sent to clients
      created_at  INTEGER NOT NULL
    );
  `);
  return db;
}

export function upsertTenant(db: DatabaseSync, apiKey: string, name: string, tokensPerMinute = 50_000) {
  db.prepare(
    `INSERT INTO tenants (api_key_hash, name, tokens_per_minute) VALUES (?, ?, ?)
     ON CONFLICT(api_key_hash) DO UPDATE SET name = excluded.name, tokens_per_minute = excluded.tokens_per_minute`,
  ).run(hashKey(apiKey), name, tokensPerMinute);
}

export function findTenant(db: DatabaseSync, apiKey: string) {
  return db.prepare(`SELECT api_key_hash AS id, name, tokens_per_minute AS limit_ FROM tenants WHERE api_key_hash = ?`)
    .get(hashKey(apiKey)) as { id: string; name: string; limit_: number } | undefined;
}
