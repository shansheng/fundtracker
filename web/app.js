/* FundTracker 前端逻辑 */
const API = window.API_BASE || 'http://127.0.0.1:3456/api';

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmt(n, digits = 2) {
  if (n == null || isNaN(n)) return '--';
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function pctClass(n) {
  if (n == null) return '';
  return n > 0 ? 'up' : n < 0 ? 'down' : '';
}
function pctText(n) {
  if (n == null || isNaN(n)) return '--';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
function safeGet(id) { return document.getElementById(id); }

/**
 * 渲染"估算涨跌"单元格。
 * 支持盘中估值的基金: 显示实时估算涨跌幅(红涨绿跌)。
 * 不支持盘中估值的基金(债券/货币/无持仓无跟踪指数): 不再显示 "--"/"不支持",
 * 而是展示最新净值(带净值日期), 让该列在任何情况下都有明确、有意义的内容。
 */
function renderEstPctCell(f) {
  if (f.intraday_supported === false) {
    // 货币基金: 按日计息、T+1 披露净值, 净值恒≈1.0, 盘中估值无意义 -> 标 "T+1 净值" 而非一个无波动的数字
    if (f.type === '货币型') {
      return `<td class="est-na" title="货币基金按日计息，T+1 披露净值，无盘中估值">T+1 净值</td>`;
    }
    // 债券/其他不支持盘中估值: 展示最新净值(债券净值每日变动, 最新净值即有意义)
    const hasNav = f.latest_nav != null && !isNaN(f.latest_nav);
    const navText = hasNav ? Number(f.latest_nav).toFixed(4) : '--';
    const dateTip = f.nav_date ? `（${f.nav_date}）` : '（净值日期未知）';
    const typeTip = f.type || '该类型基金';
    const tip = `不支持盘中估值（${typeTip}），已展示最新净值${dateTip}`;
    return `<td class="est-na" title="${tip}">净值 ${navText}</td>`;
  }
  const tip = f.holdings_stale ? '持仓报告期较旧，估值仅供参考' : '';
  return `<td class="${pctClass(f.est_pct)}" title="${tip}">${pctText(f.est_pct)}</td>`;
}
function platformLabel(p) {
  if (!p) return '未知';
  const map = {
    alipay: '支付宝',
    tianhong: '天天基金',
    wechat: '微信理财通',
    bank: '银行',
    jd: '京东金融',
    other: '其他',
  };
  return map[p.toLowerCase()] || p;
}

/* ---------- 概览 + 持仓 ---------- */
let lastEstimateData = null;    // 最近一次 /estimate 全量(供筛选/分组复用, 免重复请求)
let currentTypeFilter = 'all';  // 当前类型筛选('all' 或具体类型)
let currentPlatformFilter = 'all'; // 当前平台筛选('all' 或具体平台 key)
let groupByType = false;        // 是否按类型分组显示

// 类型展示顺序(分组/排序用); 未登记类型排最后
const TYPE_ORDER = ['股票型', '混合型', '指数型', '债券型', 'QDII', 'FOF', '货币型', '其他', '未分类'];
function typeSortKey(t) { const i = TYPE_ORDER.indexOf(t); return i < 0 ? TYPE_ORDER.length : i; }

// 按平台筛选后的基金集合(平台图例点击联动; 'all' 表示不过滤)
function platformFilteredFunds() {
  if (!lastEstimateData) return [];
  if (currentPlatformFilter === 'all') return lastEstimateData.funds;
  return lastEstimateData.funds.filter((f) => (f.platform || '未标注') === currentPlatformFilter);
}

async function loadEstimate() {
  try {
    const data = await api('/estimate');
    lastEstimateData = data;
    const t = data.total;
    safeGet('ov-market-value').textContent = fmt(t.market_value);
    setPct('ov-day-pnl', t.day_pnl);
    setPct('ov-day-pct', t.day_pct, true);
    safeGet('ov-cost').textContent = fmt(t.cost_amount);
    setPct('ov-profit', t.total_profit);
    setPct('ov-profit-pct', t.total_profit_pct, true);
    safeGet('updated-at').textContent = '更新于 ' + new Date(data.updated_at).toLocaleTimeString('zh-CN');
    const ms = safeGet('market-status');
    ms.textContent = data.market_open ? '盘中' : '非交易时段';
    ms.style.color = data.market_open ? 'var(--down)' : 'var(--muted)';
    renderHoldings();
    renderPlatformStats();
  } catch (e) {
    console.error('loadEstimate 失败', e);
  }
}

// 单只基金行 HTML(分组/筛选共用)
function fundRowHtml(f) {
  return `<tr>
    <td>${f.name || '--'}</td>
    <td>${f.fund_code}</td>
    <td><span class="platform-tag">${platformLabel(f.platform)}</span></td>
    <td>${fmt(f.shares, 2)}</td>
    <td>${fmt(f.latest_nav, 4)}</td>
    <td>${fmt(f.est_nav, 4)}</td>
    ${renderEstPctCell(f)}
    <td>${fmt(f.market_value)}</td>
    <td class="${pctClass(f.hold_profit)}">${fmt(f.hold_profit)}</td>
    <td class="${pctClass(f.yest_profit)}">${fmt(f.yest_profit)}</td>
    <td class="${pctClass(f.day_pnl)}">${fmt(f.day_pnl)}</td>
    <td class="${pctClass(f.profit)}">${fmt(f.profit)}</td>
    <td class="${pctClass(f.profit)}">${pctText(f.profit_pct)}</td>
    <td>
      <div class="row-actions">
        <button class="btn btn-link" data-detail="${f.fund_code}">明细</button>
        <button class="btn btn-del" data-del="${f.fund_code}">删除</button>
      </div>
    </td></tr>`;
}

// 渲染持仓表: 应用平台筛选 + 类型筛选 + 分组(不重新发请求, 复用 lastEstimateData)
function renderHoldings() {
  const body = safeGet('holdings-body');
  if (!body || !lastEstimateData) return;
  const allFunds = lastEstimateData.funds;
  const scoped = platformFilteredFunds(); // 先按平台筛选(平台图例联动)

  // 类型筛选 chips(计数基于"平台筛选后"的集合, 保证计数与下方一致)
  const filterEl = safeGet('type-filter');
  if (filterEl) {
    const types = Array.from(new Set(scoped.map((f) => f.type || '未分类'))).sort((a, b) => typeSortKey(a) - typeSortKey(b));
    const chips = ['all', ...types].map((t) => {
      const label = t === 'all' ? '全部' : t;
      const cnt = t === 'all' ? scoped.length : scoped.filter((f) => (f.type || '未分类') === t).length;
      const active = t === currentTypeFilter ? ' active' : '';
      return `<span class="type-chip${active}" data-type="${t}">${label} <b>${cnt}</b></span>`;
    });
    filterEl.innerHTML = chips.join('');
  }

  // 平台筛选指示(持仓控件区, 可点击清除)
  const pfEl = safeGet('platform-filter');
  if (pfEl) {
    pfEl.innerHTML = currentPlatformFilter === 'all'
      ? ''
      : `<span class="type-chip active" data-clear-platform="1" title="点击清除平台筛选">平台: ${platformLabel(currentPlatformFilter)} ✕</span>`;
  }

  // 叠加类型筛选(平台已先筛过)
  let funds = scoped;
  if (currentTypeFilter !== 'all') {
    funds = funds.filter((f) => (f.type || '未分类') === currentTypeFilter);
  }

  // 渲染: 分组 or 平铺
  let html = '';
  if (groupByType && currentTypeFilter === 'all') {
    // 仅"全部"下分组才有意义; 已筛选单类型时直接平铺
    const groups = {};
    for (const f of funds) {
      const t = f.type || '未分类';
      (groups[t] = groups[t] || []).push(f);
    }
    for (const t of Object.keys(groups).sort((a, b) => typeSortKey(a) - typeSortKey(b))) {
      const arr = groups[t];
      const sum = arr.reduce((s, f) => s + (f.market_value || 0), 0);
      html += `<tr class="group-header"><td colspan="14">${t} · ${arr.length} 只 · 市值 ${fmt(sum)}</td></tr>`;
      html += arr.map(fundRowHtml).join('');
    }
  } else {
    html = funds.map(fundRowHtml).join('');
  }
  if (funds.length === 0) {
    const tip = currentPlatformFilter === 'all' ? '暂无持仓数据' : `平台「${platformLabel(currentPlatformFilter)}」暂无持仓`;
    html = `<tr class="group-header"><td colspan="14">${tip}</td></tr>`;
  }
  body.innerHTML = html;
}

// 按平台聚合统计(前端从 funds 聚合, 与类型分组一致, 不重新发请求)
function renderPlatformStats() {
  if (!lastEstimateData) return;
  const total = lastEstimateData.total;
  const totalMv = total.market_value || 0;
  const map = {};
  for (const f of lastEstimateData.funds) {
    const p = f.platform || '未标注';
    const a = (map[p] = map[p] || { platform: p, count: 0, market_value: 0, cost_amount: 0, profit: 0, day_pnl: 0 });
    a.count++;
    a.market_value += f.market_value || 0;
    a.cost_amount += f.cost_amount || 0;
    a.profit += (f.profit != null ? f.profit : 0);
    a.day_pnl += (f.day_pnl != null ? f.day_pnl : 0);
  }
  const entries = Object.values(map)
    .map((a) => {
      a.profit_pct = a.cost_amount && a.cost_amount !== 0 ? (a.profit / a.cost_amount) * 100 : null;
      return a;
    })
    .sort((x, y) => y.market_value - x.market_value);

  const bar = safeGet('ps-bar');
  const legend = safeGet('ps-legend');
  if (!bar || !legend) return;

  // 段配色: 已知平台用品牌色, 其余按调色板(均对白字有对比, 取自主题令牌)
  const KNOWN = { alipay: 'var(--accent)', jd: 'color-mix(in srgb, var(--accent) 48%, #222c3c)' };
  const PALETTE = ['var(--accent)', 'var(--up)', 'var(--down)', 'color-mix(in srgb, var(--up) 55%, #222c3c)'];
  const colorFor = (p, i) => KNOWN[p] || PALETTE[i % PALETTE.length];

  bar.innerHTML = entries.length
    ? entries.map((a, i) => {
        const share = totalMv > 0 ? (a.market_value / totalMv) * 100 : 0;
        const name = platformLabel(a.platform);
        const val = fmt(a.market_value);
        const showVal = share >= 8;
        const day = a.day_pnl == null ? '--' : (a.day_pnl >= 0 ? '+' : '') + fmt(a.day_pnl);
        const active = a.platform === currentPlatformFilter ? ' active' : '';
        return `<div class="ps-seg${active}" data-platform="${a.platform}" style="width:${share.toFixed(2)}%;background:${colorFor(a.platform, i)}" title="${name} ${a.count}只 · ${val} (${share.toFixed(1)}%) · 当日 ${day} · 点击筛选该平台持仓"><span class="ps-name">${name}</span>${showVal ? `<span class="ps-val">${val}</span>` : ''}</div>`;
      }).join('')
    : '<div class="ps-seg" style="width:100%;background:var(--panel-2);color:var(--muted)">暂无持仓</div>';

  // 平台盈亏明细：当日实时盈亏为头条（软件核心功能），累计收益 + 占比为辅助
  // 整行可点击 -> 联动过滤下方持仓表(只看该平台当日盈亏构成); 再次点击同一平台则取消筛选
  legend.innerHTML = entries.map((a) => {
    const share = totalMv > 0 ? (a.market_value / totalMv) * 100 : 0;
    const day = a.day_pnl == null ? '--' : (a.day_pnl >= 0 ? '+' : '') + fmt(a.day_pnl);
    const cum = a.profit == null ? '--' : (a.profit >= 0 ? '+' : '') + fmt(a.profit);
    const cumPct = a.profit_pct != null ? ` (${(a.profit_pct >= 0 ? '+' : '') + a.profit_pct.toFixed(2)}%)` : '';
    const active = a.platform === currentPlatformFilter ? ' active' : '';
    return `<span class="ps-leg-item${active}" data-platform="${a.platform}" title="点击筛选：${platformLabel(a.platform)} 当日盈亏构成">
      <span class="ps-leg-name">${platformLabel(a.platform)} <i>${a.count}只·${share.toFixed(1)}%</i></span>
      <span class="ps-leg-day"><em>当日</em> <b class="${pctClass(a.day_pnl)}">${day}</b></span>
      <span class="ps-leg-cum"><em>累计</em> <b class="${pctClass(a.profit)}">${cum}</b><i>${cumPct}</i></span>
    </span>`;
  }).join('');
}

function setPct(id, n, isPct) {
  const el = safeGet(id);
  el.textContent = isPct ? pctText(n) : fmt(n);
  el.className = pctClass(n);
}

function toggleDetail(f) {
  const box = safeGet('fund-detail');
  if (box.dataset.code === f.fund_code && !box.classList.contains('hidden')) {
    box.classList.add('hidden');
    return;
  }
  box.dataset.code = f.fund_code;
  box.classList.remove('hidden');
  const summary = `
    <div class="detail-summary">
      <span>平台 <b>${platformLabel(f.platform)}</b></span>
      <span>最新净值 <b>${fmt(f.latest_nav, 4)}</b></span>
      <span>估算净值 <b>${fmt(f.est_nav, 4)}</b></span>
      <span>持有份额 <b>${fmt(f.shares, 2)}</b></span>
      <span>市值 <b>${fmt(f.market_value)}</b></span>
      <span>累计盈亏 <b class="${pctClass(f.hold_profit)}">${fmt(f.hold_profit)}</b></span>
      <span>昨日收益 <b class="${pctClass(f.yest_profit)}">${fmt(f.yest_profit)}</b></span>
    </div>`;
  let rows = (f.stocks || []).map(s => `
    <tr>
      <td>${s.stock_name || '--'}</td>
      <td>${s.stock_code}</td>
      <td>${fmt(s.ratio, 2)}%</td>
      <td class="${pctClass(s.pct_change)}">${pctText(s.pct_change)}</td>
      <td class="${pctClass(s.contribution)}">${pctText(s.contribution)}</td>
    </tr>`).join('');
  const stockSection = (f.stocks && f.stocks.length)
    ? `<table class="grid">
        <thead><tr><th>股票名称</th><th>代码</th><th>占净值比例</th><th>实时涨跌</th><th>贡献</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    : `<p class="muted">暂无持仓股票数据（可在"基金/持仓管理"点单只基金的"刷新"拉取季报持仓）。</p>`;
  const unsupportedNote = (f.intraday_supported === false)
    ? (f.type === '货币型'
        ? `<p class="muted" style="margin-top:12px">货币基金按日计息、T+1 披露净值，无盘中估值；下方"估算净值"即最新净值${f.nav_date ? `（${f.nav_date}）` : ''}。</p>`
        : `<p class="muted" style="margin-top:12px">该基金不支持盘中估值（${f.type || '该类型'}）。下方"估算净值"即最新净值${f.nav_date ? `（${f.nav_date}）` : ''}，收盘后由平台更新为准。</p>`)
    : '';
  box.innerHTML = `
    <h3>${f.name || f.fund_code} (${f.fund_code}) 明细</h3>
    ${summary}
    <p class="muted">持仓股估算涨跌幅 = Σ(占净值比例 × 成分股实时涨跌幅)，仅含股票仓位，现金/债券近似零波动。</p>
    ${stockSection}
    ${unsupportedNote}`;
}

/* ---------- 截图 OCR ---------- */
async function onOcrClick() {
  const fileInput = safeGet('scr-file');
  const status = safeGet('ocr-status');
  const resultBox = safeGet('ocr-result');
  if (!fileInput.files.length) { status.textContent = '请先选择截图文件'; return; }
  status.textContent = '识别中... (首次需下载 OCR 语言包，请稍候)';
  resultBox.classList.add('hidden');
  try {
    const file = fileInput.files[0];
    const ext = file.name.split('.').pop() || 'png';
    const buf = await file.arrayBuffer();
    const up = await fetch(API + '/upload?ext=' + ext, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    const { file_path } = await up.json();
    const platform = safeGet('scr-platform').value;
    const kind = safeGet('scr-kind').value;
    const parsed = await api('/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_path, platform, kind }),
    });
    status.textContent = '识别完成，请确认/修正后保存：';
    renderOcrResult(parsed, platform, kind, file_path);
  } catch (e) {
    status.textContent = '识别失败: ' + e.message;
  }
}

function renderOcrResult(parsed, platform, kind, file_path) {
  const box = safeGet('ocr-result');
  box.classList.remove('hidden');
  const items = kind === 'trade' ? parsed.txs : parsed.funds;
  const isTrade = kind === 'trade';
  let html = `<h3>识别结果 (平台: ${platform}, 类型: ${kind})</h3>`;
  if (!items || !items.length) {
    html += '<p class="muted">未在截图中识别出基金代码，请手动录入。</p>';
  } else {
    items.forEach((it, i) => {
      const hasCode = (isTrade ? it.fund_code : it.code);
      const nameHint = it.name ? ` <span class="muted">(名称: ${escapeHtml(it.name)}</span>${it.name_matched && it.name_matched !== it.name ? ` → 已匹配: ${escapeHtml(it.name_matched)}` : ''}<span class="muted">)</span>` : '';
      const delCls = it.__delete ? ' row-deleted' : '';
      const delBtn = `<button class="btn danger" data-del-i="${i}">${it.__delete ? '恢复' : '删除'}</button>`;
      if (isTrade) {
        html += `<div class="row${delCls}">
          <span>基金${i + 1} 代码</span>
          <input data-i="${i}" data-f="fund_code" value="${it.fund_code || ''}" />
          ${nameHint}
          <button class="btn secondary" data-search-i="${i}">搜代码</button>
          <select data-i="${i}" data-f="type">
            <option value="buy" ${it.type === 'buy' ? 'selected' : ''}>买入</option>
            <option value="sell" ${it.type === 'sell' ? 'selected' : ''}>卖出</option>
          </select>
          <span>金额</span><input data-i="${i}" data-f="amount" value="${it.amount ?? ''}" />
          <span>份额</span><input data-i="${i}" data-f="shares" value="${it.shares ?? ''}" />
          <span>日期</span><input data-i="${i}" data-f="date" value="${it.date ?? ''}" />
          ${delBtn}
        </div>`;
      } else {
        html += `<div class="row${delCls}">
          <span>基金${i + 1} 代码</span>
          <input data-i="${i}" data-f="code" value="${it.code || ''}" />
          ${nameHint}
          <button class="btn secondary" data-search-i="${i}">搜代码</button>
          <span>市值(元)</span><input data-i="${i}" data-f="market_value" value="${it.market_value ?? ''}" />
          <span>份额(可空)</span><input data-i="${i}" data-f="shares" value="${it.shares ?? ''}" placeholder="拉到净值后自动算" />
          <span>累计盈亏(元)</span><input data-i="${i}" data-f="hold_profit" value="${it.hold_profit ?? ''}" />
          <span>昨日收益(元)</span><input data-i="${i}" data-f="yest_profit" value="${it.yest_profit ?? ''}" />
          ${delBtn}
        </div>`;
      }
    });
  }
  html += `<div style="margin-top:14px"><button class="btn" id="btn-save-ocr">保存到数据库</button></div>`;
  html += `<div style="margin-top:14px"><button class="btn secondary" id="btn-toggle-raw">查看原始OCR文本</button></div>`;
  html += `<pre id="ocr-raw" class="raw hidden">${escapeHtml(parsed.ocr_text || '')}</pre>`;
  box.innerHTML = html;

  const toggleBtn = safeGet('btn-toggle-raw');
  if (toggleBtn) toggleBtn.onclick = () => safeGet('ocr-raw').classList.toggle('hidden');
  safeGet('btn-save-ocr').onclick = () => saveOcr(parsed, platform, kind, file_path);

  // 删除/恢复单行(识别结果可编辑修正)
  box.querySelectorAll('button[data-del-i]').forEach((btn) => {
    btn.onclick = () => {
      const i = +btn.dataset.delI;
      const it = (kind === 'trade' ? parsed.txs : parsed.funds)[i];
      if (!it) return;
      it.__delete = !it.__delete;
      renderOcrResult(parsed, platform, kind, file_path);
    };
  });

  // 名称 -> 代码 搜索按钮
  box.querySelectorAll('button[data-search-i]').forEach((btn) => {
    btn.onclick = async () => {
      const i = +btn.dataset.searchI;
      const it = (kind === 'trade' ? parsed.txs : parsed.funds)[i];
      const q = (it && (it.name || '')) || prompt('输入基金名称进行搜索');
      if (!q) return;
      btn.textContent = '搜索中…';
      try {
        const list = await api('/fund-search', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: q }),
        });
        if (!list.length) { alert('未找到匹配基金: ' + q); return; }
        const opts = list.slice(0, 10).map((c, idx) => `${idx + 1}. ${c.code} ${c.name}`).join('\n');
        const pick = prompt(`选择基金代码 (输入序号):\n${opts}`, '1');
        const idx = parseInt(pick, 10) - 1;
        if (isNaN(idx) || !list[idx]) return;
        const codeInput = box.querySelector(`input[data-i="${i}"][data-f="${isTrade ? 'fund_code' : 'code'}"]`);
        if (codeInput) codeInput.value = list[idx].code;
      } catch (e) {
        alert('搜索失败: ' + e.message);
      } finally {
        btn.textContent = '搜代码';
      }
    };
  });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function collectOcrInputs(parsed) {
  const inputs = document.querySelectorAll('#ocr-result input, #ocr-result select');
  const items = JSON.parse(JSON.stringify(parsed.funds || parsed.txs || []));
  const NUM_FIELDS = ['amount', 'shares', 'market_value', 'hold_profit', 'yest_profit', 'yest_pct'];
  inputs.forEach((inp) => {
    const i = +inp.dataset.i;
    const f = inp.dataset.f;
    let v = inp.value;
    if (NUM_FIELDS.includes(f)) v = v === '' ? null : parseFloat(v);
    if (items[i]) items[i][f] = v;
  });
  return items;
}

async function saveOcr(parsed, platform, kind, file_path) {
  const items = collectOcrInputs(parsed);
  try {
    for (const it of items) {
      if (it.__delete) continue; // 已标记删除的识别项不入库
      const code = kind === 'trade' ? it.fund_code : it.code;
      if (!code) continue; // 无代码的识别项跳过(可在前端修改后保存)
      if (kind === 'trade') {
        await api('/transactions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fund_code: it.fund_code, platform, type: it.type, amount: it.amount, shares: it.shares, tx_date: it.date, source: 'screenshot' }),
        });
        try {
          await api('/funds/' + it.fund_code + '/refresh', { method: 'POST' });
        } catch (e) {
          console.warn('refresh 失败(已忽略):', it.fund_code, e.message);
        }
      } else {
        await api('/funds', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: it.code, name: it.name || '', platform }),
        });
        // 刷新净值: 尽力而为, 无网络/超时不中断保存(否则持仓存不进库)
        try {
          await api('/funds/' + it.code + '/refresh', { method: 'POST' });
        } catch (e) {
          console.warn('refresh 失败(已忽略):', it.code, e.message);
        }
        await api('/holdings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fund_code: it.code, platform, shares: it.shares, market_value: it.market_value,
            hold_profit: it.hold_profit, yest_profit: it.yest_profit, yest_pct: it.yest_pct,
          }),
        });
      }
    }
    alert('已保存');
    loadEstimate(); loadFunds(); loadTransactions();
  } catch (e) {
    alert('保存失败: ' + e.message);
  }
}

/* ---------- 基金/持仓管理 ---------- */
async function onAddFund() {
  const code = safeGet('fund-code').value.trim();
  if (!code) return;
  try {
    await api('/funds/' + code + '/refresh', { method: 'POST' });
    safeGet('fund-code').value = '';
    loadFunds();
  } catch (e) {
    alert('拉取失败: ' + e.message);
  }
}

async function loadFunds() {
  try {
    const funds = await api('/funds');
    const body = safeGet('funds-body');
    body.innerHTML = '';
    for (const f of funds) {
      const stocks = await api('/funds/' + f.code + '/stocks').catch(() => []);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${f.name || '--'}</td>
        <td>${f.code}</td>
        <td>${f.type || '--'}</td>
        <td>${f.platform || '--'}</td>
        <td>${fmt(f.latest_nav, 4)}</td>
        <td>${f.nav_date || '--'}</td>
        <td>${stocks.length}</td>
        <td><button class="btn secondary" data-refresh="${f.code}">刷新</button></td>`;
      tr.querySelector('button').onclick = async (e) => {
        await api('/funds/' + e.target.dataset.refresh + '/refresh', { method: 'POST' });
        loadFunds();
      };
      body.appendChild(tr);
    }
  } catch (e) {
    console.error('loadFunds 失败', e);
    const body = safeGet('funds-body');
    if (body) body.innerHTML = `<tr><td colspan="8" class="muted">加载失败: ${e.message}</td></tr>`;
  }
}

