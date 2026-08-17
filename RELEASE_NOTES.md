# FundTracker v0.9.0

纯本地运行的基金持仓追踪工具（Electron 桌面壳 + 本地 SQLite + 本地 Express API，隐私不上云）。
本版本聚焦三块：**实时估值准确度**、**首页性能**、**交易记录导入**。

## 亮点

- **估值残差补齐**：季报仅披露前十大重仓（合计约 30%~90%），剩余仓位原先视作 0 波动，导致估算系统性偏低；现按基金基准指数（`track_index`）实时涨跌补齐，估算更贴近真实。
- **首页刷新异步化**：估值结果内存缓存 + 单飞重算 + 前端轮询，首帧毫秒级返回，不再被公共行情接口限流卡住。
- **修复混合型基金估值全部消失**：新浪对单请求 600+ 代码有隐性上限，会直接返回空；已改为按 50 个/块分块 + 限并发抓取。
- **交易导入闭环**：支持支付宝、京东金融交易截图 OCR 识别 → 名称匹配基金代码 → 落库，并按 T+1 净值规则回填份额。

## 新增功能

### 实时估值
- 指数代理估值：有持仓用股票加权（带季报时效校验，>12 个月标 `stale`）；无持仓但有 `track_index` 用指数代理。
- 残差补齐：披露占比合计 <100% 时，剩余部分按 `track_index` 实时涨跌幅补齐，返回 `residual_ratio` / `benchmark_pct` / `index_code` 供前端展示。基准缺失或行情缺失时优雅降级为 0（不崩溃）。
- 默认基准回填（`db.js` init 幂等）：为权益类基金设沪深300（`sh000300`）作默认基准；债券/货币/QDII 不设置（基金类型不可靠，已用名称正则排除含「债/货币/理财/QDII/港股通」等基金）。

### 交易记录导入
- 支付宝「交易记录」截图 OCR：`parseAlipayTrade`，支持名称跨行续接、OCR 错字修正（害信→睿信）。
- 京东金融「账户明细→交易」截图 OCR：`parseJDTrade`，识别 转入/转出/分红，处理 `MM-DD` 日期补年、状态词剥离、金额末尾错字（`T`→元）、日期粘连（`08-1102:36:17`）。
- 名称匹配：`pickBestMatch` 归一化 `A类/C类`→`A/C` 后按相似度匹配基金代码。
- 份额回填：`POST /transactions/backfill-shares`，按「15:00 截止」取 T / T+1 净值，金额 ÷ 净值算份额（估算值，忽略申赎费）。

### 性能与稳定性
- 首页 `/estimate` 异步化：`estimateCache` 内存缓存（25s TTL）+ 单飞守卫；`GET /estimate` 即时返回缓存与 `computing` 标志，后台异步重算。
- 新浪行情分块抓取 `SINA_CHUNK=50` + 限并发 `SINA_CONCURRENCY=3`；东方财富回退加并发与百分比熔断（缺失 >50% 才跳过）。
- 新增零依赖有限并发池 `concurrency.mapLimit`。

## 修复

- 修复混合/全市场基金估值归零（新浪 A 股大请求返回空）。
- 修复 UI 保存交易字段错位（`fund_code` vs `code`）导致交易记录不可见。
- 修复 `npm test` 脚本 glob 表达式（Node 22 下 `node --test tests/` 报错，改为 `node --test "tests/**/*.test.js"`）。

## 工程

- 新增模块：`concurrency.js` / `estimateCache.js` / `txnShares.js`。
- 测试：62 pass（estimator / fundType / ocr / quotes / concurrency / estimateCache / txnShares）。
- 安全：`.gitignore` 排除个人数据库（`*.sqlite`）、截图（`screenshots/`）、OCR 语言包（`*.traineddata`）、工作区记忆（`.workbuddy/`）及 sqlite 备份（`*.sqlite.bak.*`），公开仓库不泄露隐私。

## 已知限制

- **总资产仍仅由持仓表（`holding`）驱动**，交易（`txn`）为独立流水，买入不自动改持仓（后续版本考虑合并）。
- 商品基金（黄金/原油/白银等）、标普/印度/日本/债券/FOF 等暂无盘中估值（`intraday_supported:false`）。
- 港股个股归一化尚未覆盖（港股指数已支持）。

## 升级方式

- 桌面端：`npm install && npm start`
- 仅后端：`npm run server`，浏览器打开 http://127.0.0.1:3456/
