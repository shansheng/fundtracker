const { parseTrade, parseHolding, parseAlipayTrade, parseJDTrade, pickBestMatch } = require('../src/services/ocr');
const test = require('node:test');
const assert = require('node:assert');

test('parseTrade: 买入 + 6位代码 + 金额 + 日期', () => {
  const text = '买入\n001111\n2000.00元\n2026-08-14';
  const r = parseTrade(text, 'alipay');
  assert.strictEqual(r.kind, 'trade');
  assert.strictEqual(r.txs.length, 1);
  assert.strictEqual(r.txs[0].fund_code, '001111');
  assert.strictEqual(r.txs[0].type, 'buy');
  assert.strictEqual(r.txs[0].amount, 2000);
  assert.strictEqual(r.txs[0].date, '2026-08-14');
});

test('parseTrade: 赎回 -> sell', () => {
  const text = '赎回\n002222\n1500.00元';
  const r = parseTrade(text, 'alipay');
  assert.strictEqual(r.txs[0].type, 'sell');
  assert.strictEqual(r.txs[0].fund_code, '002222');
});

test('parseTrade: 无买入/赎回关键词默认 buy', () => {
  const text = '003333\n800.00元';
  const r = parseTrade(text, 'jd');
  assert.strictEqual(r.txs[0].type, 'buy');
  assert.strictEqual(r.txs[0].fund_code, '003333');
});

test('parseHolding: 含 6 位代码 -> 按代码解析', () => {
  const text = '003333\n8000.00元';
  const r = parseHolding(text, 'alipay');
  assert.strictEqual(r.kind, 'holding');
  assert.strictEqual(r.funds.length, 1);
  assert.strictEqual(r.funds[0].code, '003333');
  assert.strictEqual(r.funds[0].market_value, 8000);
});

test('parseTrade: 多只基金按代码分别解析', () => {
  const text = '买入\n001111 2000.00元\n002222 1500.00元';
  const r = parseTrade(text, 'alipay');
  assert.strictEqual(r.txs.length, 2);
  assert.deepStrictEqual(
    r.txs.map((t) => t.fund_code).sort(),
    ['001111', '002222']
  );
});

const LICAITONG_TEXT = `21:32
腾讯理财通
资产明细 筛选 按持有金额排序
易方达北证50指数C
持有金额 持仓收益 昨日收益
5,591.46 -580.84 -50.04
宏利消费红利指数C
持有金额 持仓收益 昨日收益
5,060.91 -493.77 -45.49
华夏国证半导体芯片ETF联接C
持有金额 持仓收益 昨日收益
2,819.27 +112.35 +22.72
景顺长城能源基建混合A
持有金额 持仓收益 昨日收益
2,565.18 +457.41 +13.37
东方红稳健精选混合C
持有金额 持仓收益 昨日收益
2,008.99 +63.19 =2.22
南方致远混合E
持有金额 持仓收益 昨日收益
1,003.46 +3.46 +1.08
产品解读 恭喜！你的致远近1月跑赢沪深300 详情`;

test('pickBestMatch: 截图省略"成份"二字仍能选对基金', () => {
  // 模拟东方财富搜索 "易方达北证50指数C" 的真实返回(首条并非目标, 第三条才是)
  const candidates = [
    { code: '025665', name: '中金北证50指数增强发起C' },
    { code: '025664', name: '中金北证50指数增强发起A' },
    { code: '017516', name: '易方达北证50成份指数C' },
    { code: '017515', name: '易方达北证50成份指数A' },
    { code: '012875', name: '易方达上证50指数(LOF)C' },
  ];
  const pick = pickBestMatch(candidates, '易方达北证50指数C');
  assert.strictEqual(pick.code, '017516');
  assert.strictEqual(pick.name, '易方达北证50成份指数C');
});

