// 接入状态存储：SQLite（内置 node:sqlite），WAL 模式允许多进程并发读写。
// 表结构分三层：
//   事实层  packets / facts / rejections —— 只追加，永不修改业务内容；
//   暂存层  dirty_readings / dirty_ranges —— 已接收但未发布的受影响范围；
//   派生层  derived_readings（按发布版本时态化）/ publications / meta。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packets (
  packet_id    TEXT PRIMARY KEY,
  sha256       TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id       TEXT NOT NULL REFERENCES packets(packet_id),
  record_index    INTEGER NOT NULL,
  type            TEXT NOT NULL,
  identity_key    TEXT NOT NULL,
  content_key     TEXT NOT NULL,
  station_id      TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  boot_id         TEXT,
  seq             INTEGER,
  sampled_at      TEXT,
  raw             TEXT,
  calibration_id  TEXT,
  valid_from      TEXT,
  valid_to        TEXT,
  scale           TEXT,
  offset          TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  UNIQUE(packet_id, record_index)
);
CREATE INDEX IF NOT EXISTS facts_identity ON facts(identity_key);
CREATE INDEX IF NOT EXISTS facts_reading_time ON facts(type, station_id, sampled_at);

CREATE TABLE IF NOT EXISTS rejections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  file       TEXT,
  packet_id  TEXT,
  reason     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dirty_readings (
  station_id TEXT NOT NULL,
  boot_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  PRIMARY KEY(station_id, boot_id, seq)
);

CREATE TABLE IF NOT EXISTS dirty_ranges (
  station_id TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to   TEXT NOT NULL,
  PRIMARY KEY(station_id, valid_from, valid_to)
);

CREATE TABLE IF NOT EXISTS derived_readings (
  station_id           TEXT NOT NULL,
  boot_id              TEXT NOT NULL,
  seq                  INTEGER NOT NULL,
  revision             INTEGER NOT NULL,
  sampled_at           TEXT NOT NULL,
  raw                  TEXT NOT NULL,
  status               TEXT NOT NULL,           -- ok | uncalibrated | ambiguous
  value                TEXT,                    -- 三位小数字符串；未换算时为 NULL
  calibration_id       TEXT,
  calibration_revision INTEGER,
  scale                TEXT,
  offset               TEXT,
  competitors          TEXT,                    -- ambiguous 时的竞争校准 JSON
  valid_from_version   INTEGER NOT NULL,
  valid_to_version     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS derived_open
  ON derived_readings(station_id, boot_id, seq) WHERE valid_to_version IS NULL;
CREATE INDEX IF NOT EXISTS derived_query ON derived_readings(station_id, sampled_at);

CREATE TABLE IF NOT EXISTS publications (
  version             INTEGER PRIMARY KEY,
  published_at        TEXT NOT NULL,
  affected_identities INTEGER NOT NULL,
  changed_rows        INTEGER NOT NULL,
  fact_highwater      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 两个进程同时首次打开同一状态目录时，建库/转 WAL/建表可能互相短暂阻塞；
// 这类 SQLITE_BUSY 属于模式转换期冲突，busy_timeout 不会兜底，需在上层重试。
export function openStore(stateDir, { retries = 100 } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'river.db');
  for (let attempt = 0; ; attempt++) {
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(SCHEMA);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return db;
    } catch (error) {
      db.close();
      if (!/database is locked/i.test(error.message) || attempt >= retries) throw error;
      sleep(10 + Math.floor(Math.random() * 40));
    }
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

export function currentVersion(db) {
  return Number(getMeta(db, 'current_version', '0'));
}

export function factHighwater(db) {
  return Number(getMeta(db, 'published_fact_highwater', '0'));
}
