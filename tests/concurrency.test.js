// 并发池工具测试: 验证 mapLimit 限制最大并发、结果按序、单项错误隔离、sleep 正常。
const { mapLimit, sleep } = require('../src/services/concurrency');
const test = require('node:test');
const assert = require('node:assert');

test('sleep 在约定期限后 resolve', async () => {
  const t0 = Date.now();
  await sleep(30);
  assert.ok(Date.now() - t0 >= 25, 'sleep 应至少等待 ~30ms');
});

test('mapLimit: 并发不超过上限, 结果按原序, 单项错误被隔离', async () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const limit = 3;
  let running = 0;
  let maxConcurrent = 0;
  const results = await mapLimit(items, limit, async (x) => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    try {
      await sleep(15);
      if (x === 5) throw new Error('boom'); // 单项异常, 不应中断其它项
      return x * 2;
    } finally {
      running--;
    }
  });
  assert.ok(maxConcurrent <= limit, `峰值并发 ${maxConcurrent} 应 <= ${limit}`);
  assert.strictEqual(results.length, items.length, '结果长度应与输入一致');
  // 顺序保留; 异常项被捕获为 { error }
  assert.deepStrictEqual(
    results.map((r) => (r && r.error ? 'ERR' : r)),
    [0, 2, 4, 6, 8, 'ERR', 12, 14, 16, 18]
  );
});

test('mapLimit: 空数组返回空数组', async () => {
  const r = await mapLimit([], 4, async () => 1);
  assert.deepStrictEqual(r, []);
});

test('mapLimit: limit 大于数组长度时正常', async () => {
  const r = await mapLimit([1, 2], 10, async (x) => x + 1);
  assert.deepStrictEqual(r, [2, 3]);
});