/* ---------- 交易记录 ---------- */
async function loadTransactions() {
  try {
    const funds = await api('/funds');
    const nameMap = Object.fromEntries(funds.map((f) => [f.code, f.name]));
    const txs = await api('/transactions');
    const body = safeGet('tx-body');
    body.innerHTML = '';
    txs.forEach((t) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${nameMap[t.fund_code] || '--'} (${t.fund_code})</td>
        <td>${t.platform || '--'}</td>
        <td>${t.type === 'buy' ? '买入' : t.type === 'sell' ? '卖出' : t.type}</td>
        <td>${fmt(t.amount)}</td>
        <td>${fmt(t.shares)}</td>
        <td>${fmt(t.nav, 4)}</td>
        <td>${t.tx_date || '--'}</td>
        <td>${t.source || '--'}</td>`;
      body.appendChild(tr);
    });
  } catch (e) {
    console.error('loadTransactions 失败', e);
    const body = safeGet('tx-body');
    if (body) body.innerHTML = `<tr><td colspan="8" class="muted">加载失败: ${e.message}</td></tr>`;
  }
}

/* ---------- Tab 切换 ---------- */
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  const panel = safeGet('tab-' + tab.dataset.tab);
  if (panel) panel.classList.add('active');
  if (tab.dataset.tab === 'funds') loadFunds();
  if (tab.dataset.tab === 'transactions') loadTransactions();
}

function bindUi() {
  // 优先绑定 tab 切换，确保即使后续数据加载出错也不影响标签切换
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => switchTab(tab);
  });

  const btnOcr = safeGet('btn-ocr');
  if (btnOcr) btnOcr.onclick = onOcrClick;
  const btnAdd = safeGet('btn-add-fund');
  if (btnAdd) btnAdd.onclick = onAddFund;
  const btnRefresh = safeGet('btn-refresh');
  if (btnRefresh) btnRefresh.onclick = async () => {
    const original = btnRefresh.textContent;
    btnRefresh.disabled = true;
    btnRefresh.textContent = '刷新净值中...';
    try {
      await api('/funds/refresh-all', { method: 'POST' });
      await loadEstimate();
    } catch (e) {
      console.warn('刷新净值失败(可能无网络):', e.message);
      alert('刷新净值失败：' + e.message + '\n（请检查网络，净值需联网从东方财富获取）');
    } finally {
      btnRefresh.disabled = false;
      btnRefresh.textContent = original;
    }
  };

  // 持仓列表: 明细 / 删除 (事件委托, 避免 DOM 重建导致绑定丢失)
  const hbody = safeGet('holdings-body');
  if (hbody) {
    hbody.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('[data-del]');
      if (delBtn) {
        const code = delBtn.getAttribute('data-del');
        if (!confirm(`确定删除基金 ${code} 的持仓？此操作不可恢复。`)) return;
        delBtn.disabled = true;
        delBtn.textContent = '删除中...';
        try {
          await api(`/holdings/${code}`, { method: 'DELETE' });
          await loadEstimate();
        } catch (err) {
          alert('删除失败：' + err.message);
          delBtn.disabled = false;
          delBtn.textContent = '删除';
        }
        return;
      }
      const detailBtn = e.target.closest('[data-detail]');
      if (detailBtn) {
        const code = detailBtn.getAttribute('data-detail');
        try {
          const data = await api('/estimate');
          const f = data.funds.find((x) => x.fund_code === code);
          if (f) toggleDetail(f);
        } catch (err) {
          console.error('加载明细失败', err);
        }
      }
    });
  }

  // 类型筛选 chips: 点击切换 currentTypeFilter 并就地重渲(不重新发请求)
  const typeFilterEl = safeGet('type-filter');
  if (typeFilterEl) {
    typeFilterEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.type-chip');
      if (!chip) return;
      currentTypeFilter = chip.getAttribute('data-type') || 'all';
      renderHoldings();
    });
  }
  // 平台筛选联动: 点击平台图例 / 分布条 -> 过滤下方持仓表(只看该平台当日盈亏构成)
  // 事件委托绑定在容器上(容器本身不变, 仅 innerHTML 重建), 再次点击同一平台则取消筛选
  const psLegend = safeGet('ps-legend');
  if (psLegend) {
    psLegend.addEventListener('click', (e) => {
      const item = e.target.closest('[data-platform]');
      if (!item) return;
      const p = item.getAttribute('data-platform');
      currentPlatformFilter = (currentPlatformFilter === p) ? 'all' : p;
      renderHoldings();
      renderPlatformStats();
    });
  }
  const psBar = safeGet('ps-bar');
  if (psBar) {
    psBar.addEventListener('click', (e) => {
      const seg = e.target.closest('[data-platform]');
      if (!seg) return;
      const p = seg.getAttribute('data-platform');
      currentPlatformFilter = (currentPlatformFilter === p) ? 'all' : p;
      renderHoldings();
      renderPlatformStats();
    });
  }
  // 持仓区"平台筛选"指示 chip: 点击清除平台筛选
  const pfEl = safeGet('platform-filter');
  if (pfEl) {
    pfEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear-platform]')) {
        currentPlatformFilter = 'all';
        renderHoldings();
        renderPlatformStats();
      }
    });
  }
  // 按类型分组开关
  const groupToggle = safeGet('group-by-type');
  if (groupToggle) {
    groupToggle.addEventListener('change', (e) => {
      groupByType = e.target.checked;
      renderHoldings();
    });
  }

  // 初始化数据（各自独立 try-catch，互不阻塞）
  loadEstimate().catch((e) => console.error('loadEstimate 失败', e));
  loadFunds().catch((e) => console.error('loadFunds 失败', e));
  loadTransactions().catch((e) => console.error('loadTransactions 失败', e));
  setInterval(() => {
    const active = document.querySelector('.tab.active');
    if (active && active.dataset.tab === 'holdings') loadEstimate().catch(() => {});
  }, 10 * 60 * 1000);
}

// app.js 位于 </body> 之前，执行时 DOM 已就绪，直接绑定即可。
bindUi();
