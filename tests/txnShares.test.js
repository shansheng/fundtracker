const test = require('node:test');
const assert = require('node:assert');
const { navApplicableDate, sharesFromAmount, splitTxDate } = require('../src/services/txnShares');

test('navApplicableDate: 15:00 后交易 -> T+1', () => {
  assert.strictEqual(navApplicableDate('2026-08-11', '23:04'), '2026-08-12');
  assert.strictEqual(navApplicableDate('2026-08-11', '22:46'), '2026-08-12');
});

test('navApplicableDate: 恰好 15:00 -> 视为 T+1(截止点之后)', () => {
  assert.strictEqual(navApplicableDate('2026-08-11', '15:00'), '2026-08-12');
});

test('navApplicableDate: 15:00 前交易 -> 当日(T)净值', () => {
  assert.strictEqual(navApplicableDate('2026-08-11', '14:30'), '2026-08-11');
  assert.strictEqual(navApplicableDate('2026-08-11', '09:05'), '2026-08-11');
});

test('navApplicableDate: 无交易时间 -> 保守按 T+1', () => {
  assert.strictEqual(navApplicableDate('2026-08-11', null), '2026-08-12');
  assert.strictEqual(navApplicableDate('2026-08-11', ''), '2026-08-12');
});

test('navApplicableDate: 缺交易日期 -> null', () => {
  assert.strictEqual(navApplicableDate(null, '23:04'), null);
});

test('sharesFromAmount: 正常计算(保留4位)', () => {
  assert.strictEqual(sharesFromAmount(100, 2.2351), 44.7407);
  assert.strictEqual(sharesFromAmount(1000, 1.029), 971.8173);
});

test('sharesFromAmount: 净值为 0 或空 -> null', () => {
  assert.strictEqual(sharesFromAmount(100, 0), null);
  assert.strictEqual(sharesFromAmount(100, null), null);
  assert.strictEqual(sharesFromAmount(null, 1.5), null);
});

test('splitTxDate: 空格分隔格式', () => {
  assert.deepStrictEqual(splitTxDate('2026-08-11 23:04:20'), { date: '2026-08-11', time: '23:04' });
});

test('splitTxDate: T 分隔格式', () => {
  assert.deepStrictEqual(splitTxDate('2026-08-11T23:04:20'), { date: '2026-08-11', time: '23:04' });
});

test('splitTxDate: 仅日期 / 空值', () => {
  assert.deepStrictEqual(splitTxDate('2026-08-11'), { date: '2026-08-11', time: null });
  assert.deepStrictEqual(splitTxDate(null), { date: null, time: null });
});
