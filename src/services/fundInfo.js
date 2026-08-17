/**
 * 基金信息/持仓接口模块
 * 数据源：东方财富基金公开接口
 *  - 基金基础信息(净值): https://fundgz.1234567.com.cn/js/{code}.js
 *  - 持仓股票(季报/年报): 东方财富 F10 接口
 *      https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code={code}&topline=10&year=&month=
 */
// Node 18+ 内置 fetch

const NAV_URL = 'https://fundgz.1234567.com.cn/js/';
const HOLDING_URL = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx';

// 获取基金最新净值与基本信息
// 主接口: fundgz.1234567.com.cn (jsonpgz); 备接口: api.fund.eastmoney.com/f10/lsjz (更稳)
async function getFundBase(code) {
  // 1) 尝试主接口
  try {
    const res = await fetch(`${NAV_URL}${code}.js`, {
      headers: { Referer: 'https://fundf10.eastmoney.com' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    const m = text.match(/jsonpgz\((.*)\)/);
    if (m) {
      const d = JSON.parse(m[1]);
      const nav = parseFloat(d.gsz);
      if (!isNaN(nav)) {
        return { code, name: d.name, type: d.fundtype, latest_nav: nav, nav_date: d.jzrq };
      }
    }
  } catch (e) {
    console.warn('主净值接口失败, 尝试备接口', code, e.message);
  }
  // 2) 备接口 (api.fund.eastmoney.com/f10/lsjz)
  try {
    const res = await fetch(
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1`,
      { headers: { Referer: 'https://fundf10.eastmoney.com', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    );
    const d = await res.json();
    const list = d && d.Data && d.Data.LSJZList;
    if (list && list.length) {
      const row = list[0];
      const nav = parseFloat(row.DWJZ);
      if (!isNaN(nav)) {
        return { code, name: '', type: '', latest_nav: nav, nav_date: row.FSRQ };
      }
    }
  } catch (e) {
    console.warn('获取基金净值失败', code, e.message);
  }
  return null;
}

// 解析东方财富持仓表格 HTML 片段，提取股票代码/名称/占比
// 注意: 东方财富 jjcc 接口 HTML 含多个 <tbody>:
//   第一个 <tbody> = 真正的"股票投资明细"表(columns[6] 为占净值比例 %)
//   后续 <tbody>   = 其他资产/债券或按市值排序的汇总视图(columns[6] 实为持仓市值, 非占比, 必须忽略)
// 因此只解析第一个 <tbody>, 避免把非占比列当成占比导致合计远超 100%。
function parseHoldingHtml(html) {
  const rows = [];
  // 仅取第一个 <tbody> 的内容
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  const tbodyHtml = tbodyMatch ? tbodyMatch[1] : html;
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let tr;
  while ((tr = trRe.exec(tbodyHtml)) !== null) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim()
    );
    if (cells.length < 6) continue;
    // 实际列顺序(东方财富季报): 序号 股票代码 股票名称 最新价 涨跌幅 相关资讯 占净值比例 持股数(万股) 持仓市值
    const stockCode = (cells[1] || '').match(/\d{6}/);
    const stockName = cells[2];
    const ratioRaw = (cells[6] || '').replace('%', '');
    const ratio = parseFloat(ratioRaw);
    if (!stockCode || !stockName || isNaN(ratio)) continue;
    // 占比应 <= 100(单只股票不可能超过基金净值), 超过则视为抓错列, 跳过
    if (ratio > 100) continue;
    rows.push({ stock_code: stockCode[0], stock_name: stockName, ratio });
  }
  return rows;
}

/**
 * 获取基金最近一期季报/年报持仓
 * @param {string} code 基金代码
 * @returns {Promise<{period:string, stocks:Array}>}
 */
async function getFundHoldings(code) {
  const url = `${HOLDING_URL}?type=jjcc&code=${code}&topline=20&year=&month=`; // 不指定年份取最新
  try {
    const res = await fetch(url, { headers: { Referer: 'https://fundf10.eastmoney.com' }, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    // 报告期出现在标题中: <font>2026年第一季度</font> 之类
    const periodM = text.match(/(\d{4}年[^<]*(季度|半年度|年度报告|中期))/);
    const period = periodM ? periodM[1].replace(/\s/g, '') : '';
    const stocks = parseHoldingHtml(text);
    return { period, stocks };
  } catch (e) {
    console.warn('获取基金持仓失败', code, e.message);
    return { period: '', stocks: [] };
  }
}

// 基金名称 -> 代码 搜索 (东方财富基金搜索接口)
const SEARCH_URL = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx';
async function searchFundByName(name) {
  if (!name || !name.trim()) return [];
  const url = `${SEARCH_URL}?m=1&key=${encodeURIComponent(name.trim())}`;
  try {
    const res = await fetch(url, {
      headers: { Referer: 'https://fundsuggest.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const d = await res.json();
    if (!d || d.ErrCode !== 0 || !Array.isArray(d.Datas)) return [];
    // 过滤出基金类别 (CATEGORY=700)
    return d.Datas
      .filter((it) => it.CATEGORY === 700 || it.CATEGORY == null)
      .map((it) => ({
        code: it.CODE || it._id,
        name: (it.FundBaseInfo && it.FundBaseInfo.SHORTNAME) || it.NAME || '',
      }))
      .filter((it) => it.code && it.name);
  } catch (e) {
    console.warn('基金名称搜索失败', name, e.message);
    return [];
  }
}

// 取基金历史净值(按日期)。用于交易份额回填: 申购/赎回的净值在交易日后才公布。
// 规则: 交易时间 < 15:00 用当日(T)净值; >= 15:00 用下一交易日(T+1)净值。
// lsjz 仅返回交易日净值, 故在 tradeDate..+12 天窗口内取第一条满足条件的行(自动跳过周末/假期)。
async function getNavByDate(code, tradeDate, tradeTime) {
  if (!code || !tradeDate) return null;
  const end = addDays(tradeDate, 12);
  const rows = await fetchLsjz(code, tradeDate, end);
  if (!rows.length) return null;
  const hhmm = (tradeTime || '').slice(0, 5);
  const afterCutoff = !hhmm || hhmm >= '15:00';
  const target = afterCutoff
    ? rows.find((r) => r.FSRQ > tradeDate)   // T+1: 严格晚于交易日的首个交易日
    : rows.find((r) => r.FSRQ >= tradeDate); // T 日: 当日或之后首个交易日
  if (!target) return null;
  const nav = parseFloat(target.DWJZ);
  if (isNaN(nav)) return null;
  return { nav, nav_date: target.FSRQ };
}

// 拉取某区间历史净值(升序), 失败返回空数组(防御式, 不抛)
async function fetchLsjz(code, startDate, endDate) {
  try {
    const url =
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}` +
      `&pageIndex=1&pageSize=30&startDate=${startDate}&endDate=${endDate}`;
    const res = await fetch(url, {
      headers: { Referer: 'https://fundf10.eastmoney.com', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const d = await res.json();
    const list = (d && d.Data && d.Data.LSJZList) || [];
    return list
      .map((r) => ({ FSRQ: r.FSRQ, DWJZ: r.DWJZ }))
      .filter((r) => r.FSRQ && r.DWJZ != null)
      .sort((a, b) => (a.FSRQ < b.FSRQ ? -1 : a.FSRQ > b.FSRQ ? 1 : 0));
  } catch (e) {
    console.warn('获取历史净值失败', code, e.message);
    return [];
  }
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z'); // UTC 解析, 避免本地时区导致跨日错误
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { getFundBase, getFundHoldings, searchFundByName, getNavByDate };
