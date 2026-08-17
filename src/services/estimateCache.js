/**
 * 估值结果内存缓存 + 单飞(single-flight)重算守卫。
 *
 * 解决的问题:
 *   1. 首页 GET /estimate 原先是"同步阻塞"——浏览器要等后端跑完整组合估算(含新浪行情抓取)
 *      才返回, 首屏需等待 1~3 秒。改为: 路由立即返回已缓存的结果(毫秒级),
 *      真正的组合估算在后台异步进行, 前端拿到 computing 标志后轮询补齐最新值。
 *   2. 公共接口(Sina 行情)限流: 缓存有效期 TTL 内多次刷新只触发一次重算, 每次重算也仅
 *      打一次新浪批量行情(quotes.js 内部已把全组合代码合并为 1 个请求), 30s 内最多 1 次网络。
 *
 * 单飞(single-flight): 同一时刻只允许一个 estimatePortfolio 在跑; 并发请求复用同一个 Promise,
 * 避免重复计算/重复打网络。
 */
const { estimatePortfolio } = require('./estimator');

const TTL_MS = 25 * 1000; // 缓存有效期: 盘中每 25s 至多重算一次

let cache = null;        // { data, ts }
let computing = null;    // 进行中的重算 Promise(单飞)
let lastError = null;
let triggerCount = 0;    // 诊断用: 触发重算次数

function isFresh() {
  return cache && Date.now() - cache.ts < TTL_MS;
}

// 注: 本函数刻意不用 async(否则 early-return 也会包一层新 wrapper Promise, 破坏单飞引用相等)。
function compute(force = false) {
  // 单飞: 已有重算在进行, 直接返回同一 Promise, 不重复打网络/计算
  if (computing) return computing;
  if (isFresh() && !force) return Promise.resolve(cache ? cache.data : null);
  computing = (async () => {
    try {
      const data = await estimatePortfolio();
      cache = { data, ts: Date.now() };
      lastError = null;
      return data;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      // 重算失败: 保留旧缓存(若有), 不让首页变空白
      return cache ? cache.data : null;
    } finally {
      computing = null;
    }
  })();
  return computing;
}

// 非阻塞触发后台重算(若缺失/过期, 或强制)。首页请求即时返回, 重算在后台跑。
function triggerRefresh(force = false) {
  if (isFresh() && !force) return; // 仍新鲜, 无需重算
  triggerCount++;
  compute(force).catch(() => {});
}

function getCachedSnapshot() {
  return cache ? cache.data : null;
}

function getStatus() {
  return {
    computing: !!computing,
    cachedAt: cache ? cache.ts : null,
    fresh: isFresh(),
    lastError,
    triggerCount,
    ttlMs: TTL_MS,
  };
}

module.exports = { getCachedSnapshot, getStatus, triggerRefresh, compute, isFresh, TTL_MS };
