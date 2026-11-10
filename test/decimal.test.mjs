import test from 'node:test';
import assert from 'node:assert/strict';
import { convertRaw, parseDecimal, formatRounded } from '../src/decimal.mjs';

test('正中间向绝对值更大方向舍入：正值', () => {
  assert.equal(convertRaw('0.0005', '1', '0'), '0.001');
  assert.equal(convertRaw('1.2345', '1', '0'), '1.235');
  assert.equal(convertRaw('0.0004', '1', '0'), '0.000');
});

test('正中间向绝对值更大方向舍入：负值', () => {
  assert.equal(convertRaw('-0.0005', '1', '0'), '-0.001');
  assert.equal(convertRaw('-1.2345', '1', '0'), '-1.235');
  assert.equal(convertRaw('-0.0004', '1', '0'), '0.000');
});

test('超出 double 精度的原始值不丢位', () => {
  assert.equal(convertRaw('9007199254740993.0005', '1', '0'), '9007199254740993.001');
});

test('raw × scale + offset 全链路', () => {
  assert.equal(convertRaw('12.3456', '1.02', '-0.3'), '12.293');
  assert.equal(convertRaw('7.0001', '0.8', '0.05'), '5.650');
  assert.equal(convertRaw('10.5', '1.03', '-0.3'), '10.515');
  assert.equal(convertRaw('-2.5', '-2', '0.0005'), '5.001');
});

test('零结果不带负号，整数补齐三位小数', () => {
  assert.equal(convertRaw('-0.0001', '1', '0'), '0.000');
  assert.equal(convertRaw('2', '3', '-0.0001'), '6.000');
});

test('非法十进制被拒绝', () => {
  for (const bad of ['1e3', 'NaN', '1.', '.5', '--1', '1.1234567890123']) {
    assert.throws(() => parseDecimal(bad), /十进制/);
  }
  assert.equal(formatRounded(parseDecimal('0.0005'), 3), '0.001');
});
