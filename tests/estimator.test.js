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
  // 股票加权基金 + 重仓股 (无基准指数: 剩余仓位不补齐)
  db.prepare(`INSERT OR IGNORE INTO fund(code,name,type) VALUES(?,?,?)`).run(
    'TEST01', '测试股票基金', '股票型'
  );
  db.prepare(
    `INSERT OR IGNORE INTO fund_stock(fund_code,stock_code,stock_name,ratio,report_period)
     VALUES(?,?,?,?,?)`
  ).run('TEST01', '600519', '贵州茅台', 10.0, '2026年第一季度');
  // 股票加权基金 + 重仓股 + 基准指数(用于校验"剩余仓位按指数补齐")
  db.prepare(`INSERT OR IGNORE INTO fund(code,name,type,track_index) VALUES(?,?,?,?)`).run(
    'TEST04', '测试股票基金B', '股票型', 'sh000300'
  );
  db.prepare(
    `INSERT OR IGNORE INTO fund_stock(fund_code,stock_code,stock_name,ratio,report_period)
     VALUES(?,?,?,?,?)`
  ).run('TEST04', '600519', '贵州茅台', 10.0, '2026年第一季度');
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

test('estimateFund 路径1: 重仓股加权(无基准指数时剩余不补齐)', async () => {
  // TEST01 在测试库无 track_index -> 剩余 90% 无法补齐, 仅披露部分计入
  const quotes = {
    sh600519: { stock_code: 'sh600519', name: '贵州茅台', pct_change: 2.5 },
    sh000300: { stock_code: 'sh000300', name: '沪深300', pct_change: 1.0 },
  };
  const est = await estimateFund('TEST01', quotes);
  assert.strictEqual(est.method, 'stock');
  assert.strictEqual(est.pct, 0.25); // 10% * 2.5%, 剩余不补齐
  assert.strictEqual(est.index_code, null);
  assert.strictEqual(est.residual_ratio, 90); // 100% - 10% 披露
  assert.strictEqual(est.benchmark_pct, null);
  assert.strictEqual(est.stocks.length, 1);
  assert.strictEqual(est.intraday_supported, true);
  assert.strictEqual(est.holdings_stale, false);
});

test('estimateFund 路径1: 剩余仓位按基准指数补齐', async () => {
  // TEST04 有 track_index=sh000300, 披露 10% -> 剩余 90% 按沪深300 补齐
  const quotes = {
    sh600519: { stock_code: 'sh600519', name: '贵州茅台', pct_change: 2.5 },
    sh000300: { stock_code: 'sh000300', name: '沪深300', pct_change: 1.0 },
  };
  const est = await estimateFund('TEST04', quotes);
  assert.strictEqual(est.method, 'stock');
  assert.strictEqual(est.index_code, 'sh000300');
  // 10% * 2.5% = 0.25% (披露) + 90% * 1.0% = 0.9% (剩余补齐) = 1.15%
  assert.strictEqual(est.pct, 1.15);
  assert.strictEqual(est.residual_ratio, 90);
  assert.strictEqual(est.benchmark_pct, 1.0);
});

test('estimateFund 路径1: 基准指数行情缺失时剩余贡献为 0 (优雅降级)', async () => {
  // TEST04 有 track_index, 但 quotes 中缺 sh000300 -> 剩余不补齐
  const quotes = {
    sh600519: { stock_code: 'sh600519', name: '贵州茅台', pct_change: 2.5 },
  };
  const est = await estimateFund('TEST04', quotes);
  assert.strictEqual(est.pct, 0.25); // 仅披露部分
  assert.strictEqual(est.benchmark_pct, null);
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
