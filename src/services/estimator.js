/**
 * 实时涨跌幅估算引擎
 *
 * 原理：
 * 基金实时估值涨跌幅 ≈ Σ(披露成分股占比_i × 成分股实时涨跌幅_i)
 *                     + (100% − 披露占比合计) × 基准指数(行业/宽基)实时涨跌幅
 * 其中占比来自最近一期季报/年报披露的"占净值比例"（通常只披露前十大重仓，合计 30%~90%）。
 * 未披露部分(剩余仓位)按基金所属行业/宽基指数(track_index，缺省为沪深300)当日涨跌补齐，
 * 避免把大量未披露仓位简单视作 0 波动导致估算系统性偏低；债券/货币/QDII 基金无权益基准，
 * 该部分仍近似为 0 波动。
 *
 * 持仓总市值 = Σ(每只基金 持有份额 × (最新净值 × (1 + 估算涨跌幅)))
 * 当日盈亏 = 持仓总市值 - 持仓成本(或昨日市值)
 */
const { getDb } = require('../db/db');
const { getRealtimeQuotes, normalizeCode } = require('./quotes');
const { getFundHoldings, getFundBase } = require('./fundInfo');
const { normalizeFundType } = require('./fundType');

// 判断当前是否为股票交易时段(盘中)
function isMarketOpen(date = new Date()) {
  const d = date.getDay();
  if (d === 0 || d === 6) return false; // 周末
  const h = date.getHours();
  const m = date.getMinutes();
  const t = h * 60 + m;
  const morning = t >= 9 * 60 + 30 && t <= 11 * 60 + 30;
  const afternoon = t >= 13 * 60 && t <= 15 * 60;
  return morning || afternoon;
}

/**
 * 解析报告期为 {year, month}；无法解析返回 null。
 * 支持: "2026年第一季度" / "2026年中期" / "2025年年度报告" / 旧格式 "2019Q3" / 纯 "2024"
 */
function parseReportPeriod(period) {
  if (!period) return null;
  const ym = period.match(/(\d{4})/);
  if (!ym) return null;
  const year = parseInt(ym[1], 10);
  let month = 12;
  if (/中期|半年度/.test(period)) month = 6;
  if (/年度报告|年报/.test(period)) month = 12;
  const qCN = period.match(/[第]?\s*([一二三四])\s*季度/);
  if (qCN) month = '一二三四'.indexOf(qCN[1]) * 3 + 3;
  const qNum = period.match(/(\d)\s*季度/);
  if (qNum) month = parseInt(qNum[1], 10) * 3;
  const qLegacy = period.match(/Q([1-4])/i);
  if (qLegacy) month = parseInt(qLegacy[1], 10) * 3;
  return { year, month };
}

// 报告期是否过期(距今超过 12 个月)
function isReportStale(period) {
  const p = parseReportPeriod(period);
  if (!p) return false;
  const now = new Date();
  const monthsOld = (now.getFullYear() - p.year) * 12 + (now.getMonth() + 1 - p.month);
  return monthsOld > 12;
}

/**
 * 计算单个基金的实时估算涨跌幅
 * 估值路径:
 *   - 有重仓股(fund_stock): 成分股加权(原逻辑)
 *   - 无重仓股但有跟踪指数(track_index): 用指数实时涨跌幅代理(联接/QDII 基金)
 *   - 两者皆无: 标记 intraday_supported=false, pct=null(不再静默返回 0%)
 * @param {string} fundCode
 * @param {Object} [quotes] 可选, 预批量拉取的行情 map(normalizeCode -> quote)。
 *        传入时不再单独发网络请求; 不传则各自按需拉取(单基金估算端点场景)。
 */
