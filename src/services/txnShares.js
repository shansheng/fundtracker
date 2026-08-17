/**
 * 交易份额回填服务
 * 交易截图通常只有"金额", 没有"份额/净值"。份额 = 金额 ÷ 净值。
 * 关键: 基金净值在交易日后才公布 —— 申购/赎回按"15:00 截止"规则确定适用净值:
 *   - 交易时间 < 15:00 -> 用当日(T)净值
 *   - 交易时间 >= 15:00 -> 用下一交易日(T+1)净值
 * 故需按交易日期去历史净值接口取对应净值, 再算份额。
 */
const { getNavByDate } = require('./fundInfo');
const { mapLimit } = require('./concurrency');

// 纯函数: 由交易日期 + 时间推算"适用净值日期"(日历层面 T 或 T+1)
// 返回 'YYYY-MM-DD'; 实际交易日由 getNavByDate 在窗口内顺延
function navApplicableDate(tradeDate, tradeTime) {
  if (!tradeDate) return null;
  const hhmm = (tradeTime || '').slice(0, 5);
  const afterCutoff = !hhmm || hhmm >= '15:00';
  if (!afterCutoff) return tradeDate; // 15:00 前 -> 当日净值
  const d = new Date(tradeDate + 'T00:00:00Z'); // UTC 解析, 避免本地时区导致跨日错误
  d.setUTCDate(d.getUTCDate() + 1); // 15:00 后 -> 下一日历日(T+1)
  return d.toISOString().slice(0, 10);
}

// 纯函数: 份额 = 金额 / 净值(忽略申赎费, 为估算值)
function sharesFromAmount(amount, nav) {
  if (amount == null || !nav || nav <= 0) return null;
  return Number((amount / nav).toFixed(4));
}

// 解析 tx_date("2026-08-11 23:04:20" 或 "2026-08-11T23:04:20") -> { date, time }
function splitTxDate(txDate) {
  if (!txDate) return { date: null, time: null };
  const s = String(txDate).replace('T', ' ');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) return { date: m[1], time: m[2] };
  const d = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return { date: d ? d[1] : null, time: null };
}

// 对单条交易计算份额(联网取净值); 返回 { shares, nav, nav_date } 或 null
async function computeSharesForTxn(txn) {
  const { fund_code, amount, tx_date } = txn;
  if (!fund_code || amount == null) return null;
  const { date, time } = splitTxDate(tx_date);
  if (!date) return null;
  const navInfo = await getNavByDate(fund_code, date, time);
  if (!navInfo) return null;
  const shares = sharesFromAmount(amount, navInfo.nav);
  if (shares == null) return null;
  return { shares, nav: navInfo.nav, nav_date: navInfo.nav_date };
}

// 批量回填: 给 txn 中"份额为空但金额/日期完整"的行计算份额并写回 nav/nav_date
// opts: { source?, onlyNullShares? }
// 用有限并发(mapLimit)限制对公共净值接口的并发, 规避限流
async function backfillTxnShares(db, opts = {}) {
  const whereParts = [];
  const args = [];
  if (opts.source) {
    whereParts.push('source=?');
    args.push(opts.source);
  }
  if (opts.onlyNullShares !== false) whereParts.push('(shares IS NULL OR shares=0)');
  whereParts.push('amount IS NOT NULL');
  whereParts.push("tx_date IS NOT NULL");
  // 分红(dividend)是现金发放, 不产生份额, 默认跳过
  if (opts.includeDividend !== true) whereParts.push("(type IS NULL OR type != 'dividend')");
  const where = 'WHERE ' + whereParts.join(' AND ');
  const rows = db.prepare(`SELECT * FROM txn ${where}`).all(...args);

  let updated = 0;
  let skipped = 0;
  await mapLimit(rows, 4, async (r) => {
    try {
      const res = await computeSharesForTxn(r);
      if (!res) {
        skipped++;
        return;
      }
      db.prepare('UPDATE txn SET shares=?, nav=?, nav_date=? WHERE id=?').run(
        res.shares,
        res.nav,
        res.nav_date,
        r.id
      );
      updated++;
    } catch (e) {
      skipped++;
    }
  });
  return { total: rows.length, updated, skipped };
}

module.exports = {
  navApplicableDate,
  sharesFromAmount,
  splitTxDate,
  computeSharesForTxn,
  backfillTxnShares,
};
