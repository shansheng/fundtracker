/**
 * SQLite 本地数据库封装 (基于 sql.js WASM 版，零原生编译依赖)
 * 数据持久化到本地文件，每次写操作后导出保存。
 */
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const { classifyFundType } = require('../services/fundType');

// 数据库默认放在项目根目录，避免散落到 ~/.config 或 ~/.fundtracker 造成混淆
// 仍可用环境变量 FUNDTRACKER_DB 覆盖
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.FUNDTRACKER_DB || path.join(PROJECT_DIR, 'fundtracker.sqlite');
const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fund (
    code            TEXT PRIMARY KEY,
    name            TEXT,
    type            TEXT,
    platform        TEXT,
    latest_nav      REAL,
    nav_date        TEXT,
    updated_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS holding (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code       TEXT NOT NULL REFERENCES fund(code) ON DELETE CASCADE,
    platform        TEXT,
    shares          REAL,
    cost_amount     REAL,
    market_value    REAL,
    hold_profit     REAL,
    yest_profit     REAL,
    yest_pct        REAL,
    updated_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS fund_stock (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code       TEXT NOT NULL REFERENCES fund(code) ON DELETE CASCADE,
    report_period   TEXT,
    stock_code      TEXT,
    stock_name      TEXT,
    ratio           REAL,
    updated_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS txn (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_code       TEXT NOT NULL REFERENCES fund(code) ON DELETE CASCADE,
    platform        TEXT,
    type            TEXT,
    amount          REAL,
    shares          REAL,
    nav             REAL,
    tx_date         TEXT,
    source          TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stock_quote (
    stock_code      TEXT PRIMARY KEY,
    name            TEXT,
    price           REAL,
    pct_change      REAL,
    updated_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS screenshot_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    platform        TEXT,
    kind            TEXT,
    file_path       TEXT,
    ocr_text        TEXT,
    parsed_json     TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );
`;

let _SQL = null;
let _db = null;
let _saveTimer = null;

function appDataDir() {
  try {
    const { app } = require('electron');
    if (app && app.getPath) return app.getPath('userData');
  } catch (_) { /* not in electron */ }
  return path.join(require('os').homedir(), '.fundtracker');
}

async function init() {
  if (_db) return _db;
  const wasmPath = path.join(require.resolve('sql.js'), '..', 'sql-wasm.wasm');
  _SQL = await initSqlJs({ locateFile: () => wasmPath });
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new _SQL.Database(fileBuffer);
  } else {
    _db = new _SQL.Database();
    _db.run(SCHEMA);
    save();
  }
  // 轻量迁移: 老库补缺失列(忽略已存在)
  const migrateSql = [
    'ALTER TABLE holding ADD COLUMN hold_profit REAL',
    'ALTER TABLE holding ADD COLUMN yest_profit REAL',
    'ALTER TABLE holding ADD COLUMN yest_pct REAL',
    // fund_stock 唯一约束: 同一基金同一股票只保留一条, 防止持仓重复
    'CREATE UNIQUE INDEX IF NOT EXISTS uniq_fund_stock ON fund_stock(fund_code,stock_code)',
    // Phase 1: 联接/QDII 基金跟踪指数代码(用于指数代理盘中估值)。例如 hkHSTECH=恒生科技
    'ALTER TABLE fund ADD COLUMN track_index TEXT',
    // Phase 2: 复活 stock_quote 作为行情缓存, ts 存 epoch ms 用于 30s TTL 判定与冷启动预热
    'ALTER TABLE stock_quote ADD COLUMN ts INTEGER',
    // 交易份额回填: 记录算份额所采用的净值日期(申购 15:00 前用 T 日净值, 15:00 后用 T+1 净值)
    'ALTER TABLE txn ADD COLUMN nav_date TEXT',
  ];
  for (const sql of migrateSql) {
    try { _db.run(sql); } catch (e) { /* 列已存在则忽略 */ }
  }
  // Phase 1 种子: 为已知的两只 QDII 联接基金填充跟踪指数(仅当为空时, 不覆盖用户手动设置)
  // 012348 天弘恒生科技ETF联接 -> 恒生科技指数; 014424 博时恒生医疗保健ETF联接 -> 恒生医疗保健指数
  const seedTrack = [
    ["012348", "hkHSTECH"],
    ["014424", "hkHSHCI"],
  ];
  for (const [code, idx] of seedTrack) {
    try {
      _db.run(
        `UPDATE fund SET track_index=? WHERE code=? AND (track_index IS NULL OR track_index='')`,
        [idx, code]
      );
    } catch (e) { /* 基金不存在则忽略 */ }
  }
  // Phase 4: 为有持仓但缺基准指数的"权益类"基金补齐默认宽基基准(沪深300)，
  // 供估算引擎代理"季报未披露仓位"的涨跌(见 estimator 路径1 的 residual 补齐)。
  // 排除债券/货币/QDII: 债券/现金 ≈ 0 波动、QDII 持有海外资产不跟踪 A 股宽基，强行补齐反而失真。
  // 注意: fund.type 不可靠(债券常被误标为"其他")，故同时用名称关键词兜底排除债券/货基/QDII。
  // SQLite(WASM) 无 REGEXP 扩展，候选行取出后在 JS 端按名称正则过滤，再逐只幂等 UPDATE。
  try {
    // 名称含"债"字(债券/双利债/股债配置等)一律视为债券或偏债, 不设置权益基准;
    // 债券/货基/QDII 的剩余仓位不跟踪 A 股宽基, 强行补齐反而失真。
    const NON_EQUITY_RE = /(债|货币|理财|QDII|合格境内|沪港通|深港通|港股通|沪港深)/i;
    // 注意: _db 是原始 sql.js Database, 无 prepare().all(); 用模块内 all() 辅助查询
    const candidates = all(
      `SELECT f.code, f.name, f.type FROM fund f
       WHERE (f.track_index IS NULL OR f.track_index='')
         AND f.code IN (SELECT DISTINCT fund_code FROM fund_stock)
         AND COALESCE(f.type,'') NOT IN ('债券型','货币型','QDII')`
    );
    let benchN = 0;
    for (const c of candidates) {
      if (c.name && NON_EQUITY_RE.test(c.name)) continue; // 债券/货基/海外 -> 不设置权益基准
      _db.run(
        `UPDATE fund SET track_index='sh000300' WHERE code=? AND (track_index IS NULL OR track_index='')`,
        [c.code]
      );
      benchN++;
    }
    if (benchN > 0) {
      console.log(`[db] 已为 ${benchN} 只权益类持仓基金补齐默认基准指数 sh000300(沪深300)`);
    }
  } catch (e) {
    console.warn('[db] 补齐默认基准指数失败(可忽略):', e.message);
  }
  // Phase 3: 离线回填 fund.type。对"type 为空且 name 非空"的基金, 按名称关键词分类。
  // 在线刷新(fundInfo.getFundBase 返回东财 fundtype)为权威来源, 此处仅作离线兜底。
  // 使用模块内 all/run 辅助(它们在 sql.js 原始 Db 上操作, 不依赖 getDb 初始化顺序)。
  try {
    const toBackfill = all(
      `SELECT code,name FROM fund WHERE (type IS NULL OR type='') AND name IS NOT NULL AND name<>''`
    );
    for (const r of toBackfill) {
      const t = classifyFundType(r.name);
      if (t) run(`UPDATE fund SET type=? WHERE code=?`, [t, r.code]);
    }
  } catch (e) {
    console.warn('fund.type 离线回填失败(可忽略):', e.message);
  }
  save();
  // 诊断日志：明确告知数据库文件路径与已加载数据量，便于排查"无数据"类问题
  try {
    const fundCount = all('SELECT COUNT(*) AS c FROM fund')[0].c;
    const holdingCount = all('SELECT COUNT(*) AS c FROM holding')[0].c;
    console.log(`[db] 数据库文件: ${DB_PATH} (${fs.existsSync(DB_PATH) ? '已加载现有库' : '新建空库'})`);
    console.log(`[db] 已加载 fund=${fundCount} 条, holding=${holdingCount} 条`);
  } catch (e) {
    console.warn('[db] 统计日志失败(可忽略):', e.message);
  }
  return _db;
}

function getDb() {
  if (!_db) throw new Error('数据库未初始化，请先调用 init()');
  return compatDb(_db);
}

/**
 * 兼容层：模拟 better-sqlite3 的 prepare().run()/.all()/.get()/.transaction()
 * 以便业务代码以熟悉方式调用。接收原始 sql.js Database，避免递归调用 getDb()。
 */
function compatDb(raw) {
  // 每次调用都重新 prepare，复用同一 sql 字符串，避免 statement 被 free 后无法复用
  const prepareStmt = (sql) => {
    const s = raw.prepare(sql);
    // 兼容 better-sqlite3 参数风格：
    //   .run({named})                 -> 命名参数对象
    //   .run(a, b, c)                 -> 位置参数列表
    //   .run(single)                  -> 单个位置参数
    //   .run([a, b, c])               -> 位置参数数组
    const bindArgs = (args) => {
      if (!args || args.length === 0) return;
      if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
        // 命名参数对象 -> 转成 sql.js 接受的 { '@name': value } 形式一次性绑定
        const obj = {};
        Object.entries(args[0]).forEach(([k, v]) => { obj[k.startsWith('@') ? k : '@' + k] = v; });
        s.bind(obj);
        return;
      }
      // 位置参数: sql.js 数组绑定按位置顺序, 直接传值数组(不能逐次 bind [index,value])
      const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      s.bind(list);
    };
    return {
      run(...params) {
        bindArgs(params);
        s.step();
        s.free();
        saveDebounced();
        return api;
      },
      all(...params) {
        bindArgs(params);
        const out = [];
        while (s.step()) out.push(s.getAsObject());
        s.free();
        return out;
      },
      get(...params) {
        return this.all(...params)[0] || undefined;
      },
    };
  };
  let api = {
    prepare(sql) {
      return prepareStmt(sql);
    },
    transaction(fn) {
      return (...args) => {
        raw.run('BEGIN');
        try {
          const r = fn(...args);
          raw.run('COMMIT');
          saveDebounced();
          return r;
        } catch (e) {
          raw.run('ROLLBACK');
          throw e;
        }
      };
    },
    pragma() {},
  };
  return api;
}

// 立即持久化到磁盘
function save() {
  if (!_db) return;
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// 防抖保存，避免高频写
function saveDebounced() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(save, 300);
}

// 简单查询辅助：返回对象数组
function all(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}
function get(sql, params = []) {
  const r = all(sql, params);
  return r[0] || null;
}
function run(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  stmt.step();
  stmt.free();
  saveDebounced();
}

module.exports = { init, getDb, all, get, run, save, DB_PATH, PROJECT_DIR };
