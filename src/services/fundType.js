/**
 * 基金类型分类器 (离线, 零依赖)
 *
 * 用途: 对"名称已存在但 type 为空"的基金, 仅凭名称关键词推断类型。
 * 在线刷新(fundInfo.getFundBase)返回东方财富 fundtype 字段为权威来源, 本模块仅用于离线回填。
 *
 * 优先级(从高到低): 货币 > QDII > FOF > 债券 > 指数(ETF/联接/增强) > 股票 > 混合。
 * 注意: 名称常被 OCR 截断(如 "富国高质量混" = 富国高质量混合A), 故对"混"等单字也做匹配。
 */

// 规则表: 顺序即优先级。命中首个即返回。
const TYPE_RULES = [
  { type: '货币型', re: /货币/ },
  { type: 'QDII', re: /QDII|合格境内|沪港通|深港通|港股通|沪港深/ },
  { type: 'FOF', re: /FOF|养老目标/ },
  {
    type: '债券型',
    re: /(债券|短债|中短债|纯债|信用债|利率债|可转债|债基|超短债)/,
  },
  {
    type: '指数型',
    re: /(指数|ETF|联接|增强|沪港深|港股通)/,
  },
  { type: '股票型', re: /(股票|股基)/ },
  {
    type: '混合型',
    re: /(混合|混$|配置|灵活|平衡|精选|价值|成长|稳健|量化|偏股|偏债|双息)/,
  },
];

/**
 * 根据基金名称推断类型
 * @param {string} name 基金名称
 * @returns {string|null} 类型枚举(货币型/QDII/FOF/债券型/指数型/股票型/混合型/其他) 或 null
 */
function classifyFundType(name) {
  if (!name || !name.trim()) return null;
  const n = name.trim();
  for (const r of TYPE_RULES) {
    if (r.re.test(n)) return r.type;
  }
  return '其他';
}

/**
 * 规范化类型字符串(兼容东方财富在线返回的英文/异体类型)
 * @param {string} raw 原始 type(可能为空、中文、或东财英文字段)
 * @param {string} [name] 名称, 当 raw 无法识别时用于离线推断
 * @returns {string} 统一后的类型枚举
 */
function normalizeFundType(raw, name) {
  if (raw && typeof raw === 'string') {
    const r = raw.trim();
    // 已是我们枚举值
    const known = ['货币型', 'QDII', 'FOF', '债券型', '指数型', '股票型', '混合型', '其他'];
    if (known.includes(r)) return r;
    // 东方财富常见英文字段/中文异体
    if (/货币/.test(r) || /money|mmf/i.test(r)) return '货币型';
    if (/qdii/i.test(r) || /沪港深|港股通/.test(r)) return 'QDII';
    if (/fof/i.test(r) || /养老/.test(r)) return 'FOF';
    if (/债券|债基|bond/i.test(r)) return '债券型';
    if (/指数|etf|联接|增强|index/i.test(r)) return '指数型';
    if (/股票|equity|stock/i.test(r)) return '股票型';
    if (/混合|配置|灵活|平衡|偏股|偏债/i.test(r)) return '混合型';
  }
  return classifyFundType(name);
}

module.exports = { classifyFundType, normalizeFundType, TYPE_RULES };
