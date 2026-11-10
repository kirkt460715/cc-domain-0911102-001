// 查询入口：所有读取都固定在某个完整发布版本上，绝不混用新旧版本。
import { currentVersion, factHighwater } from './store.mjs';

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function toReading(row) {
  return {
    stationId: row.station_id,
    bootId: row.boot_id,
    seq: row.seq,
    revision: row.revision,          // 采用的原始修订
    sampledAt: row.sampled_at,
    raw: row.raw,
    status: row.status,              // ok | uncalibrated | ambiguous
    value: row.value,                // 换算结果（三位小数字符串）；未换算为 null
    calibration: row.calibration_id === null ? null : {
      calibrationId: row.calibration_id,
      revision: row.calibration_revision,
      scale: row.scale,
      offset: row.offset,
    },
    competitors: row.competitors ? JSON.parse(row.competitors) : null,
  };
}

export function queryReadings(db, { station = null, from = null, to = null, version = null } = {}) {
  const current = currentVersion(db);
  const v = version === null ? current : Number(version);
  if (current === 0) return { version: null, readings: [], note: '尚未发布任何版本' };
  if (!Number.isSafeInteger(v) || v < 1 || v > current) {
    throw new Error(`发布版本无效：${version}（当前已发布 1..${current}）`);
  }
  for (const [label, t] of [['from', from], ['to', to]]) {
    if (t !== null && (typeof t !== 'string' || !TIMESTAMP.test(t))) {
      throw new Error(`--${label} 时间格式无效：${t}`);
    }
  }
  let sql = `SELECT * FROM derived_readings
    WHERE valid_from_version <= ? AND (valid_to_version IS NULL OR valid_to_version > ?)`;
  const params = [v, v];
  if (station !== null) { sql += ' AND station_id = ?'; params.push(station); }
  if (from !== null) { sql += ' AND sampled_at >= ?'; params.push(from); }
  if (to !== null) { sql += ' AND sampled_at < ?'; params.push(to); }
  sql += ' ORDER BY station_id, sampled_at, boot_id, seq';
  const readings = db.prepare(sql).all(...params).map(toReading);
  return { version: v, readings };
}

export function status(db) {
  const highwater = factHighwater(db);
  const maxFact = db.prepare('SELECT COALESCE(MAX(fact_id), 0) AS m FROM facts').get().m;
  return {
    currentVersion: currentVersion(db),
    packets: db.prepare('SELECT packet_id AS packetId, sha256, record_count AS records, received_at AS receivedAt FROM packets ORDER BY rowid').all(),
    pending: {
      unpublishedPackets: db.prepare('SELECT DISTINCT packet_id AS p FROM facts WHERE fact_id > ? ORDER BY p').all(highwater).map(r => r.p),
      unpublishedFacts: maxFact - highwater,
      dirtyReadings: db.prepare('SELECT COUNT(*) AS c FROM dirty_readings').get().c,
      dirtyRanges: db.prepare('SELECT COUNT(*) AS c FROM dirty_ranges').get().c,
    },
    quarantinedFacts: db.prepare("SELECT COUNT(*) AS c FROM facts WHERE status = 'quarantined'").get().c,
    rejections: db.prepare('SELECT at, file, packet_id AS packetId, reason FROM rejections ORDER BY id').all(),
    publications: db.prepare(`SELECT version, published_at AS publishedAt,
        affected_identities AS affectedIdentities, changed_rows AS changedRows, fact_highwater AS factHighwater
      FROM publications ORDER BY version`).all(),
  };
}

export function quarantine(db) {
  const rows = db.prepare(`SELECT identity_key AS identityKey, type, station_id AS stationId,
      revision, boot_id AS bootId, seq, calibration_id AS calibrationId,
      content_key AS contentKey, packet_id AS packetId, record_index AS recordIndex
    FROM facts WHERE status = 'quarantined'
    ORDER BY identity_key, packet_id, record_index`).all();
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.identityKey)) {
      groups.set(row.identityKey, {
        identity: row.type === 'reading'
          ? { type: 'reading', stationId: row.stationId, bootId: row.bootId, seq: row.seq, revision: row.revision }
          : { type: 'calibration', stationId: row.stationId, calibrationId: row.calibrationId, revision: row.revision },
        contents: new Map(),
      });
    }
    const group = groups.get(row.identityKey);
    if (!group.contents.has(row.contentKey)) {
      group.contents.set(row.contentKey, { content: JSON.parse(row.contentKey), sources: [] });
    }
    group.contents.get(row.contentKey).sources.push({ packetId: row.packetId, recordIndex: row.recordIndex });
  }
  return [...groups.values()].map(g => ({
    identity: g.identity,
    contents: [...g.contents.values()],
  }));
}
