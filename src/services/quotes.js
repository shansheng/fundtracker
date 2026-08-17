/**
 * 公共行情接口模块
 * 优先使用新浪财经公开接口，失败时回退东方财富接口。
 *
 * 新浪接口: https://hq.sinajs.cn/list=sh600519,sz000001
 *   返回: var hq_str_sh600519="贵州茅台,1500.00,1510.00,..."; 字段:
 *   [0]名称 [1]今开 [2]昨收 [3]当前价 [4]最高 [5]最低 ... [32]日期 [33]时间
 *   涨跌幅 = (当前价 - 昨收) / 昨收 * 100
 *
 * 东方财富接口: https://push2.eastmoney.com/api/qt/stock/get
 *   ?secid=1.600519&fields=f43,f44,f45,f46,f48,f57,f58,f60,f86
 */
// Node 18+ 内置 fetch

const { getDb } = require('../db/db');
const { mapLimit } = require('./concurrency');

const SINA_URL = 'https://hq.sinajs.cn/list=';
const EM_BASE = 'https://push2.eastmoney.com/api/qt/stock/get';

// Phase 2: 行情缓存(30s TTL)。内存 Map 为热路径(亚毫秒命中), stock_quote 表为持久化层(进程重启可预热)。
const QUOTE_TTL_MS = 30 * 1000;
const memCache = new Map(); // normalizeCode -> { ts, quote }
let warmLoaded = false;
let networkCalls = 0; // 诊断: 实际发出的 HTTP 行情请求次数(批量请求计为 1 次)

// 进程冷启动时, 把 30s 内未过期的行情从 stock_quote 表加载进内存, 避免重启后立刻再打网络
function warmFromDb() {
  if (warmLoaded) return;
  warmLoaded = true;
  try {
    const rows = getDb()
      .prepare(`SELECT stock_code,name,price,pct_change,ts FROM stock_quote WHERE ts IS NOT NULL AND ts > ?`)
      .all(Date.now() - QUOTE_TTL_MS);
    for (const r of rows) {
      if (r.ts == null) continue;
      memCache.set(r.stock_code, {
        ts: r.ts,
        quote: {
          stock_code: r.stock_code,
          name: r.name,
          price: r.price,
          pct_change: r.pct_change,
          updated_at: String(r.ts),
        },
      });
    }
  } catch (_) {
    /* 数据库未初始化或表不存在时静默跳过 */
  }
}

// 把最新行情写回 stock_quote 表(供持久化与后续预热); 失败静默
function persistQuote(key, q, ts) {
  try {
    getDb()
      .prepare(
        `INSERT INTO stock_quote(stock_code,name,price,pct_change,updated_at,ts)
         VALUES(@k,@n,@p,@c,datetime('now'),@ts)
         ON CONFLICT(stock_code) DO UPDATE SET
           name=@n, price=@p, pct_change=@c, updated_at=datetime('now'), ts=@ts`
      )
      .run({ k: key, n: q.name, p: q.price, c: q.pct_change, ts });
  } catch (_) {
    /* 数据库未初始化时静默跳过 */
  }
}

// 规范化股票代码为带市场前缀格式: 600519 -> sh600519, 000001 -> sz000001
//   - sh/sz/bj 已带前缀: 转小写后返回
//   - 6 开头 -> sh; 0/3 开头 -> sz; 8/4 开头 -> bj (A股/北交所)
//   - 5 位纯数字 -> hk(港股个股, 如 00700 -> hk00700)
//   - hk/gb 前缀(港股指数/美股指数)及无法识别的: 原样返回(大小写敏感, 保留原始大小写)
function normalizeCode(code) {
  if (/^(sh|sz|bj)/i.test(code)) return code.toLowerCase();
  if (/^\d{5}$/.test(code)) return 'hk' + code; // 港股个股 5 位代码
  if (code.startsWith('6')) return 'sh' + code;
  if (code.startsWith('0') || code.startsWith('3')) return 'sz' + code;
  if (code.startsWith('8') || code.startsWith('4')) return 'bj' + code;
  return code;
}

