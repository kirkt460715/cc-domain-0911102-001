import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { canonical, digestRecords, makePacket, validatePacket } from '../src/packet.mjs';

const reading = () => ({ type: 'reading', stationId: 'north', bootId: 'boot1', seq: 0,
  revision: 1, sampledAt: '2026-11-01T00:00:00.000Z', raw: '-1.2345' });

test('对象键序不改变摘要，数组顺序参与摘要', () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.notEqual(digestRecords([1, 2]), digestRecords([2, 1]));
});

test('负数十进制与零序号有效', () => {
  assert.equal(makePacket('packet1', [reading()]).records[0].raw, '-1.2345');
});

test('摘要损坏被拒绝', () => {
  const packet = makePacket('packet1', [reading()]);
  packet.records[0].raw = '2';
  assert.throws(() => validatePacket(packet), /摘要不一致/);
});

test('校准区间与日期有效性受到检查', () => {
  const base = { type: 'calibration', stationId: 'north', calibrationId: 'cal1', revision: 1,
    validFrom: '2026-11-01T00:00:00.000Z', validTo: '2026-11-02T00:00:00.000Z', scale: '1', offset: '0' };
  assert.equal(makePacket('calpacket', [base]).records.length, 1);
  assert.throws(() => makePacket('bad', [{ ...base, validTo: base.validFrom }]), /区间必须非空/);
  assert.throws(() => makePacket('bad', [{ ...reading(), sampledAt: '2026-02-30T00:00:00.000Z' }]), /sampledAt 无效/);
});

test('非字符串小数、无穷值和无效修订被拒绝', () => {
  for (const fields of [{ raw: 1.2 }, { raw: 'NaN' }, { raw: '1e3' }, { revision: 0 }, { seq: -1 }]) {
    assert.throws(() => makePacket('bad', [{ ...reading(), ...fields }]));
  }
});

test('所有合成采样包结构和摘要一致', async () => {
  const files = (await readdir('fixtures/packets')).filter(x => x.endsWith('.json'));
  assert.ok(files.length >= 6);
  for (const name of files) {
    const packet = JSON.parse(await readFile(`fixtures/packets/${name}`, 'utf8'));
    assert.equal(validatePacket(packet), packet);
  }
});
