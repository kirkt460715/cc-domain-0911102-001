import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/store.mjs';
import { ingestPacket } from '../src/ingest.mjs';
import { publish } from '../src/derive.mjs';
import { queryReadings, quarantine, status } from '../src/query.mjs';
import { digestRecords, makePacket } from '../src/packet.mjs';
import { makeState, fixture } from './helpers.mjs';

const load = name => JSON.parse(readFileSync(fixture(name), 'utf8'));
const reading = (over = {}) => ({ type: 'reading', stationId: 'north', bootId: 'boot1', seq: 0,
  revision: 1, sampledAt: '2026-11-01T00:00:00.000Z', raw: '1', ...over });

function boot() {
  const state = makeState();
  const db = openStore(state.dir);
  return { db, state };
}
const ingestAll = (db, names) => names.map(n => ingestPacket(db, load(n)));
const values = (db, opts) => queryReadings(db, opts).readings
  .map(r => `${r.bootId}/${r.seq}@${r.sampledAt}=${r.value ?? 'null'}(${r.status})`);

test('乱序到达与跨包重发：同一读数不重复计数', () => {
  const { db } = boot();
  ingestAll(db, ['03-new-boot.json', '01-initial.json', '02-backfill.json']);
  publish(db);
  // 02-backfill 重发了 01-initial 的 seq10：派生表里只有一条。
  assert.deepEqual(values(db, { station: 'north' }), [
    'boot1/9@2026-11-01T01:00:00.000Z=11.120(ok)',
    'boot1/10@2026-11-01T02:00:00.000Z=12.346(ok)',
    'boot2/0@2026-11-01T04:00:00.000Z=10.500(ok)',
  ]);
});

test('同包同内容重发幂等，同标识不同内容明确拒绝', () => {
  const { db } = boot();
  assert.equal(ingestPacket(db, load('01-initial.json')).status, 'received');
  assert.equal(ingestPacket(db, load('01-initial.json')).status, 'duplicate');
  const evil = makePacket('01-initial', [reading({ bootId: 'boot9' })]);
  assert.equal(ingestPacket(db, evil).status, 'id-conflict');
  const s = status(db);
  assert.deepEqual(s.packets.map(p => p.packetId), ['01-initial']);
  assert.equal(s.rejections.length, 1);
  assert.match(s.rejections[0].reason, /标识相同但内容不同/);
});

test('结构不合法或摘要不符：整包回滚，零事实落库', () => {
  const { db } = boot();
  const good = reading({ seq: 1 });
  const bad = reading({ seq: -1, bootId: 'boot2' });
  const records = [good, bad];
  const packet = { format: 'river-samples/v1', packetId: 'badpack', records, sha256: digestRecords(records) };
  assert.throws(() => ingestPacket(db, packet), /seq 无效/);
  const tampered = makePacket('tampered', [reading()]);
  tampered.sha256 = '0'.repeat(64);
  assert.throws(() => ingestPacket(db, tampered), /摘要不一致/);
  const s = status(db);
  assert.equal(s.packets.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM facts').get().c, 0);
});

test('内容冲突的观测被隔离，其余站点照常接入', () => {
  const { db } = boot();
  ingestAll(db, ['01-initial.json', '04-calibration.json', '05-correction.json']);
  const result = ingestPacket(db, load('06-conflict.json'));
  assert.equal(result.status, 'received-with-quarantine');
  assert.equal(result.quarantined, 2); // 05 与 06 的 rev2 双双隔离
  publish(db);
  // 北站 seq10 回退到无冲突的 rev1；南站 seq2 正常换算。
  assert.deepEqual(values(db, {}), [
    'boot1/10@2026-11-01T02:00:00.000Z=12.293(ok)',
    'boot1/1@2026-11-01T03:00:00.000Z=5.650(ok)',
    'boot1/2@2026-11-01T04:00:00.000Z=7.170(ok)',
  ]);
  const groups = quarantine(db);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].identity.revision, 2);
  assert.deepEqual(groups[0].contents.map(c => c.content.raw).sort(), ['12.4', '12.9']);
  assert.deepEqual(groups[0].contents.flatMap(c => c.sources.map(s => s.packetId)).sort(),
    ['05-correction', '06-conflict']);
});

test('冲突组被污染后，重发其中任一内容仍然隔离', () => {
  const { db } = boot();
  ingestAll(db, ['05-correction.json', '06-conflict.json']);
  // 用另一个包重发 05 的 rev2 内容：组已污染，不能复活为活动事实。
  const resend = makePacket('resend', [reading({ bootId: 'boot1', seq: 10, revision: 2,
    sampledAt: '2026-11-01T07:00:00.000Z', raw: '12.4' })]);
  ingestPacket(db, resend);
  publish(db);
  assert.equal(queryReadings(db, { station: 'north' }).readings.length, 0);
  assert.equal(quarantine(db)[0].contents.length, 2);
});

