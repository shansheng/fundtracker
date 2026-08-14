const { classifyFundType, normalizeFundType } = require('../src/services/fundType');
const test = require('node:test');
const assert = require('node:assert');

test('classifyFundType: 货币型', () => {
  assert.strictEqual(classifyFundType('余额宝货币'), '货币型');
});

test('classifyFundType: QDII (含沪港深/港股通)', () => {
  assert.strictEqual(classifyFundType('天弘恒生科技ETF联接(QDII)'), 'QDII');
  assert.strictEqual(classifyFundType('华夏沪港通精选'), 'QDII');
});

test('classifyFundType: FOF', () => {
  assert.strictEqual(classifyFundType('交银养老目标日期FOF'), 'FOF');
});

test('classifyFundType: 债券型 (短债/纯债)', () => {
  assert.strictEqual(classifyFundType('滚动持有短债债券A'), '债券型');
  assert.strictEqual(classifyFundType('同泰恒利纯债债券A'), '债券型');
});

test('classifyFundType: 指数型 (ETF/联接/增强)', () => {
  assert.strictEqual(classifyFundType('鹏华酒指数C'), '指数型');
  assert.strictEqual(classifyFundType('博时恒生医疗保健ETF联接'), '指数型');
  assert.strictEqual(classifyFundType('沪深300指数增强A'), '指数型');
});

test('classifyFundType: 股票型', () => {
  assert.strictEqual(classifyFundType('建信高端装备股票A'), '股票型');
});

test('classifyFundType: 混合型 (含 OCR 截断的 混)', () => {
  assert.strictEqual(classifyFundType('中欧医疗健康混合A'), '混合型');
  assert.strictEqual(classifyFundType('富国高质量混'), '混合型'); // 名称被截断
  assert.strictEqual(classifyFundType('交银定期支付双息平衡混合'), '混合型');
});

test('classifyFundType: 无法识别 -> 其他', () => {
  assert.strictEqual(classifyFundType('某神秘产品'), '其他');
  assert.strictEqual(classifyFundType(''), null);
});

test('normalizeFundType: 直接返回已知枚举', () => {
  assert.strictEqual(normalizeFundType('指数型', 'xxx'), '指数型');
});

test('normalizeFundType: 在线英文字段归一化', () => {
  assert.strictEqual(normalizeFundType('股票型', ''), '股票型');
  assert.strictEqual(normalizeFundType('', '易方达消费货币'), '货币型'); // 空 raw 时按名称推断
});