test('parseHolding: 腾讯理财通资产明细截图', () => {
  const r = parseHolding(LICAITONG_TEXT, 'licaitong');
  assert.strictEqual(r.kind, 'holding');
  assert.strictEqual(r.funds.length, 6);
  assert.strictEqual(r.by_name, true);

  const [f1, f2, f3, f4, f5, f6] = r.funds;
  assert.strictEqual(f1.name, '易方达北证50指数C');
  assert.strictEqual(f1.market_value, 5591.46);
  assert.strictEqual(f1.hold_profit, -580.84);
  assert.strictEqual(f1.yest_profit, -50.04);

  assert.strictEqual(f2.name, '宏利消费红利指数C');
  assert.strictEqual(f2.market_value, 5060.91);
  assert.strictEqual(f2.hold_profit, -493.77);
  assert.strictEqual(f2.yest_profit, -45.49);

  assert.strictEqual(f3.name, '华夏国证半导体芯片ETF联接C');
  assert.strictEqual(f3.market_value, 2819.27);
  assert.strictEqual(f3.hold_profit, 112.35);
  assert.strictEqual(f3.yest_profit, 22.72);

  assert.strictEqual(f4.name, '景顺长城能源基建混合A');
  assert.strictEqual(f4.market_value, 2565.18);
  assert.strictEqual(f4.hold_profit, 457.41);
  assert.strictEqual(f4.yest_profit, 13.37);

  // OCR 把 "-2.22" 误识成 "=2.22", 解析器应自动修正为负号
  assert.strictEqual(f5.name, '东方红稳健精选混合C');
  assert.strictEqual(f5.market_value, 2008.99);
  assert.strictEqual(f5.hold_profit, 63.19);
  assert.strictEqual(f5.yest_profit, -2.22);

  assert.strictEqual(f6.name, '南方致远混合E');
  assert.strictEqual(f6.market_value, 1003.46);
  assert.strictEqual(f6.hold_profit, 3.46);
  assert.strictEqual(f6.yest_profit, 1.08);
});

const ALIPAY_TRADE_TEXT = `21:35
全部持有 收益明细 交易记录
明细 基金 全部
买入 基金 | 永 赢 害 信 混合 A 100.00 元
2026-08-11 23:04:20

买入 基金 | 易方达 北 证 50 指 数 A 100.00 元
2026-08-11 23:03:54

买入 基金 | 方正 富 邦 中 证 保险 主题 1000.00 元
指数 (LOF)A
2026-08-11 22:59:54

卖出 基金 | 圆 信永 丰 兴 源 灵 活 配 置 691.51 元
混合 A
2026-08-11 22:53:48`;

test('parseAlipayTrade: 识别买入/卖出、金额、日期时间', () => {
  const r = parseAlipayTrade(ALIPAY_TRADE_TEXT);
  assert.strictEqual(r.kind, 'trade');
  assert.strictEqual(r.by_name, true);
  assert.strictEqual(r.txs.length, 4);

  const [t1, t2, t3, t4] = r.txs;
  assert.strictEqual(t1.type, 'buy');
  assert.strictEqual(t1.name, '永赢睿信混合A');
  assert.strictEqual(t1.amount, 100);
  assert.strictEqual(t1.date, '2026-08-11 23:04:20');

  assert.strictEqual(t2.type, 'buy');
  assert.strictEqual(t2.name, '易方达北证50指数A');
  assert.strictEqual(t2.amount, 100);
  assert.strictEqual(t2.date, '2026-08-11 23:03:54');

  // 名称跨两行 + 金额千分位
  assert.strictEqual(t3.type, 'buy');
  assert.strictEqual(t3.name, '方正富邦中证保险主题指数(LOF)A');
  assert.strictEqual(t3.amount, 1000);
  assert.strictEqual(t3.date, '2026-08-11 22:59:54');

  assert.strictEqual(t4.type, 'sell');
  assert.strictEqual(t4.name, '圆信永丰兴源灵活配置混合A');
  assert.strictEqual(t4.amount, 691.51);
  assert.strictEqual(t4.date, '2026-08-11 22:53:48');
});

test('parseTrade: 支付宝交易记录自动路由到专用解析器', () => {
  const r = parseTrade(ALIPAY_TRADE_TEXT, 'alipay');
  assert.strictEqual(r.kind, 'trade');
  assert.strictEqual(r.txs.length, 4);
  assert.strictEqual(r.txs[0].name, '永赢睿信混合A');
});

