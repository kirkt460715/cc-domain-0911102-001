// 崩溃恢复与并发接入：通过 RIVER_FAULT_AT 在固定中断点让子进程立即退出，
// 不依赖任何等待或时序运气，可重复验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { makeState, runCli, fixture, CLI } from './helpers.mjs';

const FAULTS = ['ingest.precommit', 'publish.afterDerive', 'publish.precommit'];

function prepare(stateDir) {
  assert.equal(runCli(stateDir, ['ingest', fixture('01-initial.json')]).code, 0);
  assert.equal(runCli(stateDir, ['process']).code, 0);
}

test('每个中断点崩溃后重跑：不丢数据、不多发版本、旧版本始终可读', { concurrency: 1 }, () => {
  for (const fault of FAULTS) {
    const state = makeState();
    prepare(state.dir);

    if (fault.startsWith('ingest.')) {
      const crashed = runCli(state.dir, ['ingest', fixture('04-calibration.json')], { RIVER_FAULT_AT: fault });
      assert.equal(crashed.code, 2);
      let s = runCli(state.dir, ['status']).json();
      assert.deepEqual(s.packets.map(p => p.packetId), ['01-initial']); // 未提交的事实整体回滚
      assert.equal(s.currentVersion, 1);
      assert.equal(runCli(state.dir, ['ingest', fixture('04-calibration.json')]).code, 0);
    } else {
      assert.equal(runCli(state.dir, ['ingest', fixture('04-calibration.json')]).code, 0);
      const crashed = runCli(state.dir, ['process'], { RIVER_FAULT_AT: fault });
      assert.equal(crashed.code, 2);
      const s = runCli(state.dir, ['status']).json();
      assert.equal(s.currentVersion, 1); // 发布切换未生效
      assert.ok(s.pending.dirtyRanges > 0 || s.pending.dirtyReadings > 0); // 变更仍在待处理
      // 发布失败期间旧版本照常可读。
      const stuck = runCli(state.dir, ['query', '--station', 'north']).json();
      assert.equal(stuck.version, 1);
      assert.equal(stuck.readings.find(r => r.seq === 10).value, '12.346');
    }

    const recovered = runCli(state.dir, ['process']).json();
    assert.equal(recovered.published, true);
    assert.equal(recovered.version, 2); // 恰好发布一次
    const again = runCli(state.dir, ['process']).json();
    assert.equal(again.published, false); // 重试不多发版本
    const s = runCli(state.dir, ['status']).json();
    assert.deepEqual(s.publications.map(p => p.version), [1, 2]);
    const north = runCli(state.dir, ['query', '--station', 'north']).json();
    assert.equal(north.readings.find(r => r.seq === 10).value, '12.293'); // 迟到校准已生效
    const facts = runCli(state.dir, ['status']).json();
    assert.equal(facts.pending.unpublishedFacts, 0);
  }
});

test('崩溃发生在两次提交之间：重启后 status 能解释接收与未发布', () => {
  const state = makeState();
  prepare(state.dir);
  assert.equal(runCli(state.dir, ['ingest', fixture('04-calibration.json')]).code, 0);
  // 模拟进程在此退出（未执行 process）：重新运行必须能说明状态。
  const s = runCli(state.dir, ['status']).json();
  assert.deepEqual(s.packets.map(p => p.packetId), ['01-initial', '04-calibration']);
  assert.deepEqual(s.pending.unpublishedPackets, ['04-calibration']);
  assert.equal(s.currentVersion, 1);
  assert.equal(runCli(state.dir, ['process']).json().version, 2);
});

function spawnIngest(stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ['--disable-warning=ExperimentalWarning', CLI, '--state', stateDir, 'ingest', 'fixtures/packets'],
      { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('两个接入进程同时处理同一目录：每个包只接收一次', async () => {
  const state = makeState();
  const [a, b] = await Promise.all([spawnIngest(state.dir), spawnIngest(state.dir)]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const results = [...JSON.parse(a.stdout).results, ...JSON.parse(b.stdout).results];
  const byPacket = new Map();
  for (const r of results) {
    const packetId = r.packetId ?? r.file;
    byPacket.set(packetId, [...(byPacket.get(packetId) ?? []), r.status]);
  }
  assert.equal(byPacket.size, 8);
  for (const [packetId, statuses] of byPacket) {
    const received = statuses.filter(s => s.startsWith('received'));
    const duplicates = statuses.filter(s => s === 'duplicate');
    assert.equal(received.length, 1, `${packetId} 应只接收一次：${statuses}`);
    assert.equal(duplicates.length, 1, `${packetId} 的另一进程应判为重放`);
  }
  // 并发导入后单次发布，数据集完整。
  assert.equal(runCli(state.dir, ['process']).code, 0);
  const s = runCli(state.dir, ['status']).json();
  assert.equal(s.packets.length, 8);
  assert.equal(s.quarantinedFacts, 2); // 06 号包的冲突观测
  const edge = runCli(state.dir, ['query', '--station', 'edge']).json();
  assert.deepEqual(edge.readings.map(r => r.value), ['0.001', '-0.001', '9007199254740993.001']);
});
