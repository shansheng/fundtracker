/**
 * 极简并发控制工具(零依赖)，用于"刷新全部净值"时对东方财富公共接口的限流保护。
 */

// Promise 版 sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 以最多 limit 个并发遍历 items, 对每个元素调用 fn(item, index)。
 * - 结果按原始顺序返回(长度 === items.length), 不抛异常: 单项错误被捕获为 { error }
 * - 适合"对 N 个外部接口依次调用但限制并发"的场景, 避免瞬间打满公共接口被限流。
 * @param {Array} items
 * @param {number} limit 最大并发数(>=1)
 * @param {(item:any, index:number) => Promise<any>} fn
 * @returns {Promise<any[]>}
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const cur = cursor++;
      try {
        results[cur] = await fn(items[cur], cur);
      } catch (e) {
        results[cur] = { error: e && e.message ? e.message : String(e) };
      }
    }
  }
  const n = Math.max(1, Math.min(limit || 1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

module.exports = { sleep, mapLimit };