const JD_TRADE_TEXT = `账户明细 交易
人 转 入 -嘉实 港股 互联 网 产业 核心 ”200.00 元
资产 混合 C 支付 成 功
08-13 22:15:26

人 转 入 -华夏 恒生 科技 ETF 发 起 式 联 100.00 元
接 (QDIDC 订单 完成
08-13 14:52:25

人 转 入 -兴业 中 证 港股 通 互 联网 200.00 元
ETF 联 接 C 订单 完成
08-13 14:51:58

人 分 红 -东方 红 中 证 东方 红 红 利 低 波 9.94 元
动 指 数 证 券 投 资 基 金 A 类 现金 发 放
08-11 16:28:57

(2) 分 红 -国泰 海通 君 增 利 60 天 滚动 持 12.757T
有 债券 型 发 起 式 证 券 投 资 基 金 C 类 。 现金 发 放
08-11 15:25:52

(2) 转 出 -华安 策略 优选 混合 A 253.657T
08-1102:36:17 转 出 完成`;

test('parseJDTrade: 识别转入/转出/分红、金额、名称续行、日期时间粘连', () => {
  const r = parseJDTrade(JD_TRADE_TEXT);
  assert.strictEqual(r.kind, 'trade');
  assert.strictEqual(r.by_name, true);
  assert.strictEqual(r.txs.length, 6);

  const [t1, t2, t3, t4, t5, t6] = r.txs;
  assert.strictEqual(t1.type, 'buy');
  assert.strictEqual(t1.name, '嘉实港股互联网产业核心资产混合C');
  assert.strictEqual(t1.amount, 200);
  assert.strictEqual(t1.date, '2026-08-13 22:15:26');

  // 名称跨行 + QDII 后缀
  assert.strictEqual(t2.type, 'buy');
  assert.strictEqual(t2.name, '华夏恒生科技ETF发起式联接(QDIDC');
  assert.strictEqual(t2.amount, 100);

  // 名称续行含状态词, 应剥离状态词
  assert.strictEqual(t3.name, '兴业中证港股通互联网ETF联接C');
  assert.strictEqual(t3.amount, 200);

  // 分红 + "A类" 后缀
  assert.strictEqual(t4.type, 'dividend');
  assert.strictEqual(t4.name, '东方红中证东方红红利低波动指数证券投资基金A');
  assert.strictEqual(t4.amount, 9.94);

  // OCR 把 "元" 误识为 "7T", 日期时间粘连
  assert.strictEqual(t5.type, 'dividend');
  assert.strictEqual(t5.name, '国泰海通君增利60天滚动持有债券型发起式证券投资基金C');
  assert.strictEqual(t5.amount, 12.75);
  assert.strictEqual(t5.date, '2026-08-11 15:25:52');

  // 转出 + 日期时间粘连
  assert.strictEqual(t6.type, 'sell');
  assert.strictEqual(t6.name, '华安策略优选混合A');
  assert.strictEqual(t6.amount, 253.65);
  assert.strictEqual(t6.date, '2026-08-11 02:36:17');
});

test('parseJDTrade: 名称完全乱码的条目按上下文推断为同类型交易', () => {
  const text = `账户明细 交易
人 转 入 -嘉实港股互联网产业核心资产混合C 200.00元
08-13 22:15:26

(2) BAN-HLEXEREREREC 50.00元
08-13 22:14:45 支付成功`;
  const r = parseJDTrade(text);
  assert.strictEqual(r.txs.length, 2);
  assert.strictEqual(r.txs[1].type, 'buy');
  assert.strictEqual(r.txs[1].amount, 50);
  assert.strictEqual(r.txs[1].name, 'BAN-HLEXEREREREC');
});

test('parseTrade: 京东金融交易记录自动路由到专用解析器', () => {
  const r = parseTrade(JD_TRADE_TEXT, 'jd');
  assert.strictEqual(r.kind, 'trade');
  assert.strictEqual(r.platform, 'jd');
  assert.strictEqual(r.txs.length, 6);
  assert.strictEqual(r.txs[0].name, '嘉实港股互联网产业核心资产混合C');
});
