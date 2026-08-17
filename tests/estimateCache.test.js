// 估值缓存模块测试: 验证首帧为 null、首次重算填充缓存、单飞复用、TTL 新鲜度、强制重算更新。
// 用临时 SQLite(经 init 建表), estimatePortfolio 在空持仓下返回 funds:[] 不触网。
process.env.FUNDTRACKER_DB = require('path').join(
  require('os').tmpdir(),
  `ft_cache_${Date.now()}.sqlite`
);
const { init } = require('../src/db/db');
const {
  compute,
  getCachedSnapshot,
  getStatus,
  triggerRefresh,
  isFresh,
} = require('../src/services/estimateCache');
const test = require('node:test');
const assert = require('node:assert');

test.before(async () => {
  await init();
});

test('getCachedSnapshot 初始为 null(尚无重算)', () => {
  assert.strictEqual(getCachedSnapshot(), null);
  assert.strictEqual(getStatus().computing, false);
});

test('compute(true) 首次重算并填充缓存', async () => {
  const data = await compute(true);
  assert.ok(data, '应返回估值结果对象');
  assert.ok(Array.isArray(data.funds), 'funds 应为数组');
  assert.ok(data.total, 'total 应存在');
  assert.ok(getCachedSnapshot(), '缓存应已填充');
  assert.strictEqual(isFresh(), true, '新鲜度应为 true');
});

test('compute 单飞: 并发调用复用同一 Promise', async () => {
  const p1 = compute(true);
  const p2 = compute(true);
  assert.strictEqual(p1, p2, '并发 compute 应复用同一 Promise(单飞守卫)');
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1, r2, '两次调用结果应为同一对象');
});

test('triggerRefresh(false) 缓存新鲜时不报错、不重算', async () => {
  await assert.doesNotReject(async () => { triggerRefresh(false); });
  assert.strictEqual(isFresh(), true);
});

test('triggerRefresh(true) 强制重算生成新缓存对象', async () => {
  const before = getCachedSnapshot();
  const c0 = getStatus().triggerCount;
  triggerRefresh(true);
  await compute(true); // 等待强制重算完成
  const after = getCachedSnapshot();
  assert.ok(after, '重算后缓存非空');
  assert.notStrictEqual(before, after, '强制重算应产生新的缓存对象(新时间戳)');
  assert.ok(getStatus().triggerCount > c0, 'triggerCount 应增加');
});
