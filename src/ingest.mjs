// 采样包导入：每个包一个 IMMEDIATE 事务，要么整包成为事实，要么整体回滚。
// 冲突检测只看身份键与内容键，与文件名、到达顺序无关。
import { validatePacket, canonical } from './packet.mjs';

export function identityKey(record) {
  return record.type === 'reading'
    ? `R|${record.stationId}|${record.bootId}|${record.seq}|${record.revision}`
    : `C|${record.stationId}|${record.calibrationId}|${record.revision}`;
}

export function contentKey(record) {
  return record.type === 'reading'
    ? canonical({ sampledAt: record.sampledAt, raw: record.raw })
    : canonical({ validFrom: record.validFrom, validTo: record.validTo, scale: record.scale, offset: record.offset });
}

// 站点当前生效的校准集合：每个 calibrationId 只取最高 revision（低修订不能撤销高修订）。
export function effectiveCalibrations(db, stationId) {
  const rows = db.prepare(`SELECT calibration_id AS id, revision,
      valid_from AS validFrom, valid_to AS validTo, scale, offset
    FROM facts WHERE type = 'calibration' AND status = 'active' AND station_id = ?`).all(stationId);
  const best = new Map();
  for (const row of rows) {
    const current = best.get(row.id);
    if (!current || row.revision > current.revision) best.set(row.id, row);
  }
  return [...best.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

const calSig = c => canonical([c.id, c.revision, c.validFrom, c.validTo, c.scale, c.offset]);

export function ingestPacket(db, packet, { hooks = {}, source = null } = {}) {
  // 结构或摘要不合法在此抛出：尚未开启事务，数据库零写入，整包不影响当前数据。
  validatePacket(packet);
  const { packetId, sha256 } = packet;

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT sha256 FROM packets WHERE packet_id = ?').get(packetId);
    if (existing) {
      if (existing.sha256 === sha256) {
        db.exec('COMMIT');
        return { status: 'duplicate', packetId }; // 同内容重发：幂等跳过
      }
      db.prepare('INSERT INTO rejections(at, file, packet_id, reason) VALUES(?,?,?,?)')
        .run(new Date().toISOString(), source, packetId, '包标识相同但内容不同，已拒绝');
      db.exec('COMMIT');
      return { status: 'id-conflict', packetId }; // 同标识不同内容：明确拒绝，不当重放
    }

    const stations = [...new Set(packet.records.map(r => r.stationId))];
    const calBefore = new Map(stations.map(s => [s, effectiveCalibrations(db, s)]));

    db.prepare('INSERT INTO packets(packet_id, sha256, record_count, received_at) VALUES(?,?,?,?)')
      .run(packetId, sha256, packet.records.length, new Date().toISOString());

    const insertFact = db.prepare(`INSERT INTO facts(packet_id, record_index, type, identity_key, content_key,
        station_id, revision, boot_id, seq, sampled_at, raw,
        calibration_id, valid_from, valid_to, scale, offset, status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const dirtyReadings = new Map();
    const markDirty = (stationId, bootId, seq) =>
      dirtyReadings.set(`${stationId}|${bootId}|${seq}`, { stationId, bootId, seq });
    let quarantined = 0;

    packet.records.forEach((record, index) => {
      const iKey = identityKey(record);
      const cKey = contentKey(record);
      const group = db.prepare('SELECT fact_id, content_key AS contentKey, status FROM facts WHERE identity_key = ?').all(iKey);
      // 组内已有不同内容（无论是否已隔离），或组已被冲突污染，则新记录同样隔离。
      const poisoned = group.some(g => g.status === 'quarantined') || group.some(g => g.contentKey !== cKey);
      let status = 'active';
      if (poisoned) {
        status = 'quarantined';
        const victims = db.prepare(`SELECT fact_id, type, station_id AS stationId, boot_id AS bootId, seq
          FROM facts WHERE identity_key = ? AND status = 'active' AND content_key <> ?`).all(iKey, cKey);
        db.prepare(`UPDATE facts SET status = 'quarantined'
          WHERE identity_key = ? AND status = 'active' AND content_key <> ?`).run(iKey, cKey);
        quarantined += victims.length + 1;
        for (const v of victims) if (v.type === 'reading') markDirty(v.stationId, v.bootId, v.seq);
      }
      insertFact.run(packetId, index, record.type, iKey, cKey, record.stationId, record.revision,
        record.bootId ?? null, record.seq ?? null, record.sampledAt ?? null, record.raw ?? null,
        record.calibrationId ?? null, record.validFrom ?? null, record.validTo ?? null,
        record.scale ?? null, record.offset ?? null, status);
      if (record.type === 'reading') markDirty(record.stationId, record.bootId, record.seq);
    });

    // 校准有效集合的前后差异 → 受影响时间区间（旧区间失去覆盖的观测也要重算）。
    for (const stationId of stations) {
      const before = calBefore.get(stationId);
      const after = effectiveCalibrations(db, stationId);
      const beforeSet = new Set(before.map(calSig));
      const afterSet = new Set(after.map(calSig));
      const ranges = new Map();
      const addRange = c => ranges.set(`${c.validFrom}|${c.validTo}`, c);
      for (const c of before) if (!afterSet.has(calSig(c))) addRange(c);
      for (const c of after) if (!beforeSet.has(calSig(c))) addRange(c);
      const insertRange = db.prepare('INSERT OR IGNORE INTO dirty_ranges(station_id, valid_from, valid_to) VALUES(?,?,?)');
      for (const c of ranges.values()) insertRange.run(stationId, c.validFrom, c.validTo);
    }

    const insertDirty = db.prepare('INSERT OR IGNORE INTO dirty_readings(station_id, boot_id, seq) VALUES(?,?,?)');
    for (const d of dirtyReadings.values()) insertDirty.run(d.stationId, d.bootId, d.seq);

    hooks.at?.('ingest.precommit');
    db.exec('COMMIT');
    return {
      status: quarantined > 0 ? 'received-with-quarantine' : 'received',
      packetId,
      records: packet.records.length,
      quarantined,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
