const { normalizeCode } = require('../src/services/quotes');
const test = require('node:test');
const assert = require('node:assert');

test('normalizeCode: A 股主板 6 开头 -> sh', () => {
  assert.strictEqual(normalizeCode('600519'), 'sh600519');
});

test('normalizeCode: 深市 0/3 开头 -> sz', () => {
  assert.strictEqual(normalizeCode('000001'), 'sz000001');
  assert.strictEqual(normalizeCode('300750'), 'sz300750');
});

test('normalizeCode: 北交所 8/4 开头 -> bj', () => {
  assert.strictEqual(normalizeCode('830799'), 'bj830799');
  assert.strictEqual(normalizeCode('430047'), 'bj430047');
});

test('normalizeCode: 已带 sh/sz/bj 前缀转小写', () => {
  assert.strictEqual(normalizeCode('SH600519'), 'sh600519');
  assert.strictEqual(normalizeCode('SZ000001'), 'sz000001');
});

test('normalizeCode: 港股指数保留原始大小写 (hkHSTECH)', () => {
  // 新浪港股指数大小写敏感, 必须原样保留
  assert.strictEqual(normalizeCode('hkHSTECH'), 'hkHSTECH');
  assert.strictEqual(normalizeCode('hkHSHCI'), 'hkHSHCI');
});

test('normalizeCode: 美股指数保留下划线 (gb_ixic)', () => {
  assert.strictEqual(normalizeCode('gb_ixic'), 'gb_ixic');
});

test('normalizeCode: 5 位纯数字 -> 港股个股 hk 前缀 (00700 -> hk00700)', () => {
  assert.strictEqual(normalizeCode('00700'), 'hk00700');
});

test('normalizeCode: 港股个股已带 hk 前缀则原样返回', () => {
  assert.strictEqual(normalizeCode('hk00700'), 'hk00700');
});

test('normalizeCode: 不应把 A 股 6 位代码误判为港股', () => {
  assert.notStrictEqual(normalizeCode('007000'), 'hk007000');
  assert.strictEqual(normalizeCode('007000'), 'sz007000');
});

// 还原真实 fetch, 避免污染其它测试(本文件其它用例不依赖网络)
test('fetchFromSina: 大列表按块拆分请求并合并(规避新浪单请求上限)', async () => {
  const { fetchFromSina } = require('../src/services/quotes');
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const listPart = url.split('list=')[1];
    const codes = listPart.split(',');
    let body = '';
    for (const c of codes) body += `var hq_str_${c}="NAME,100,100,110,...";`;
    return { arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
  try {
    const codes = [];
    for (let i = 0; i < 120; i++) codes.push('sh' + (600000 + i));
    const out = await fetchFromSina(codes);
    // 120 个 A 股代码, SINA_CHUNK=50 -> 至少 2 块(验证分块, 而非一次巨请求把新浪打空)
    assert.ok(calls.length >= 2, `应拆分为多次请求, 实际 ${calls.length} 次`);
    assert.strictEqual(Object.keys(out).length, 120, '应合并返回全部 120 个代码');
    for (const url of calls) {
      const n = url.split('list=')[1].split(',').length;
      assert.ok(n <= 50, `单块不应超过 50, 实际 ${n}`);
    }
  } finally {
    global.fetch = realFetch;
  }
});
