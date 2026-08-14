const { parseTrade, parseHolding } = require('../src/services/ocr');
const test = require('node:test');
const assert = require('node:assert');

test('parseTrade: 买入 + 6位代码 + 金额 + 日期', () => {
  const text = '买入\n001111\n2000.00元\n2026-08-14';
  const r = parseTrade(text, 'alipay');
  assert.strictEqual(r.kind, 'trade');
  assert.strictEqual(r.txs.length, 1);
  assert.strictEqual(r.txs[0].fund_code, '001111');
  assert.strictEqual(r.txs[0].type, 'buy');
  assert.strictEqual(r.txs[0].amount, 2000);
  assert.strictEqual(r.txs[0].date, '2026-08-14');
});

test('parseTrade: 赎回 -> sell', () => {
  const text = '赎回\n002222\n1500.00元';
  const r = parseTrade(text, 'alipay');
  assert.strictEqual(r.txs[0].type, 'sell');
  assert.strictEqual(r.txs[0].fund_code, '002222');
});

test('parseTrade: 无买入/赎回关键词默认 buy', () => {
  const text = '003333\n800.00元';
  const r = parseTrade(text, 'jd');
  assert.strictEqual(r.txs[0].type, 'buy');
  assert.strictEqual(r.txs[0].fund_code, '003333');
});

test('parseHolding: 含 6 位代码 -> 按代码解析', () => {
  const text = '003333\n8000.00元';
  const r = parseHolding(text, 'alipay');
  assert.strictEqual(r.kind, 'holding');
  assert.strictEqual(r.funds.length, 1);
  assert.strictEqual(r.funds[0].code, '003333');
  assert.strictEqual(r.funds[0].market_value, 8000);
});

test('parseTrade: 多只基金按代码分别解析', () => {
  const text = '买入\n001111 2000.00元\n002222 1500.00元';
  const r = parseTrade(text, 'alipay');
  assert.strictEqual(r.txs.length, 2);
  assert.deepStrictEqual(
    r.txs.map((t) => t.fund_code).sort(),
    ['001111', '002222']
  );
});
