/**
 * 本地后端服务 (Express)
 * 提供：基金/持仓/交易/行情/估算 等 REST API
 * 监听 127.0.0.1:3456，仅本地访问。
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDb, init, save } = require('../db/db');
const { backfillTxnShares } = require('../services/txnShares');
const WEB_DIR = path.join(__dirname, '../../web');
const { recognizeScreenshot, resolveNames } = require('../services/ocr');
const { searchFundByName } = require('../services/fundInfo');
const { estimatePortfolio, estimateFund, refreshFundInfo } = require('../services/estimator');
const { getRealtimeQuotes, normalizeCode } = require('../services/quotes');
const { getCachedSnapshot, getStatus, triggerRefresh } = require('../services/estimateCache');
const { mapLimit, sleep } = require('../services/concurrency');

const app = express();
app.use(express.json({ limit: '20mb' }));

const router = express.Router();

// ---- 健康 ----
router.get('/health', (req, res) => res.json({ ok: true }));

// ---- 基金列表 ----
router.get('/funds', (req, res) => {
  const rows = getDb()
    .prepare(`SELECT * FROM fund ORDER BY updated_at DESC`)
    .all();
  res.json(rows);
});

// ---- 添加/更新基金(手动录入) ----
router.post('/funds', (req, res) => {
  const { code, name, type, platform, latest_nav, nav_date } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  getDb()
    .prepare(
      `INSERT INTO fund(code,name,type,platform,latest_nav,nav_date,updated_at)
       VALUES(@code,@name,@type,@platform,@latest_nav,@nav_date,datetime('now'))
       ON CONFLICT(code) DO UPDATE SET name=@name,type=@type,platform=@platform,latest_nav=@latest_nav,nav_date=@nav_date,updated_at=datetime('now')`
    )
    .run({ code, name: name || '', type: type || '', platform: platform || '', latest_nav: latest_nav || null, nav_date: nav_date || null });
  res.json({ ok: true });
});

// ---- 设置基金跟踪指数(联接/QDII 基金指数代理估值) ----
router.put('/funds/:code/track-index', (req, res) => {
  const { code } = req.params;
  const raw = (req.body && req.body.track_index ? String(req.body.track_index).trim() : '');
  // 新浪港股指数大小写敏感: 必须 hk(小写) + 大写代码(如 hkHSTECH); A 股指数用小写前缀(如 sh000300)
  let idx;
  if (/^hk/i.test(raw)) idx = 'hk' + raw.slice(2).toUpperCase();
  else idx = raw.toLowerCase();
  if (!/^[A-Za-z0-9_]{2,14}$/.test(idx)) {
    return res.status(400).json({ error: 'track_index 格式非法(仅允许字母数字与下划线, 2-14位, 如 hkHSTECH/gb_ixic)' });
  }
  const exists = getDb().prepare(`SELECT code FROM fund WHERE code=?`).get(code);
  if (!exists) return res.status(404).json({ error: '基金不存在' });
  getDb().prepare(`UPDATE fund SET track_index=? WHERE code=?`).run(idx, code);
  res.json({ ok: true, code, track_index: idx });
});

// ---- 刷新基金基础信息 + 持仓股票(季报/年报) ----
router.post('/funds/:code/refresh', async (req, res) => {
  try {
    const r = await refreshFundInfo(req.params.code);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 批量刷新所有持仓基金的净值(用于主界面"刷新净值"按钮)
// 异步 + 限流: 立即返回, 后台以有限并发刷新东方财富(避免被公共接口限流); 前端轮询进度。
let refreshJob = null; // 仅保留最近一次任务状态(单用户本地场景足够)
const REFRESH_CONCURRENCY = 4; // 对东方财富最大并发
const REFRESH_GAP_MS = 150;    // 每只之间的间隔, 进一步降低被限流概率
router.post('/funds/refresh-all', (req, res) => {
  if (refreshJob && !refreshJob.finished) {
    return res.json({ ok: true, started: false, alreadyRunning: true, jobId: refreshJob.id });
  }
  const codes = [...new Set(
    getDb().prepare(`SELECT DISTINCT fund_code FROM holding`).all().map((r) => r.fund_code)
  )];
  const job = {
    id: Date.now(),
    total: codes.length,
    done: 0,
    ok: 0,
    failed: 0,
    results: [],
    finished: false,
    startedAt: Date.now(),
    error: null,
  };
  refreshJob = job;
  // 后台异步执行(不等完成即返回 202 语义)
  (async () => {
    try {
      job.results = await mapLimit(codes, REFRESH_CONCURRENCY, async (code) => {
        await sleep(REFRESH_GAP_MS); // 限流: 控制请求频率
        try {
          await refreshFundInfo(code);
          job.ok++;
          return { code, ok: true };
        } catch (e) {
          job.failed++;
          return { code, ok: false, error: e.message };
        } finally {
          job.done++;
        }
      });
    } catch (e) {
      job.error = e.message;
    } finally {
      job.finished = true;
      // 净值刷新完成后, 触发一次估算后台重算(让新净值进入实时估值)
      triggerRefresh(true);
    }
  })();
  res.json({ ok: true, started: true, jobId: job.id, total: codes.length });
});

// 刷新净值任务进度轮询(前端"刷新中 N/total"用)
router.get('/funds/refresh-all/status', (req, res) => {
  if (!refreshJob) return res.json({ running: false, total: 0, done: 0, ok: 0, failed: 0 });
  res.json({
    running: !refreshJob.finished,
    total: refreshJob.total,
    done: refreshJob.done,
    ok: refreshJob.ok,
    failed: refreshJob.failed,
  });
});

// ---- 持仓列表 ----
router.get('/holdings', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT h.*, f.name as fund_name, f.latest_nav
       FROM holding h LEFT JOIN fund f ON f.code=h.fund_code ORDER BY h.updated_at DESC`
    )
    .all();
  res.json(rows);
});

// ---- 更新持仓(手动/确认后写入) ----
router.post('/holdings', (req, res) => {
  const { fund_code, platform, shares, cost_amount, market_value, hold_profit, yest_profit, yest_pct } = req.body;
  if (!fund_code) return res.status(400).json({ error: 'fund_code required' });
  // 若只给了市值(持仓金额)而没给份额, 用最新净值反算份额: shares = market_value / latest_nav
  let finalShares = shares ?? null;
  let finalCost = cost_amount ?? null;
  if ((finalShares == null) && market_value != null) {
    const f = getDb().prepare(`SELECT latest_nav FROM fund WHERE code=?`).get(fund_code);
    const nav = f && f.latest_nav;
    if (nav && nav > 0) {
      finalShares = Number((market_value / nav).toFixed(4));
      // 成本默认用市值近似(无买入价时)
      if (finalCost == null) finalCost = market_value;
    }
  }
  const hp = hold_profit != null ? Number(hold_profit) : null;
  const yp = yest_profit != null ? Number(yest_profit) : null;
  const yc = yest_pct != null ? Number(yest_pct) : null;
  // 按 fund_code 唯一 upsert(平台仅作附加信息, 避免平台名不一致导致重复插入)
  const existing = getDb()
    .prepare(`SELECT id FROM holding WHERE fund_code=?`)
    .get(fund_code);
  if (existing) {
    // 份额是固定的: 仅当本次明确传入份额(或首次导入反算成功)时才更新, 否则保留原值
    const keepShares = finalShares != null ? finalShares : existing.shares;
    getDb()
      .prepare(
        `UPDATE holding SET shares=@shares, cost_amount=@cost_amount, market_value=@market_value,
                hold_profit=@hold_profit, yest_profit=@yest_profit, yest_pct=@yest_pct, updated_at=datetime('now')
         WHERE id=@id`
      )
      .run({ shares: keepShares, cost_amount: finalCost, market_value: market_value ?? null,
             hold_profit: hp, yest_profit: yp, yest_pct: yc, id: existing.id });
  } else {
    getDb()
      .prepare(
        `INSERT INTO holding(fund_code,platform,shares,cost_amount,market_value,hold_profit,yest_profit,yest_pct,updated_at)
         VALUES(@fund_code,@platform,@shares,@cost_amount,@market_value,@hold_profit,@yest_profit,@yest_pct,datetime('now'))`
      )
      .run({ fund_code, platform: platform || null, shares: finalShares, cost_amount: finalCost,
             market_value: market_value ?? null, hold_profit: hp, yest_profit: yp, yest_pct: yc });
  }
  res.json({ ok: true, shares: finalShares });
});

// 删除某基金的持仓(同时清理该基金持仓股, 但保留 fund 基础信息)
router.delete('/holdings/:code', (req, res) => {
  try {
    const code = req.params.code;
    const db = getDb();
    const info = db.prepare(`SELECT id FROM holding WHERE fund_code=?`).get(code);
    if (!info) return res.json({ ok: true, deleted: 0, message: '无该基金持仓' });
    db.prepare(`DELETE FROM holding WHERE fund_code=?`).run(code);
    db.prepare(`DELETE FROM fund_stock WHERE fund_code=?`).run(code);
    res.json({ ok: true, deleted: 1 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 交易记录 ----
router.get('/transactions', (req, res) => {
  const rows = getDb()
    .prepare(`SELECT * FROM txn ORDER BY tx_date DESC, created_at DESC`)
    .all();
  res.json(rows);
});

router.post('/transactions', (req, res) => {
  const { fund_code, platform, type, amount, shares, nav, tx_date, source } = req.body;
  if (!fund_code) return res.status(400).json({ error: 'fund_code required' });
  getDb()
    .prepare(
      `INSERT INTO txn(fund_code,platform,type,amount,shares,nav,tx_date,source,created_at)
       VALUES(@fund_code,@platform,@type,@amount,@shares,@nav,@tx_date,@source,datetime('now'))`
    )
    .run({ fund_code, platform: platform || null, type: type || 'buy', amount: amount ?? null, shares: shares ?? null, nav: nav ?? null, tx_date: tx_date || null, source: source || 'manual' });
  res.json({ ok: true });
});

// 回填交易份额: 对"有金额/日期但份额为空"的交易, 按交易日+15:00规则取历史净值算份额
// 可选 body.source 仅回填指定来源(如 'ocr_alipay_trade'); 用有限并发限制公共接口频率
router.post('/transactions/backfill-shares', async (req, res) => {
  try {
    const { source } = req.body || {};
    const db = getDb();
    const result = await backfillTxnShares(db, { source });
    save();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 实时估算(整个组合) ----
// 异步优化: 立即返回内存缓存的估值(毫秒级), 同时后台触发重算; 前端据 computing 标志轮询补齐。
// 30s 内多次刷新只重算一次, 避免重复打新浪行情被限流。首屏无缓存时返回 computing:true 占位。
router.get('/estimate', (req, res) => {
  const cached = getCachedSnapshot();
  const status = getStatus();
  triggerRefresh(false); // 缺失/过期则后台重算(非阻塞)
  if (cached) {
    res.json({ ...cached, computing: status.computing, cached_at: status.cachedAt });
  } else {
    res.json({ computing: true, total: {}, funds: [], cached_at: null });
  }
});

// ---- 单基金估算 ----
router.get('/funds/:code/estimate', async (req, res) => {
  try {
    const data = await estimateFund(req.params.code);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 基金名称 -> 代码 搜索 ----
router.post('/fund-search', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const list = await searchFundByName(name);
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 实时行情(批量, 传入逗号分隔股票代码) ----
router.get('/quotes', async (req, res) => {
  try {
    const codes = (req.query.codes || '').split(',').filter(Boolean);
    const data = await getRealtimeQuotes(codes);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 基金持仓股票 ----
router.get('/funds/:code/stocks', (req, res) => {
  const rows = getDb()
    .prepare(`SELECT * FROM fund_stock WHERE fund_code=? ORDER BY ratio DESC`)
    .all(req.params.code);
  res.json(rows);
});

// ---- 截图 OCR 识别 ----
router.post('/ocr', async (req, res) => {
  const { file_path, platform, kind } = req.body;
  if (!file_path) return res.status(400).json({ error: 'file_path required' });
  try {
    const result = await recognizeScreenshot(file_path, platform || 'alipay', kind || 'holding');
    // 支付宝持仓截图通常只有名称无代码: 自动按名称查代码补全
    await resolveNames(result);
    // 记录日志
    getDb()
      .prepare(
        `INSERT INTO screenshot_log(platform,kind,file_path,ocr_text,parsed_json,created_at)
         VALUES(?,?,?,?,?,datetime('now'))`
      )
      .run(platform, kind, file_path, result.ocr_text, JSON.stringify(result));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    // 无论识别成败都清理临时截图, 避免磁盘堆积 / 被复用
    try { fs.unlinkSync(file_path); } catch (_) {}
  }
});

// ---- 上传截图文件(OCR 前置) ----
// 安全加固(Phase 0): 扩展名/Content-Type 白名单 + 大小上限 + 随机文件名 + 魔数校验
const UPLOAD_DIR = path.join(require('../db/db').PROJECT_DIR, 'screenshots');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
const ALLOWED_UPLOAD_TYPES = new Set([
  'application/octet-stream', 'image/png', 'image/jpeg', 'image/webp'
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

// 校验图片文件魔数, 防止伪装成图片的可执行文件落地
function isImageMagic(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // WEBP: 52 49 46 46(RIFF) ... 57 45 42 50(WEBP)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

app.post('/api/upload', express.raw({
  type: (req) => {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    return ALLOWED_UPLOAD_TYPES.has(ct);
  },
  limit: MAX_UPLOAD_BYTES
}), (req, res) => {
  try {
    const ext = String(req.query.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ALLOWED_EXT.has(ext)) {
      return res.status(400).json({ error: '不支持的文件类型，仅允许 png/jpg/jpeg/webp' });
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!buf.length) return res.status(400).json({ error: '空文件' });
    if (!isImageMagic(buf)) {
      return res.status(400).json({ error: '文件内容不是合法的图片（PNG/JPEG/WEBP）' });
    }
    // 随机化文件名, 避免可预测路径 / 文件覆盖; 仅使用白名单内的扩展名
    const fname = `shot_${crypto.randomUUID()}.${ext}`;
    const fpath = path.join(UPLOAD_DIR, fname);
    fs.writeFileSync(fpath, buf);
    res.json({ file_path: fpath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use('/api', router);

// 前端静态资源
app.use(express.static(WEB_DIR));

let server = null;
async function startServer() {
  await init();
  return new Promise((resolve) => {
    server = app.listen(3456, '127.0.0.1', () => {
      console.log('FundTracker API 已启动: http://127.0.0.1:3456/api');
      resolve(server);
    });
  });
}
function stopServer() {
  if (server) server.close();
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, stopServer, app };