// 从带前缀代码得到东方财富 secid
function toSecid(code) {
  const c = normalizeCode(code);
  const market = c.slice(0, 2);
  const num = c.slice(2);
  const m = market === 'sh' ? 1 : market === 'sz' ? 0 : 0;
  return `${m}.${num}`;
}

// 新浪行情接口有两个坑:
//   1) 同一 list 请求里混用 A 股(sh/sz/bj) 与 港股/美股(hk/gb) 代码时, 接口直接返回空(只给 1 条甚至 0 条)。
//   2) 单请求 list= 的代码数/URL 长度有隐性上限: 一次塞 600+ 代码会直接返回空
//      (实测 611 个 A 股代码单请求返回 0 条, 全部缺失 -> 估值系统性归零)。
// 因此: 先按市场拆成 A 股组 / 港股美股组, 再在每个组内按 SINA_CHUNK 切成小块, 限并发抓取后合并。
const SINA_CHUNK = 50;        // 每块代码数(规避新浪单请求数量/URL 长度上限)
const SINA_CONCURRENCY = 3;   // 同时进行的块请求数(避免一次性十几个并行触发限流)
const EM_CONCURRENCY = 5;     // 东方财富回退并发数(顺序逐只太慢)

async function fetchFromSina(codes) {
  const aShare = [];
  const hkGb = [];
  for (const c of codes) {
    const n = normalizeCode(c);
    if (/^(hk|gb)/i.test(n)) hkGb.push(n);
    else aShare.push(n); // sh/sz/bj 及其它统一走 A 股通道
  }
  const out = {};
  // 按市场组分别切成 SINA_CHUNK 大小的块
  const chunks = [];
  const pushChunks = (arr) => {
    for (let i = 0; i < arr.length; i += SINA_CHUNK) chunks.push(arr.slice(i, i + SINA_CHUNK));
  };
  pushChunks(aShare);
  pushChunks(hkGb);
  // 限并发抓取(失败块静默, 缺失部分由 getRealtimeQuotes 后续走东方财富回退补)
  await mapLimit(chunks, SINA_CONCURRENCY, (chunk) => fetchSinaOnce(chunk, out));
  return out;
}

// 单次新浪批量请求(单一市场一组), 解析后写入 out。带 8s 超时, 避免接口无响应时无限挂起。
async function fetchSinaOnce(codes, out) {
  const list = codes.join(',');
  const res = await fetch(SINA_URL + list, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(8000),
  });
  // 新浪行情接口返回 GBK 编码(非 UTF-8)。Node 内置 TextDecoder 原生支持 'gbk',
  // 用 arrayBuffer + GBK 解码可正确还原中文名(否则 stock_quote.name 与估值明细股票名会乱码)。
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buf);
  const re = /var hq_str_(\w+)="([^"]*)";/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    // 港股(hk)/美股(gb)代码大小写敏感, 保留原始大小写作为 key; 其余转小写
    const code = /^(hk|gb)/i.test(raw) ? raw : raw.toLowerCase();
    const parts = m[2].split(',');
    const isHk = /^hk/i.test(code);
    // 美股/外股(gb_ 前缀): 新浪直接给出 [1]现价 [2]涨跌幅%, 无需昨收(与 A 股布局不同)
    if (/^gb/i.test(code)) {
      const price = parseFloat(parts[1]);
      const pct = parseFloat(parts[2]);
      if (!isFinite(price) || !isFinite(pct)) continue;
      out[code] = {
        stock_code: code,
        name: parts[0],
        price,
        pct_change: Number(pct.toFixed(2)),
        updated_at: new Date().toISOString(),
      };
      continue;
    }
    // A 股: [0]名称 [1]今开 [2]昨收 [3]当前价 ...
    // 港股: [1]名称 [2]今开 [3]昨收 [4]最高 [5]最低 [6]当前价 [7]涨跌额 [8]涨跌幅%
    const nameIdx = isHk ? 1 : 0;
    const prevIdx = isHk ? 3 : 2;
    const priceIdx = isHk ? 6 : 3;
    if (parts.length <= priceIdx || !parts[nameIdx] || !parts[prevIdx]) continue;
    const name = parts[nameIdx];
    const prevClose = parseFloat(parts[prevIdx]);
    const price = parseFloat(parts[priceIdx]);
    const pct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    out[code] = {
      stock_code: code,
      name,
      price,
      pct_change: Number(pct.toFixed(2)),
      updated_at: new Date().toISOString(),
    };
  }
}

