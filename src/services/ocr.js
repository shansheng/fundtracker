/**
 * OCR 截图识别模块
 * 使用 tesseract.js 本地 OCR 提取截图文字，再通过规则解析
 * 支持三类平台: 支付宝(alipay) / 京东金融(jd) / 腾讯理财通(licaitong)
 * 两类截图: 持仓(holding) / 交易(trade)
 *
 * 说明: 各平台 OCR 文本布局存在差异，解析器以"稳健优先"为原则，
 * 提取不到的字段留空，交由前端让用户确认/补全。
 */
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');

let _worker = null;
async function getWorker() {
  if (!_worker) {
    _worker = await Tesseract.createWorker('chi_sim+eng');
  }
  return _worker;
}

/**
 * 对图片做 OCR，返回纯文本
 */
async function ocrImage(filePath) {
  const worker = await getWorker();
  const { data } = await worker.recognize(filePath);
  return data.text || '';
}

// 从文本中提取金额
// 为避免把基金代码(如 110011)误判为金额，仅匹配：
//   - 带货币符号 ¥/￥ 的数字
//   - 后接 "元/块" 的数字
//   - 含千分位逗号或小数点的数字
// 纯 6 位整数(基金代码)会被排除。
function extractAmounts(text) {
  const amounts = [];
  const re = /(?:[¥￥]\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:元|块)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(v) && v > 0) amounts.push(v);
  }
  // 也支持带货币符号但无"元"的情况，如 ¥12,345.67
  const re2 = /[¥￥]\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
  while ((m = re2.exec(text)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(v) && v > 0 && !amounts.includes(v)) amounts.push(v);
  }
  return amounts;
}

