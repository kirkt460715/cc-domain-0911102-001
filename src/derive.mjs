// 派生与发布：把脏集合（受影响读数身份 + 校准变化区间）局部重算进时态派生表，
// 然后在同一事务内翻转 current_version。任何中途失败都整体回滚，
// 重跑不会丢数据，也不会多发一个发布版本。
import { convertRaw } from './decimal.mjs';
import { effectiveCalibrations } from './ingest.mjs';
import { currentVersion, setMeta } from './store.mjs';

// 由活动事实计算一条读数的当前派生值；返回 null 表示该身份没有可用观测。
export function computeDerived(db, stationId, bootId, seq) {
  const rows = db.prepare(`SELECT revision, sampled_at AS sampledAt, raw, content_key AS contentKey
    FROM facts
    WHERE type = 'reading' AND status = 'active' AND station_id = ? AND boot_id = ? AND seq = ?
    ORDER BY revision DESC`).all(stationId, bootId, seq);
  if (rows.length === 0) return null;
  const revision = rows[0].revision;
  const top = rows.filter(r => r.revision === revision);
  if (new Set(top.map(r => r.contentKey)).size > 1) {
    throw new Error(`内部不一致：${stationId}/${bootId}/${seq} 修订 ${revision} 存在未隔离的冲突内容`);
  }
  const { sampledAt, raw } = top[0];
  const base = { stationId, bootId, seq, revision, sampledAt, raw };

  // 校准按采样时刻选择，区间左闭右开；重叠取最高 revision。
  const covering = effectiveCalibrations(db, stationId)
    .filter(c => c.validFrom <= sampledAt && sampledAt < c.validTo);
  if (covering.length === 0) {
    return { ...base, status: 'uncalibrated', value: null, calibration: null, competitors: null };
  }
  const maxRevision = Math.max(...covering.map(c => c.revision));
  const tops = covering.filter(c => c.revision === maxRevision);
  const byConversion = new Map();
  for (const c of tops) {
    const key = `${c.scale}|${c.offset}`;
    if (!byConversion.has(key)) byConversion.set(key, []);
    byConversion.get(key).push(c);
  }
  if (byConversion.size > 1) {
    // 同优先级存在不同换算依据：保留待核对，不替值班人员做选择。
    const competitors = tops
      .map(c => ({ calibrationId: c.id, revision: c.revision, scale: c.scale, offset: c.offset }))
      .sort((a, b) => (a.calibrationId < b.calibrationId ? -1 : 1));
    return { ...base, status: 'ambiguous', value: null, calibration: null, competitors };
  }
  const group = [...byConversion.values()][0].sort((a, b) => (a.id < b.id ? -1 : 1));
  const basis = group[0];
  return {
    ...base,
    status: 'ok',
    value: convertRaw(raw, basis.scale, basis.offset),
    calibration: { calibrationId: basis.id, revision: basis.revision, scale: basis.scale, offset: basis.offset },
    competitors: null,
  };
}

const comparable = d => [
  d.revision, d.sampledAt, d.raw, d.status, d.value,
  d.calibration?.calibrationId ?? null, d.calibration?.revision ?? null,
  d.calibration?.scale ?? null, d.calibration?.offset ?? null,
  d.competitors ? JSON.stringify(d.competitors) : null,
];

const rowComparable = r => [
  r.revision, r.sampled_at, r.raw, r.status, r.value,
  r.calibration_id, r.calibration_revision, r.scale, r.offset, r.competitors,
];

export function publish(db, { hooks = {}, full = false } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const affected = new Map();
    const mark = (stationId, bootId, seq) =>
      affected.set(`${stationId}|${bootId}|${seq}`, { stationId, bootId, seq });

    if (full) {
      // 全量重算：审计/校验用途。默认路径是下面的局部重算。
      for (const r of db.prepare(`SELECT DISTINCT station_id AS s, boot_id AS b, seq AS q
          FROM facts WHERE type = 'reading'`).all()) mark(r.s, r.b, r.q);
    } else {
      for (const r of db.prepare('SELECT station_id AS s, boot_id AS b, seq AS q FROM dirty_readings').all()) {
        mark(r.s, r.b, r.q);
      }
      const byRange = db.prepare(`SELECT DISTINCT station_id AS s, boot_id AS b, seq AS q FROM facts
        WHERE type = 'reading' AND station_id = ? AND sampled_at >= ? AND sampled_at < ?`);
      for (const range of db.prepare('SELECT station_id AS s, valid_from AS f, valid_to AS t FROM dirty_ranges').all()) {
        for (const r of byRange.all(range.s, range.f, range.t)) mark(r.s, r.b, r.q);
      }
    }

    if (affected.size === 0) {
      db.exec('COMMIT');
      return { published: false, reason: '没有待处理的变更' };
    }

    const version = currentVersion(db) + 1;
    const openStmt = db.prepare(`SELECT rowid AS id, * FROM derived_readings
      WHERE station_id = ? AND boot_id = ? AND seq = ? AND valid_to_version IS NULL`);
    const closeStmt = db.prepare('UPDATE derived_readings SET valid_to_version = ? WHERE rowid = ?');
    const insertStmt = db.prepare(`INSERT INTO derived_readings(
        station_id, boot_id, seq, revision, sampled_at, raw, status, value,
        calibration_id, calibration_revision, scale, offset, competitors,
        valid_from_version, valid_to_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);

    let changes = 0;
    for (const id of affected.values()) {
      const derived = computeDerived(db, id.stationId, id.bootId, id.seq);
      const open = openStmt.get(id.stationId, id.bootId, id.seq);
      if (derived === null && !open) continue;
      if (derived !== null && open
          && JSON.stringify(comparable(derived)) === JSON.stringify(rowComparable(open))) continue;
      if (open) closeStmt.run(version, open.id);
      if (derived) {
        insertStmt.run(derived.stationId, derived.bootId, derived.seq, derived.revision,
          derived.sampledAt, derived.raw, derived.status, derived.value,
          derived.calibration?.calibrationId ?? null, derived.calibration?.revision ?? null,
          derived.calibration?.scale ?? null, derived.calibration?.offset ?? null,
          derived.competitors ? JSON.stringify(derived.competitors) : null, version);
      }
      changes++;
    }

    hooks.at?.('publish.afterDerive');

    db.exec('DELETE FROM dirty_readings');
    db.exec('DELETE FROM dirty_ranges');
    setMeta(db, 'current_version', version);
    const highwater = db.prepare('SELECT COALESCE(MAX(fact_id), 0) AS h FROM facts').get().h;
    setMeta(db, 'published_fact_highwater', highwater);
    db.prepare(`INSERT INTO publications(version, published_at, affected_identities, changed_rows, fact_highwater)
      VALUES(?,?,?,?,?)`).run(version, new Date().toISOString(), affected.size, changes, highwater);

    hooks.at?.('publish.precommit');
    db.exec('COMMIT');
    return { published: true, version, affected: affected.size, changes };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
