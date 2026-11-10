// 测试共享工具：临时状态目录、CLI 子进程、合成包构造。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FIXTURES = path.join(ROOT, 'fixtures', 'packets');
export const CLI = path.join(ROOT, 'src', 'cli.mjs');

export function makeState() {
  const dir = mkdtempSync(path.join(tmpdir(), 'river-test-'));
  return { dir, [Symbol.dispose]() { rmSync(dir, { recursive: true, force: true }); } };
}

export function runCli(stateDir, args, env = {}) {
  const result = spawnSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', CLI, '--state', stateDir, ...args],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json() { return JSON.parse(result.stdout); },
  };
}

export const fixture = name => path.join(FIXTURES, name);