// 提取份额: 支持 "1234.56份" / "持有份额 1234.56" / "份额1234.56" 等
function extractShares(text) {
  const out = [];
  // 1) 显式带"份"字
  const re1 = /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*份/g;
  let m;
  while ((m = re1.exec(text)) !== null) out.push(parseFloat(m[1].replace(/,/g, '')));
  if (out.length) return out;
  // 2) "持有份额"/"份额" 后紧跟的数字
  const re2 = /(?:持有\s*份额|份额)\D{0,4}(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g;
  while ((m = re2.exec(text)) !== null) out.push(parseFloat(m[1].replace(/,/g, '')));
  return out;
}

// 从一行(已去空格)中提取"基金名候选"
// 宽松模式(默认): 取首个金额起点前的中英数字/括号片段, 支持名称含数字(如 "兴全恒惠30天")
// 严格模式(strict): 遇到"符号/小数/千分位"开头的金额即截断, 用于数值行避免把收益率数字吃进名
function extractNameCand(compact, strict) {
  const re = strict
    // 严格模式: 遇到金额起点截断; 但"数字+天/年/月"是名称一部分(如"30天")不截断
    // 字符集含 "…"(OCR 省略号), 使 "公司ETF发起式…+16.22" 可在 "…" 处合法截断, 再由 finishFund 清理尾噪
    ? /^([一-龥A-Za-z0-9（）()·.\-…]*?)(?=(?:[-+]?\d+(?:\.\d+)?)(?![天年月份])|,)/
    : /^([一-龥A-Za-z0-9（）()·.\-…]+)/;
  const m = compact.match(re);
  return m ? m[1].trim() : '';
}

// 表头/噪声词: 这些出现在 OCR 文本里但不是基金名 (用于拒绝判定)
const NOISE_WORDS = [
  '基金', '我的持有', '金额排序', '偏股', '偏债', '黄金', '名称', '金额', '昨日', '收益',
  '持有收益', '收益率', '市场', '排行', '自选', '超额', '全部', '更多',
  '资产', '总收益', '累计', '明细', '估值', '涨跌', '今日', '昨日', '净值', '份额', '成本',
  '排序', '指数基金', '高端装备股票', '高质量混合',
  // 注意: "稳健" 是基金名常见字(如格林稳健价值), 不可作噪声词
];
// 基金名必含的类型特征词 (白名单, "指数"属于此类, 不列入噪声)
const FUND_TYPE_WORDS = [
  '混合', '股票', '债券', '债', '短债', '超短债', '指数', '货币', 'ETF', 'LOF', '联接', '精选', '成长', '价值', '稳健',
  '配置', '增强', '发起式', '定期开放', 'QDII', 'FOF', '养老', '消费', '医疗', '科技', '新能源',
  '白酒', '证券', '沪深300', '中证', '资源', '环保', '健康', '保健',
];

// 京东金融等截图 OCR 常把金额的千分位逗号 "," 误识别成点 "."（如 4,211.72 -> 4.211.72）。
// 归一化: 把 "数字.3位数字(.2位小数)" 中第一个点还原为千分位逗号, 仅当其后紧跟非数字(行尾/中文)。
// 用 (?=[^\d]|$) 约束, 避免误伤正常多位小数(如净值 1.2345 后面还有数字, 不会被改)。
function normalizeThousands(text) {
  return text.replace(/(\d{1,3})\.(\d{3})(?:\.(\d{2}))?(?=[^\d]|$)/g, (m, a, b, c) =>
    c !== undefined ? `${a},${b}.${c}` : `${a},${b}`
  );
}

// 判断一行是否为"纯数值行"(几乎全是数字/符号/空白, 不含汉字、不含冒号、不含字母)
// 支付宝数值行形如: "16,117.50 -9,788.47" / "+203.00 -36.53%" / "8,168.64 -292.75"
// 排除: "14:34 E 59"(时间行) / 含汉字的行
function isNumberLine(line) {
  const t = line.trim();
  if (/[一-龥]/.test(t)) return false;       // 含汉字 -> 不是纯数值行
  if (/:/.test(t)) return false;             // 含冒号(时间) -> 排除
  if (/[A-Za-z]/.test(t)) return false;      // 含字母 -> 排除(如 "E 59")
  if (!/\d/.test(t)) return false;           // 必须含数字
  // 行内非数字/非符号/非空白字符占比应极低
  const stripped = t.replace(/[\d,+\-%.¥￥\s]/g, '');
  return stripped.length === 0;
}

// 从一行提取所有带符号的数值, 返回 [{raw, value, signed, pct}]
// 支持: 16,117.50  -9,788.47  +203.00  -36.53%  .…
function extractNumbers(line) {
  const out = [];
  const re = /([+\-]?[\d,]+(\.\d+)?)\s*(%?)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const raw = m[1];
    if (raw === '-' || raw === '+') continue; // 孤立符号
    const value = parseFloat(raw.replace(/,/g, ''));
    if (isNaN(value)) continue;
    out.push({ raw, value, signed: /^[+\-]/.test(raw), pct: m[3] === '%' });
  }
  return out;
}

// 判断一个中文候选串是否像基金名 (非纯噪声)
function looksLikeFundName(s) {
  s = (s || '').replace(/\s/g, '').trim();
  if (s.length < 3) return false;
  if (s.length > 24) return false; // 过长一般是多行粘连或表头
  // 含明显表头噪声词 -> 拒绝
  if (NOISE_WORDS.some((w) => s.includes(w))) return false;
  // 必须含至少一个汉字
  if (!/[一-龥]/.test(s)) return false;
  // 必须含基金类型特征词, 或长度足够长(>=6)且无噪声
  const hasType = FUND_TYPE_WORDS.some((w) => s.includes(w));
  if (hasType) return true;
  return s.length >= 6;
}

/**
 * 支付宝持仓截图解析 (只有名称+金额, 无代码)
 * 版式规律(实测): 每个基金占一个"块", 名称行(1~2行中文)后紧跟数值行(2行):
 *   行1数值: 持仓金额  持有收益        (正数无符号/负数带-)
 *   行2数值: 昨日收益  收益率           (均带+/-, 收益率带%)
 * 由于 OCR 把姓名列与金额列拆成独立行, 采用"攒名 + 消费数值"策略:
 *   1) 连续的中文行累积为当前基金名
 *   2) 数值行成对消费: 第一个数值块->持仓金额+持有收益, 第二个->昨日收益+收益率
 */