test('迟到校准使既有发布失效并更新，即使包内没有读数', () => {
  const { db } = boot();
  ingestAll(db, ['01-initial.json', '02-backfill.json', '03-new-boot.json']);
  publish(db);
  const before = values(db, { station: 'north' });
  ingestAll(db, ['04-calibration.json']); // 纯校准包
  const result = publish(db);
  assert.equal(result.published, true);
  assert.equal(result.version, 2);
  const after = values(db, { station: 'north' });
  assert.notDeepEqual(after, before);
  assert.deepEqual(after, [
    'boot1/9@2026-11-01T01:00:00.000Z=11.042(ok)',
    'boot1/10@2026-11-01T02:00:00.000Z=12.293(ok)',
    'boot2/0@2026-11-01T04:00:00.000Z=10.410(ok)', // 04:00 仍在 base@2 的 [00:00,06:00) 内
  ]);
});

test('查询只能看到某个完整发布版本，新旧不混', () => {
  const { db } = boot();
  ingestAll(db, ['01-initial.json', '02-backfill.json', '03-new-boot.json']);
  publish(db);
  const v1 = values(db, { station: 'north' });
  ingestAll(db, ['04-calibration.json', '05-correction.json']);
  publish(db);
  // 最新版本：seq10 被更正到 07:00，且移出 base@2 的 [00:00,06:00) 覆盖 → 未换算。
  assert.deepEqual(values(db, { station: 'north' }), [
    'boot1/9@2026-11-01T01:00:00.000Z=11.042(ok)',
    'boot2/0@2026-11-01T04:00:00.000Z=10.410(ok)',
    'boot1/10@2026-11-01T07:00:00.000Z=null(uncalibrated)',
  ]);
  // 旧版本完整可读：还是更正前的时间与旧校准。
  assert.deepEqual(values(db, { station: 'north', version: 1 }), v1);
  assert.throws(() => queryReadings(db, { version: 3 }), /发布版本无效/);
});

test('同优先级重叠校准保留待核对，不替值班人员选择', () => {
  const { db } = boot();
  ingestAll(db, ['01-initial.json', '02-backfill.json', '03-new-boot.json', '04-calibration.json', '07-overlap.json']);
  publish(db);
  const rows = queryReadings(db, { station: 'north' }).readings;
  const seq9 = rows.find(r => r.seq === 9);
  const seq10 = rows.find(r => r.seq === 10);
  const boot2 = rows.find(r => r.bootId === 'boot2');
  assert.equal(seq9.status, 'ok'); // 01:00 不在 other 的 [02:00,05:00) 内
  assert.equal(seq9.value, '11.042');
  for (const row of [seq10, boot2]) {
    assert.equal(row.status, 'ambiguous');
    assert.equal(row.value, null);
    assert.deepEqual(row.competitors.map(c => c.calibrationId), ['base', 'other']);
  }
});

test('更低修订的校准迟到不撤销已接收的更高修订', () => {
  const { db } = boot();
  ingestAll(db, ['04-calibration.json', '01-initial.json']); // 高修订先到
  publish(db);
  const row = queryReadings(db, { station: 'north' }).readings.find(r => r.seq === 10);
  assert.equal(row.calibration.revision, 2);
  assert.equal(row.value, '12.293');
});

test('读数更正移出校准覆盖：保留原始观测但不冒充已换算', () => {
  const { db } = boot();
  ingestAll(db, ['01-initial.json', '04-calibration.json', '05-correction.json']);
  publish(db);
  const row = queryReadings(db, { station: 'north' }).readings.find(r => r.seq === 10);
  assert.equal(row.revision, 2);
  assert.equal(row.sampledAt, '2026-11-01T07:00:00.000Z');
  assert.equal(row.status, 'uncalibrated');
  assert.equal(row.value, null);
  assert.equal(row.raw, '12.4');
});

test('舍入包：正负正中间都向绝对值更大方向', () => {
  const { db } = boot();
  ingestAll(db, ['08-rounding.json']);
  publish(db);
  assert.deepEqual(queryReadings(db, { station: 'edge' }).readings.map(r => r.value),
    ['0.001', '-0.001', '9007199254740993.001']);
});

test('发布版本同时返回原始修订与校准依据', () => {
  const { db } = boot();
  ingestAll(db, ['01-initial.json', '04-calibration.json']);
  publish(db);
  const result = queryReadings(db, { station: 'south' });
  assert.equal(result.version, 1);
  const row = result.readings[0];
  assert.equal(row.revision, 1);
  assert.deepEqual(row.calibration, { calibrationId: 'south-base', revision: 1, scale: '0.8', offset: '0.05' });
});

test('status 解释已接收与未发布，全量重算与局部重算结果一致', () => {
  const { db } = boot();
  ingestAll(db, ['01-initial.json', '02-backfill.json']);
  let s = status(db);
  assert.equal(s.packets.length, 2);
  assert.deepEqual(s.pending.unpublishedPackets, ['01-initial', '02-backfill']);
  publish(db);
  s = status(db);
  assert.equal(s.currentVersion, 1);
  assert.deepEqual(s.pending.unpublishedPackets, []);
  ingestAll(db, ['04-calibration.json', '07-overlap.json']);
  publish(db); // 局部重算
  const incremental = values(db, {});
  publish(db, { full: true }); // 全量重算（审计路径）
  assert.deepEqual(values(db, {}), incremental);
});
