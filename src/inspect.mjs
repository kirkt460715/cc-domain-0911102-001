import { readFile } from 'node:fs/promises';
import { validatePacket } from './packet.mjs';

const file = process.argv[2];
if (!file) {
  console.error('用法：npm run inspect -- <采样包.json>');
  process.exitCode = 2;
} else {
  try {
    const packet = validatePacket(JSON.parse(await readFile(file, 'utf8')));
    console.log(JSON.stringify({
      packetId: packet.packetId,
      sha256: packet.sha256,
      recordCount: packet.records.length,
      stations: [...new Set(packet.records.map(r => r.stationId))].sort(),
      readings: packet.records.filter(r => r.type === 'reading').length,
      calibrations: packet.records.filter(r => r.type === 'calibration').length,
    }));
  } catch (error) {
    console.error(`采样包检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