function parseFundsByName(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => normalizeThousands(l).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // 过滤非持仓噪声行: 顶部状态栏(时钟/账号)、表头、底部导航、广告弹窗等
  const SKIP_LINE = [
    /^\d{1,2}:\d{2}/,                 // 顶部时钟 如 "13:50"
    /我的持有|金额排序/,
    /偏股|偏债|指数|黄金/,
    /名称|昨日收益|持有收益|率$/,
    /基金市场|排行|自选|持有$/,
    /周报|产品周报|突破|关键点位|广告|市场有风险|风险提示/,
    /全部|更多|明细|估值|涨跌|今日/,
    /^\s*[《（(].*$/,                  // 孤立标点行(如 "《 基金")
    /关注榜|榜单|No\.?\d/i,            // 京东"在关注榜 No7"等榜单/广告行
    /交易[:：].*笔|买入中合计|合计\d|成交笔数/,  // 京东"交易:1笔买入中合计50.00元"等汇总行
    /^基金|^理财/,                    // 京东底部导航"基金 稳健..." / 顶部"理财师"
  ];
  const isSkipLine = (l) => {
    const cl = l.replace(/\s/g, ''); // 用紧凑串匹配, 避免 OCR 在关键词间插入空格导致漏判
    return SKIP_LINE.some((re) => re.test(cl)) && !/\d{3,}(?:[.,]\d+)?/.test(cl);
  };

  // 状态机: 逐行解析支付宝"我的持有"列表
  // 每个基金 = 名称片段(可能跨多行) + 数值块(2行: 行1=持仓金额/持有收益, 行2=昨日收益/收益率%)
  // 难点: 名称第2行常与数值第2行(含%)在同一物理行, 如 "混合A -54.08 -6.34%"
  const found = [];
  let cur = null;          // 当前正在构建的基金对象
  let nameBuffer = [];     // 当前基金未决的名称片段(跨多行)

  const startFund = (name) => {
    // 先把上一个未完成的基金收尾
    if (cur) {
      cur.name = nameBuffer.join('').replace(/\s/g, '').trim() || cur.name;
      found.push(cur);
    }
    cur = { name: name || '', market_value: null, hold_profit: null, yest_profit: null, yest_pct: null };
    nameBuffer = name ? [name.replace(/\s/g, '')] : [];
  };
  const finishFund = () => {
    if (cur) {
      let nm = nameBuffer.join('').replace(/\s/g, '').trim();
      // 清理名字中的残留数字:
      //  - 保留含时间单位的数字, 如 "兴全恒惠30天"(30 后接"天")
      //  - 删除金额粘连进名的孤立数字(中文+1~2位数字+中文, 如 "长城医疗保健5混合A" -> "长城医疗保健混合A")
      nm = nm.replace(/([一-龥])\d{1,2}(?=[一-龥])/g, '$1');
      // 删除行尾紧贴金额的孤立数字(如 "鹏华酒指数C16" -> "鹏华酒指数C")
      nm = nm.replace(/(\d+)([天年月份]?)$/, (m, num, unit) => (unit ? m : ''));
      nm = nm.replace(/[.\-…]+$/, '').trim();
      cur.name = nm || cur.name;
      // 只要有持仓金额就保留(名字即使不完美也可在 resolveNames 阶段补全)
      if (cur.market_value != null) found.push(cur);
      cur = null;
      nameBuffer = [];
    }
  };

  for (const line of lines) {
    if (isSkipLine(line)) continue;        // 跳过状态栏/表头/导航/广告行
    const compact = line.replace(/\s/g, '');
    const hasCn = /[一-龥]/.test(compact);
    const nums = extractNumbers(compact);
    const hasPct = nums.some((x) => x.pct);     // 含% -> 这是某基金第2行数值(昨日/收益率)
    const hasNameNum = hasCn && nums.length;     // 中文 + 数字

    if (!hasCn && !nums.length) continue;        // 空/纯符号

    if (hasPct) {
      // 第2行数值: 补给"当前未完成基金"(其 block 应已有第1行)
      if (!cur) startFund('');
      const secondLine = nums;
      if (secondLine[0]) cur.yest_profit = secondLine[0].value;
      if (secondLine[1]) cur.yest_pct = secondLine[1].value;
      // 同行中文补充名称(如 "公司ETF发起式…+16.22 -4.28%" / "混合A -54.08 -6.34%")
      // 第2行数字都在中文之后, 用宽松模式取首个金额前的全部中文(不会被收益率数字污染),
      // 且遇到 OCR 省略号"…"自然截断, 避免严格模式把含"…"的续名整段丢弃
      if (hasCn) {
        const cand = extractNameCand(compact, true);
        if (looksLikeFundName(cand)) nameBuffer.push(cand);
      }
      finishFund();
    } else if (hasNameNum) {
      // 含数字但无% -> 第1行数值(持仓金额/持有收益) + 可能含基金名第1行
      // 用严格模式提取名称, 避免把同行的持仓金额(如 "格林稳健价值4,512.92")吞进名
      const cand = extractNameCand(compact, true);
      if (looksLikeFundName(cand)) {
        startFund(cand);
      } else if (!cur) {
        startFund('');
      }
      // 京东/支付宝第1行数值 = 持仓金额(最大正数,通常含千分位逗号) + 持有收益(带符号数)
      // 京东的持有收益也可能 >=100 且带符号, 不能简单按 >=100 过滤, 故按"符号/最大值"分离
      const signedNums = nums.filter((n) => n.signed);
      const posNums = nums.filter((n) => !n.signed);
      let mv = null;
      if (posNums.length) {
        const withComma = posNums.filter((n) => n.raw.includes(','));
        const pool = withComma.length ? withComma : posNums;
        mv = Math.max(...pool.map((n) => n.value));
      }
      if (mv != null && cur.market_value == null) cur.market_value = mv;
      if (signedNums[0]) cur.hold_profit = signedNums[0].value;
      else if (posNums.length > 1 && cur.hold_profit == null) {
        // 无符号时, 取"非最大正数"作为持有收益(次大值)
        const sorted = [...posNums].map((n) => n.value).sort((a, b) => b - a);
        cur.hold_profit = sorted[1];
      }
    } else if (hasCn) {
      // 纯中文行: 名称片段(可能是新基金的第1行名, 也可能是上一基金名的续行)
      const cand = extractNameCand(compact);
      if (looksLikeFundName(cand)) {
        if (!cur) startFund(cand);            // 新基金开始
        else nameBuffer.push(cand);           // 续接上一基金名
      } else {
        // 噪声词行: 若当前基金已收齐数值则收尾
        if (cur && cur.yest_pct != null) finishFund();
      }
    } else if (nums.length) {
      // 纯数值行(无中文无%): 当作某基金第2行数值(兜底)
      if (!cur) startFund('');
      if (nums[0]) cur.yest_profit = nums[0].value;
      if (nums[1]) cur.yest_pct = nums[1].value;
      finishFund();
    }
  }
  finishFund();

  return found;
}

// 判断 OCR 文本中是否含可识别的基金代码
function hasFundCodes(text) {
  return /\b\d{6}\b/.test(text);
}

/**
 * 解析持仓截图文本
 * 策略:
 *  1) 若含 6 位基金代码 -> 按代码解析 (兼容京东/理财通有代码的截图)
 *  2) 否则 -> 按基金名称解析 (支付宝持仓场景), 名称稍后由 resolveNames 补全代码
 * 返回: { platform, funds: [{code?, name?, market_value?, shares?, cost?}] }
 */
function parseHolding(text, platform) {
  if (hasFundCodes(text)) {
    // 有代码时, 仍尝试把整段金额/份额按位置配对(稳健优先)
    const codes = [...new Set((text.match(/\b(\d{6})\b/g) || []))];
    const amounts = extractAmounts(text);
    const shares = extractShares(text);
    const funds = codes.map((code, i) => ({
      code,
      name: '',
      market_value: amounts[i] || null,
      shares: shares[i] || null,
      cost: null,
    }));
    return { platform, kind: 'holding', funds };
  }
  // 无代码: 按名称解析
  const named = parseFundsByName(text);
  const funds = named.map((n) => ({
    code: '',
    name: n.name,
    market_value: n.market_value,
    shares: null,
    hold_profit: n.hold_profit ?? null,
    yest_profit: n.yest_profit ?? null,
    yest_pct: n.yest_pct ?? null,
    cost: null,
  }));
  return { platform, kind: 'holding', funds, by_name: true };
}

/**
 * 解析交易截图文本
 * 交易截图一般含代码或金额, 逻辑同前; 无代码时按名称
 * 返回: { platform, txs: [{fund_code, name?, type, amount, shares, nav, date}] }
 */
function parseTrade(text, platform) {
  const isBuy = /买入|申购|定投|购买/.test(text);
  const isSell = /卖出|赎回|售出/.test(text);
  const type = isSell ? 'sell' : isBuy ? 'buy' : 'buy';
  const dateM = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
  const timeM = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})/);
  const date = timeM ? timeM[1] : dateM ? dateM[1] : null;

  if (hasFundCodes(text)) {
    const codes = [...new Set((text.match(/\b(\d{6})\b/g) || []))];
    const amounts = extractAmounts(text);
    const shares = extractShares(text);
    const txs = codes.map((fund_code, i) => ({
      fund_code,
      name: '',
      type,
      amount: amounts[i] || null,
      shares: shares[i] || null,
      nav: null,
      date,
    }));
    return { platform, kind: 'trade', txs };
  }
  const named = parseFundsByName(text);
  const shares = extractShares(text);
  const txs = named.map((n, i) => ({
    fund_code: '',
    name: n.name,
    type,
    amount: n.market_value || null,
    shares: shares[i] || null,
    nav: null,
    date,
  }));
  return { platform, kind: 'trade', txs, by_name: true };
}

