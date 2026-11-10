import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DECIMAL = /^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,12})?$/;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestRecords(records) {
  return createHash('sha256').update(canonical(records), 'utf8').digest('hex');
}

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === 'string' && ID.test(value);
}

function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function decimal(value) {
  return typeof value === 'string' && DECIMAL.test(value);
}

export function validateRecord(record, index = 0) {
  const at = `records[${index}]`;
  requireValue(object(record), `${at} 必须是对象`);
  requireValue(identifier(record.stationId), `${at}.stationId 无效`);
  requireValue(positive(record.revision), `${at}.revision 必须是正安全整数`);
  if (record.type === 'reading') {
    requireValue(identifier(record.bootId), `${at}.bootId 无效`);
    requireValue(Number.isSafeInteger(record.seq) && record.seq >= 0, `${at}.seq 无效`);
    requireValue(timestamp(record.sampledAt), `${at}.sampledAt 无效`);
    requireValue(decimal(record.raw), `${at}.raw 必须是十进制字符串`);
  } else if (record.type === 'calibration') {
    requireValue(identifier(record.calibrationId), `${at}.calibrationId 无效`);
    requireValue(timestamp(record.validFrom) && timestamp(record.validTo), `${at} 校准时间无效`);
    requireValue(record.validFrom < record.validTo, `${at} 校准区间必须非空`);
    requireValue(decimal(record.scale) && decimal(record.offset), `${at} 校准系数无效`);
  } else {
    throw new Error(`${at}.type 无效`);
  }
  return record;
}

export function validatePacket(packet) {
  requireValue(object(packet), '采样包必须是对象');
  requireValue(packet.format === 'river-samples/v1', '采样包格式不支持');
  requireValue(identifier(packet.packetId), 'packetId 无效');
  requireValue(Array.isArray(packet.records) && packet.records.length > 0 && packet.records.length <= 10000,
    'records 必须包含 1 至 10000 条记录');
  requireValue(typeof packet.sha256 === 'string' && /^[0-9a-f]{64}$/.test(packet.sha256), 'sha256 无效');
  requireValue(digestRecords(packet.records) === packet.sha256, '采样包摘要不一致');
  packet.records.forEach(validateRecord);
  return packet;
}

export function makePacket(packetId, records) {
  return validatePacket({ format: 'river-samples/v1', packetId, records, sha256: digestRecords(records) });
}
