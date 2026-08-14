// 估算引擎测试: 使用临时 SQLite 文件, 通过传入 mock quotes 避免任何网络请求。
process.env.FUNDTRACKER_DB = require('path').join(
  require('os').tmpdir(),
  `ft_test_${Date.now()}.sqlite`
);
const { init, getDb } = require('../src/db/db');
const {
  estimateFund,
  parseReportPeriod,
  isReportStale,
  isMarketOpen,
} = require('../src/services/estimator');
const test = require('node:test');
const assert = require('node:assert');

test.before(async () => {
  await init();
  const db = getDb();
  // 股票加权基金 + 重仓股
  db.prepare(`INSERT OR IGNORE INTO fund(code,name,type) VALUES(?,?,?)`).run(
    'TEST01', '测试股票基金', '股票型'
  );
  db.prepare(
    `INSERT OR IGNORE INTO fund_stock(fund_code,stock_code,stock_name,ratio,report_period)
     VALUES(?,?,?,?,?)`
  ).run('TEST01', '600519', '贵州茅台', 10.0, '2026年第一季度');
  // 指数代理基金 (有 track_index, 无重仓股)
  db.prepare(`INSERT OR IGNORE INTO fund(code,name,track_index) VALUES(?,?,?)`).run(
    'TEST02', '测试QDII', 'hkHSTECH'
  );
  // 不支持盘中估值 (无重仓股, 无 track_index)
  db.prepare(`INSERT OR IGNORE INTO fund(code,name) VALUES(?,?)`).run(
    'TEST03', '测试债基'
  );
});

test('parseReportPeriod: 2026年第一季度 -> {2026,3}', () => {
  assert.deepStrictEqual(parseReportPeriod('2026年第一季度'), { year: 2026, month: 3 });
});

test('parseReportPeriod: 旧格式 2019Q3 -> {2019,9}', () => {
  assert.deepStrictEqual(parseReportPeriod('2019Q3'), { year: 2019, month: 9 });
});

test('isReportStale: 过期报告期 -> true', () => {
  assert.strictEqual(isReportStale('2019Q3'), true);
});

test('isReportStale: 当期报告期 -> false', () => {
  assert.strictEqual(isReportStale('2026年第一季度'), false);
});

test('isMarketOpen: 周六 -> false', () => {
  // 2026-08-15 是周六
  assert.strictEqual(isMarketOpen(new Date('2026-08-15T12:00:00')), false);
});

test('isMarketOpen: 工作日盘中 -> true', () => {
  // 2026-08-14 是周五, 10:30 在交易时段
  assert.strictEqual(isMarketOpen(new Date('2026-08-14T10:30:00')), true);
});

test('estimateFund 路径1: 重仓股加权', async () => {
  const quotes = {
    sh600519: { stock_code: 'sh600519', name: '贵州茅台', pct_change: 2.5 },
  };
  const est = await estimateFund('TEST01', quotes);
  assert.strictEqual(est.method, 'stock');
  assert.strictEqual(est.pct, 0.25); // 10% * 2.5%
  assert.strictEqual(est.stocks.length, 1);
  assert.strictEqual(est.intraday_supported, true);
  assert.strictEqual(est.holdings_stale, false);
});

test('estimateFund 路径2: 跟踪指数代理', async () => {
  const quotes = {
    hkHSTECH: { stock_code: 'hkHSTECH', name: '恒生科技', pct_change: -1.5 },
  };
  const est = await estimateFund('TEST02', quotes);
  assert.strictEqual(est.method, 'index');
  assert.strictEqual(est.index_code, 'hkHSTECH');
  assert.strictEqual(est.pct, -1.5);
  assert.strictEqual(est.intraday_supported, true);
});

test('estimateFund 路径3: 不支持盘中估值 -> pct=null', async () => {
  const est = await estimateFund('TEST03', {});
  assert.strictEqual(est.method, 'none');
  assert.strictEqual(est.pct, null);
  assert.strictEqual(est.intraday_supported, false);
});