async function fetchFromEastmoney(codes) {
  const out = {};
  const results = await mapLimit(codes, EM_CONCURRENCY, async (code) => {
    if (/^(hk|gb)/i.test(code)) return null; // 港股/美股由新浪覆盖, 东方财富对应 secid 不稳定
    const secid = toSecid(code);
    const url = `${EM_BASE}?secid=${secid}&fields=f43,f44,f45,f46,f48,f57,f58,f60,f86&invt=2&fltt=2`;
    try {
      const res = await fetch(url, {
        headers: { Referer: 'https://quote.eastmoney.com' },
        signal: AbortSignal.timeout(8000),
      });
      const json = await res.json();
      const d = json && json.data;
      if (!d || d.f43 == null) return null;
      const prevClose = d.f60;
      const price = d.f43;
      const pct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
      return {
        stock_code: normalizeCode(code),
        name: d.f58,
        price,
        pct_change: Number(pct.toFixed(2)),
        updated_at: new Date().toISOString(),
      };
    } catch (e) {
      return null; // 单只失败忽略
    }
  });
  for (const r of results) if (r) out[r.stock_code] = r;
  return out;
}

/**
 * 批量获取股票实时行情(带 30s TTL 缓存)
 * 缓存命中(内存或冷启动预热)直接返回, 不触网; 仅对缺失/过期代码发一次新浪批量请求,
 * 新浪未覆盖的再补一次东方财富批量请求。返回 map 统一以 normalizeCode 为 key。
 * @param {string[]} codes 股票代码数组
 * @returns {Promise<Object>} { code: {stock_code,name,price,pct_change,updated_at} }
 */
async function getRealtimeQuotes(codes) {
  if (!codes || !codes.length) return {};
  warmFromDb();
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const c of codes) {
    const key = normalizeCode(c);
    const hit = memCache.get(key);
    if (hit && now - hit.ts < QUOTE_TTL_MS) {
      // 命中(含负缓存: quote 为 null 表示 30s 内已确认查不到, 跳过)
      if (hit.quote) out[key] = hit.quote;
    } else {
      missing.push(c);
    }
  }
  if (missing.length) {
    let fetched = {};
    networkCalls += 1; // 计一次新浪批量请求
    try {
      fetched = await fetchFromSina(missing);
    } catch (e) {
      console.warn('新浪接口失败，回退东方财富', e.message);
    }
    // 补充新浪未覆盖部分(如东财专属 A 股代码)。只有当新浪"大面积失败"(缺失超过半数)时才跳过东财回退,
    // 避免高频打公共接口被限流; 正常的少量缺口(通常几十个)应交给东财补, 否则这些基金会缺估值。
    const miss2 = missing.filter((c) => !fetched[normalizeCode(c)]);
    if (miss2.length) {
      const catastrophic = miss2.length > missing.length * 0.5;
      if (catastrophic) {
        console.warn(`新浪缺失 ${miss2.length}/${missing.length} 个代码(超半数), 跳过东方财富回退(避免限流)`);
      } else {
        networkCalls += 1; // 计一次东方财富批量请求
        const em = await fetchFromEastmoney(miss2);
        Object.assign(fetched, em);
      }
    }
    for (const c of missing) {
      const key = normalizeCode(c);
      const q = fetched[key] || null;
      // 无论查到与否都写入缓存: 查不到的负缓存避免重复无效请求
      memCache.set(key, { ts: now, quote: q });
      if (q) {
        out[key] = q;
        persistQuote(key, q, now);
      }
    }
  }
  return out;
}

// 诊断: 返回缓存命中/网络请求统计(供测试与监控)
function getQuoteStats() {
  return { networkCalls, cacheSize: memCache.size, ttlMs: QUOTE_TTL_MS };
}

module.exports = { getRealtimeQuotes, normalizeCode, toSecid, getQuoteStats, fetchFromSina };
