import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

for (const dir of ['src', 'test', 'tools']) {
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const file = `${dir}/${name}`;
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('语法构建检查通过');