/**
 * 对解析结果中"只有名称无代码"的基金, 调用公共接口按名称查代码
 * 在 OCR 服务端自动补全; 每个名称取搜索结果中第一个精确/包含匹配项
 * @returns 同样的 result, 但 funds/txs 的 code 字段被填充(无法匹配的留空)
 */
async function resolveNames(result) {
  if (!result.by_name) return result; // 已有代码, 无需补全
  const { searchFundByName } = require('./fundInfo');
  const list = result.kind === 'trade' ? result.txs : result.funds;
  for (const it of list) {
    const nm = (it.name || '').trim();
    if (!nm || it.code) continue;
    const candidates = await searchFundByName(nm);
    if (candidates.length) {
      // 优先精确匹配, 否则取首个
      const exact = candidates.find((c) => c.name === nm || c.name.replace(/\s/g, '') === nm.replace(/\s/g, ''));
      const pick = exact || candidates[0];
      it.code = pick.code;
      it.name_matched = pick.name; // 记录接口返回的真实名称, 供前端展示核对
    }
  }
  return result;
}

/**
 * 主入口: 识别截图
 * @param {string} filePath 图片路径
 * @param {string} platform alipay/jd/licaitong
 * @param {string} kind holding/trade
 */
async function recognizeScreenshot(filePath, platform, kind) {
  if (!fs.existsSync(filePath)) throw new Error('文件不存在: ' + filePath);
  const text = await ocrImage(filePath);
  const result =
    kind === 'trade' ? parseTrade(text, platform) : parseHolding(text, platform);
  result.ocr_text = text;
  return result;
}

module.exports = { recognizeScreenshot, ocrImage, parseHolding, parseTrade, resolveNames };

// 测试用：node src/services/ocr.js <file> <platform> <kind>
if (require.main === module) {
  (async () => {
    const [, , file, platform = 'alipay', kind = 'holding'] = process.argv;
    if (!file) return console.log('用法: node ocr.js <图片路径> <platform> <kind>');
    const r = await recognizeScreenshot(file, platform, kind);
    if (r.by_name) await resolveNames(r);
    console.log(JSON.stringify(r, null, 2));
    if (_worker) await _worker.terminate();
  })();
}
