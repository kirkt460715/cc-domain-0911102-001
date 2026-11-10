// 接入命令行：导入、继续处理（发布）、查询、状态、隔离区、版本历史。
// 故障演练：设置环境变量 RIVER_FAULT_AT=ingest.precommit|publish.afterDerive|publish.precommit
// 可在对应中断点让进程立即退出（退出码 2），用于可重复地验证崩溃恢复。
import { readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { openStore } from './store.mjs';
import { ingestPacket } from './ingest.mjs';
import { publish } from './derive.mjs';
import { queryReadings, status, quarantine } from './query.mjs';

const USAGE = `用法：node src/cli.mjs [--state <状态目录>] <命令> [参数]

命令：
  ingest <文件或目录>...   导入采样包（目录取其下全部 *.json，乱序无关）
  process [--full]         继续处理：把已接收未发布的变更发布为新版本
                           （--full 全量重算，默认按受影响范围局部重算）
  query [--station 站点] [--from 时刻] [--to 时刻] [--version N]
                           按站点与时间区间读取某个完整发布版本（默认最新）
  status                   已持久接收的包、未发布变更、拒绝记录与版本
  quarantine               查看被隔离的冲突观测
  versions                 发布历史

环境变量：
  RIVER_STATE              默认状态目录（缺省为 ./state）
  RIVER_FAULT_AT           故障注入点（仅用于演练崩溃恢复）`;

function parseArgs(argv) {
  const opts = { state: process.env.RIVER_STATE || 'state' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--state') opts.state = argv[++i];
    else if (arg === '--full') opts.full = true;
    else if (arg.startsWith('--')) opts[arg.slice(2)] = argv[++i];
    else rest.push(arg);
  }
  return { opts, rest };
}

// RIVER_FAULT_AT 命中时在事务提交前直接退出进程，模拟崩溃；未提交数据随之回滚。
const faultAt = process.env.RIVER_FAULT_AT;
const hooks = {
  at(point) {
    if (faultAt === point) {
      console.error(`故障注入：进程在 ${point} 处退出（未提交的事务将回滚）`);
      process.exit(2);
    }
  },
};

async function expandPaths(paths) {
  const files = [];
  for (const p of paths) {
    const info = statSync(p, { throwIfNoEntry: false });
    if (!info) throw new Error(`路径不存在：${p}`);
    if (info.isDirectory()) {
      const names = (await readdir(p)).filter(n => n.endsWith('.json')).sort();
      files.push(...names.map(n => path.join(p, n)));
    } else {
      files.push(p);
    }
  }
  return files;
}

async function cmdIngest(db, paths) {
  const files = await expandPaths(paths);
  if (files.length === 0) throw new Error('没有找到可导入的 .json 采样包');
  const results = [];
  let failures = 0;
  for (const file of files) {
    let result;
    try {
      const packet = JSON.parse(await readFile(file, 'utf8'));
      result = { file, ...ingestPacket(db, packet, { hooks, source: file }) };
    } catch (error) {
      // 结构或摘要不合法：整包拒绝并留痕，其余包继续导入。
      let packetId = null;
      try { packetId = JSON.parse(await readFile(file, 'utf8'))?.packetId ?? null; } catch { /* 无法解析 */ }
      db.prepare('INSERT INTO rejections(at, file, packet_id, reason) VALUES(?,?,?,?)')
        .run(new Date().toISOString(), file, typeof packetId === 'string' ? packetId : null, error.message);
      result = { file, status: 'rejected', reason: error.message };
    }
    if (result.status === 'rejected' || result.status === 'id-conflict') failures++;
    results.push(result);
  }
  console.log(JSON.stringify({ results }, null, 2));
  return failures === 0 ? 0 : 1;
}

async function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const [command, ...args] = rest;
  if (!command || command === 'help') {
    console.error(USAGE);
    return command === 'help' ? 0 : 2;
  }
  const db = openStore(opts.state);
  try {
    switch (command) {
      case 'ingest':
        if (args.length === 0) throw new Error('ingest 需要至少一个文件或目录');
        return await cmdIngest(db, args);
      case 'process': {
        const result = publish(db, { hooks, full: Boolean(opts.full) });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case 'query': {
        const result = queryReadings(db, {
          station: opts.station ?? null,
          from: opts.from ?? null,
          to: opts.to ?? null,
          version: opts.version !== undefined ? Number(opts.version) : null,
        });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case 'status':
        console.log(JSON.stringify(status(db), null, 2));
        return 0;
      case 'quarantine':
        console.log(JSON.stringify({ groups: quarantine(db) }, null, 2));
        return 0;
      case 'versions':
        console.log(JSON.stringify({ publications: status(db).publications }, null, 2));
        return 0;
      default:
        console.error(`未知命令：${command}\n\n${USAGE}`);
        return 2;
    }
  } finally {
    db.close();
  }
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`执行失败：${error.message}`);
  process.exitCode = 1;
});