async function estimateFund(fundCode, quotes) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT stock_code, stock_name, ratio, report_period FROM fund_stock
       WHERE fund_code = ? ORDER BY ratio DESC`
    )
    .all(fundCode);
  // 持仓报告期时效(同基金各行为同一周期, 取首行)
  const period = rows.length ? rows[0].report_period || null : null;
  const holdings_stale = isReportStale(period);

  // 路径1: 重仓股加权 + 未披露仓位用基准指数(行业/宽基)补齐
  if (rows.length) {
    // 该基金的基准指数(track_index): 用于代理"季报未披露"的那部分仓位(通常 30%~90%)
    const fund = db.prepare(`SELECT track_index FROM fund WHERE code=?`).get(fundCode);
    const benchmarkCode = fund && fund.track_index ? fund.track_index : null;
    // 所需行情代码: 披露持仓股 + (存在基准指数时包含基准)
    const codes = [...new Set(rows.map((r) => normalizeCode(r.stock_code)))];
    const needCodes = benchmarkCode ? [...codes, normalizeCode(benchmarkCode)] : codes;
    const qMap = quotes || (await getRealtimeQuotes(needCodes));
    let pct = 0; // 披露持仓股票部分贡献(%)
    const detail = rows.map((r) => {
      const q = qMap[normalizeCode(r.stock_code)] || {};
      const contribution = (r.ratio / 100) * (q.pct_change || 0);
      pct += contribution;
      return {
        stock_code: r.stock_code,
        stock_name: r.stock_name,
        ratio: r.ratio,
        pct_change: q.pct_change ?? null,
        contribution: Number(contribution.toFixed(3)),
      };
    });
    // 披露持仓占比合计(%); 其余(100% - 披露)按基准指数当日涨跌补齐
    const disclosedRatio = rows.reduce((s, r) => s + (r.ratio || 0), 0);
    const residualRatio = Math.max(0, 100 - disclosedRatio); // 未披露仓位占比(%)
    let benchmarkPct = null;
    let residualContribution = 0;
    if (benchmarkCode && residualRatio > 0.01) {
      const bq = qMap[normalizeCode(benchmarkCode)] || qMap[benchmarkCode] || {};
      if (bq && bq.pct_change != null) {
        benchmarkPct = bq.pct_change;
        residualContribution = (residualRatio / 100) * benchmarkPct; // 指数补齐贡献(%)
      }
    }
    return {
      pct: Number((pct + residualContribution).toFixed(2)),
      stocks: detail,
      method: 'stock',
      index_code: benchmarkCode,
      benchmark_pct: benchmarkPct,
      residual_ratio: Number(residualRatio.toFixed(2)),
      intraday_supported: true,
      holdings_period: period,
      holdings_stale,
      updated_at: new Date().toISOString(),
      empty: false,
    };
  }

  // 路径2: 跟踪指数代理(联接/QDII 基金)
  const fund = db.prepare(`SELECT track_index FROM fund WHERE code=?`).get(fundCode);
  const trackIndex = fund && fund.track_index ? fund.track_index : null;
  if (trackIndex) {
    try {
      const qMap = quotes || (await getRealtimeQuotes([trackIndex]));
      const q = qMap[normalizeCode(trackIndex)] || qMap[trackIndex] || {};
      if (q && q.pct_change != null) {
        return {
          pct: q.pct_change,
          stocks: [],
          method: 'index',
          index_code: trackIndex,
          intraday_supported: true,
          holdings_period: period,
          holdings_stale,
          updated_at: new Date().toISOString(),
          empty: false,
        };
      }
    } catch (e) {
      // 指数行情失败, 退化为不支持
    }
  }

  // 路径3: 既无重仓股也无可用指数 -> 不支持盘中估值(不再静默 0%)
  return {
    pct: null,
    stocks: [],
    method: 'none',
    index_code: null,
    intraday_supported: false,
    holdings_period: period,
    holdings_stale,
    updated_at: new Date().toISOString(),
    empty: true,
  };
}

/**
 * 估算整个组合的实时状态
 * @returns {Promise<{total:{market_value,day_pnl,pct}, funds:Array}>}
 */
async function estimatePortfolio() {
  const db = getDb();
    const holdings = db
      .prepare(
        `SELECT h.fund_code, h.shares, h.cost_amount, h.market_value, h.platform, f.name, f.latest_nav,
                f.nav_date, f.type AS fund_type,
                h.hold_profit, h.yest_profit, h.yest_pct
         FROM holding h LEFT JOIN fund f ON f.code = h.fund_code`
      )
      .all();
  const fundCodes = holdings.map((h) => h.fund_code);

  // Phase 2: 预先收集组合内所有需要的行情代码(重仓股 + 跟踪指数), 一次性批量拉取,
  // 避免逐基金单独发请求(~123 次 -> ≤3 次)。行情结果在 30s TTL 内可复用。
  const allCodes = new Set();
  if (fundCodes.length) {
    const ph = fundCodes.map(() => '?').join(',');
    const trackRows = db
      .prepare(`SELECT track_index FROM fund WHERE code IN (${ph})`)
      .all(...fundCodes);
    for (const r of trackRows) if (r.track_index) allCodes.add(r.track_index);
    const stockRows = db
      .prepare(`SELECT DISTINCT stock_code FROM fund_stock WHERE fund_code IN (${ph})`)
      .all(...fundCodes);
    for (const r of stockRows) if (r.stock_code) allCodes.add(r.stock_code);
  }
  const quotes = await getRealtimeQuotes([...allCodes]);

  let totalMarketValue = 0;
  let totalCost = 0;
  let totalPrevValue = 0;
  const funds = [];

  for (const h of holdings) {
    const est = await estimateFund(h.fund_code, quotes);
    const nav = h.latest_nav || 0;
    // est.pct 可能为 null(不支持盘中估值): 净值推算按 0 处理, 对外展示保持 null
    const estPct = est.pct == null ? 0 : est.pct;
    const estNav = nav * (1 + estPct / 100);
    // 展示用份额: 库里没有时, 用 市值 ÷ 净值 反算(联网拉到净值后自动填充, 不写库)
    let dispShares = h.shares;
    if (dispShares == null && h.market_value != null) {
      if (nav > 0) dispShares = Number((h.market_value / nav).toFixed(2));
      else if (estNav > 0) dispShares = Number((h.market_value / estNav).toFixed(2));
    }
    // 优先用"份额 × 估算净值"算市值; 若份额或净值缺失, 回退数据库里已存的持仓金额(market_value)
    const rawMarketValue = h.market_value != null ? h.market_value : (h.shares || 0) * estNav;
    const marketValue = rawMarketValue;
    // 当日涨跌: 系统未记录"昨收市值"基准, 用成分股加权实时涨跌幅 est_pct 反推昨收市值
    // prevValue = 市值 / (1 + est_pct/100); 当日盈亏 = 市值 - prevValue
    const rawPrevValue =
      estPct
        ? marketValue / (1 + estPct / 100)
        : (h.market_value != null ? h.market_value : (h.shares || 0) * nav);
    const prevValue = rawPrevValue;

    // 成本(买入本金): 优先用记录的 cost_amount;
    // 否则若同时有市值和"累计盈亏(OCR)", 用 市值-累计盈亏 反推真实成本;
    // 否则无可靠成本数据时标记为空(收益率应显示 --, 不能用市值当分母)
    const holdProfit = h.hold_profit != null ? Number(h.hold_profit) : null;
    let cost = null;
    if (h.cost_amount != null) cost = h.cost_amount;
    else if (h.market_value != null && holdProfit != null) cost = Number((h.market_value - holdProfit).toFixed(2));
    const dayPnl = marketValue - prevValue;

    totalMarketValue += marketValue;
    if (cost != null) totalCost += cost;
    totalPrevValue += prevValue;

    // 累计收益: 优先用 OCR 识别的"累计盈亏"(平台真实值); 否则用 市值-成本 估算
    const estProfit = cost != null ? Number((marketValue - cost).toFixed(2)) : null;
    const profit = holdProfit != null ? holdProfit : estProfit;
    // 收益率: 必须有真实成本才能算; 分母用成本(本金)而非市值
    const profitPct = (profit != null && cost && cost !== 0)
      ? Number((profit / cost * 100).toFixed(2)) : null;
    funds.push({
      fund_code: h.fund_code,
      name: h.name,
      type: h.fund_type || '',
      platform: h.platform,
      shares: dispShares,
      latest_nav: nav,
      nav_date: h.nav_date || null,
      est_nav: Number(estNav.toFixed(4)),
      est_pct: est.pct,
      // 展示用市值: 有份额净值时优先用份额×净值, 否则回退持仓金额
      market_value: Number(marketValue.toFixed(2)),
      prev_value: Number(prevValue.toFixed(2)),
      day_pnl: Number(dayPnl.toFixed(2)),
      day_pct: Number((prevValue ? (dayPnl / prevValue) * 100 : 0).toFixed(2)),
      cost_amount: cost,
      profit,
      profit_pct: profitPct,
      // OCR 识别的累计盈亏/昨日收益(直接来自截图, 与净值估算无关)
      hold_profit: holdProfit,
      yest_profit: h.yest_profit != null ? Number(h.yest_profit) : null,
      yest_pct: h.yest_pct != null ? Number(h.yest_pct) : null,
      stocks: est.stocks,
      empty: est.empty,
      intraday_supported: est.intraday_supported,
      method: est.method,
      index_code: est.index_code,
      benchmark_pct: est.benchmark_pct,
      residual_ratio: est.residual_ratio,
      holdings_period: est.holdings_period,
      holdings_stale: est.holdings_stale,
    });
  }

  // 持仓收益: 优先用各基金"真实累计盈亏"之和(来自 OCR); 否则用 市值-成本 估算
  const totalHoldProfit = funds.reduce((s, f) => s + (f.hold_profit != null ? f.hold_profit : 0), 0);
  const hasRealProfit = funds.some((f) => f.hold_profit != null);
  // 只有当所有持仓都有真实成本(totalCost>0 且基于真实反推)时才算收益率
  const estTotalProfit = totalCost > 0 ? Number((totalMarketValue - totalCost).toFixed(2)) : null;
  const totalProfit = hasRealProfit ? Number(totalHoldProfit.toFixed(2)) : estTotalProfit;
  const totalProfitPct = (totalCost > 0)
    ? Number(((totalMarketValue - totalCost) / totalCost * 100).toFixed(2)) : null;
  return {
    market_open: isMarketOpen(),
    total: {
      market_value: Number(totalMarketValue.toFixed(2)),
      cost_amount: Number(totalCost.toFixed(2)),
      prev_value: Number(totalPrevValue.toFixed(2)),
      day_pnl: Number((totalMarketValue - totalPrevValue).toFixed(2)),
      day_pct: totalPrevValue ? Number(((totalMarketValue - totalPrevValue) / totalPrevValue * 100).toFixed(2)) : 0,
      total_profit: totalProfit,
      total_profit_pct: totalProfitPct,
    },
    funds,
    updated_at: new Date().toISOString(),
  };
}

/**
 * 刷新基金基础信息与持仓股票(季报/年报)
 * @param {string} fundCode
 */
async function refreshFundInfo(fundCode) {
  const db = getDb();
  let base = null;
  try {
    base = await getFundBase(fundCode);
  } catch (e) {
    base = null; // 网络失败: 不阻塞, 后续用本地已存净值回退
  }
  if (base) {
    // 净值接口(备接口)不返回名称; 若本地已有名称则保留, 避免刷新后名称被清空
    const local = db.prepare(`SELECT name, type FROM fund WHERE code=?`).get(fundCode);
    const mergedName = base.name || (local && local.name) || '';
    // 在线 type(东财 fundtype)经归一化; 为空时按名称离线推断; 再不行保留本地已有值
    const mergedType =
      normalizeFundType(base.type, base.name) || (local && local.type) || '';
    db.prepare(
      `INSERT INTO fund(code,name,type,latest_nav,nav_date,updated_at)
       VALUES(@code,@name,@type,@latest_nav,@nav_date,datetime('now'))
       ON CONFLICT(code) DO UPDATE SET name=@name,type=@type,latest_nav=@latest_nav,nav_date=@nav_date,updated_at=datetime('now')`
    ).run({ code: base.code, name: mergedName, type: mergedType, latest_nav: base.latest_nav, nav_date: base.nav_date });
  }
  // 注意: 刷新净值只更新 fund.latest_nav, 绝不修改持仓份额!
  // 份额是固定不变的, 只在导入持仓时(市值÷导入时净值)计算一次; 净值涨跌应通过 市值=份额×新净值 体现。
  let hold = null;
  try {
    hold = await getFundHoldings(fundCode);
  } catch (e) {
    hold = null;
  }
  if (hold && hold.stocks.length) {
    // 先删除该基金旧持仓, 再写入最新一期(解析层已按 stock_code 去重)
    db.prepare(`DELETE FROM fund_stock WHERE fund_code=?`).run(fundCode);
    for (const s of hold.stocks) {
      db.prepare(
        `INSERT INTO fund_stock(fund_code,report_period,stock_code,stock_name,ratio,updated_at)
         VALUES(?,?,?,?,?,datetime('now'))
         ON CONFLICT(fund_code,stock_code) DO UPDATE SET
           report_period=excluded.report_period,
           stock_name=excluded.stock_name,
           ratio=excluded.ratio,
           updated_at=datetime('now')`
      ).run(fundCode, hold.period, s.stock_code, s.stock_name, s.ratio);
    }
  }
  return { base, hold };
}

module.exports = {
  estimateFund,
  estimatePortfolio,
  refreshFundInfo,
  isMarketOpen,
  parseReportPeriod,
  isReportStale,
};
