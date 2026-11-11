# 版本升级记录 (CHANGELOG)

> 适用版本：v5.10.1 | 更新日期：2026-11-08

---

## v5.10.1 — 锚点规则放开 + FIFO 判定收敛 + 行级立即判定 + 一键同步瘦身 + UI 文案统一（2026-11-08）

### 零、补充：UI 显示名统一（2026-11-08 下午）

**状态显示名"已完成"→"已入库"**：
- 所有前端用户可见位置（列表状态列、筛选下拉 option label、统计卡片 label/title、折叠区标题、按钮 title、toast 提示、状态标签等）统一改为"已入库"
- **数据库存储值仍是「已完成」**，所有后端匹配逻辑、30 天回退、90 天关闭、DETERMINED 状态集合、CSS 选择器 `[data-status="已完成"]` 均保持不动
- 覆盖两个前端：admin.html/admin.js + store.html/store.js
- 关键原则：所有 `<option value="已完成">已完成</option>` 改成 `<option value="已完成">已入库</option>`（label 改，value 保留）

**新增"📖 操作说明"TAB**（admin.html）：
- 整体业务流程（门店上报 → 仓库入库 → 自动判定 → 配送 → 30天回退）
- 六种状态含义（新名称"已入库"）
- 自动判定规则简述（锚点放宽 / FIFO 先报先得 / 当天入库计入 / 30天回退 / 90天关闭）
- 按钮功能速查表（每个按钮的作用、改不改数据、什么时候用）
- 常见问题 FAQ

**悬停说明补全**：
- 一键同步、配送待办、通知刷新、刷新订购数据等按钮的 title 改为业务化描述
- 行级「立即判定」按钮新增 title（"只判当前这一个商品...会改数据库"）

**商品 1110051「门店查不到」诊断结论**（2026-11-08）：
| 检查项 | 结果 |
|--------|------|
| Supabase product_cache 表 | ✅ 有 1110051（米氮平片） |
| ERP 采购入库单（vBuySendSumDetail） | ✅ 有 10 条，总量 46（BillDate 2020-12-24 ~ 2025-10-27） |
| reports 表缺货上报 | ❌ **从未有过 1110051 的缺货上报**（0 条） |
| leveal/level 过滤 | ✅ 代码中不存在 leveal 过滤，product_cache 刷新是全量 upsert |
| 编码前导零 | ✅ 只有无前导零版本 1110051，无 01110051 |
| 诊断结论 | **不是 bug**。该商品在系统中完全存在，但从未被任何门店上报过缺货，所以门店侧缺货列表里搜不到。 |

### 一、问题背景

v5.10.0（逐笔独立 FIFO 判定）跑了一天后，发现三个体验问题：

| 问题 | 表现 | 根因 |
|------|------|------|
| **当天入库永远不算** | 某门店 11/08 上午上报缺货 A 商品 10 盒，下午仓库 A 商品入库 50 盒（BillDate=11/08），一键同步后仍显示待处理 | 锚点门槛是严格 `BillDate > 上报日`——入库 BillDate=11/08 不满足 `> 11/08` |
| **一键同步有 2000 条截断** | pending reports 超 2000 条时，后面的永远不参与判定 | `preciseAutoDetectStatusV2` PostgREST 写死 `limit(2000)` |
| **商品缓存被刷两次** | 一键同步 → 刷 product_cache；凌晨定时 → 又刷一次 | 两边都调用 `syncProductCache`，冗余 SQL |

### 二、核心改动清单

#### 2.1 锚点规则放开（默认宽松口径）

| 项 | 旧值 | 新值 |
|----|------|------|
| 锚点门槛 | `BillDate > anchorDateBj`（严格） | `BillDate >= anchorDateBj`（宽松） |
| 判定函数 | 各入口内联 `>` 比较 | 统一 `isPurchaseEligible(billDateBj, anchorDateBj, sameDayCounts=true)` |
| 影响 | 当天入库永远轮不到当天报的缺 | 同天先报先得；"需求 0 却待处理"消失 |

**判定入口三收敛**：定时任务 / 一键同步 / 行级立即判定 → 全部走 `supabase/functions/_shared/fifo.ts` 的同一份 `runFIFO()`，0 漂移。

#### 2.2 后端新增 Action

| Action | 位置 | 用途 |
|--------|------|------|
| `check_single_product` | `query-shortage-data/index.ts` ~L2633 | 行级单商品 FIFO 判定，返回应完成的 report id 列表，只更新这一个商品 |
| `batch_purchase_check` | 同上 | 只读拉采购明细（临时调试用，后续删） |
| `fifo_diff_check` | 同上 | 只读对比旧版 vs 新版 FIFO（漂移排查用，后续删） |

#### 2.3 一键同步瘦身

| 项 | 旧 | 新 |
|----|----|----|
| product_cache 刷新 | sync_with_auto_status 里全量刷 + 凌晨定时又刷一次 | **删掉 sync_with_auto_status 里的刷新段**，统一由每天 00:30 scheduled-task 执行 |
| pending reports 范围 | `limit(2000)` | `range` 分页 1000 条/页，翻页直到拉完 |

#### 2.4 前端改动

| 文件 | 函数/位置 | 改动 |
|------|----------|------|
| `deploy/static/js/admin.js` ~L63 | 新增 `bjToday()` / `toBjDate()` | 北京时间换算，替代裸 `new Date().toISOString().slice(0,10)` |
| `deploy/static/js/admin.js` ~L1098 | `renderSummaryPage` 汇总行 | 新增 📦 标签（后端返回 `eligible_purchase_qty > 0` 时显示）+「立即判定」按钮 |
| `deploy/static/js/admin.js` ~L1501 | 新增 `checkSingleNow` | 调 `check_single_product` action，只判当前商品，Toast 反馈 |
| `deploy/_headers` | `/static/js/*` Cache-Control | 改 `no-cache, must-revalidate`（防浏览器缓存旧 JS） |

### 三、文件变更清单

| 文件 | 变更 |
|------|------|
| `supabase/functions/_shared/fifo.ts` | **新增**共享 FIFO 模块：`toBjDate` / `isPurchaseEligible` / `queryPurchaseInPool` / `runFIFO` |
| `supabase/functions/query-shortage-data/index.ts` | import 共享 fifo、删内联重复实现、加 check_single_product / batch_purchase_check / fifo_diff_check、preciseAutoDetectStatusV2 改 range 翻页、sync_with_auto_status 删缓存刷新段 |
| `supabase/functions/scheduled-task/index.ts` | import 共享 fifo、删内联重复实现 |
| `deploy/static/js/admin.js` | 北京时间工具函数、📦标签 + 立即判定按钮、checkSingleNow 函数 |
| `deploy/_headers` | Cache-Control 改 no-cache |

### 四、部署状态

| 组件 | 状态 |
|------|------|
| Edge Function `query-shortage-data` | ✅ 已部署（`--no-verify-jwt --project-ref qswpgnnedqvuegwfbprd`） |
| Edge Function `scheduled-task` | ✅ 已部署 |
| Cloudflare Pages `wszhyy` | ✅ 已部署（`wrangler pages deploy deploy --project-name=wszhyy`） |

### 五、遗留事项

| 事项 | 状态 |
|------|------|
| 商品 1110051 门店查不到问题 | 登记待办（商品缓存同步 leveal 过滤 / BillDate >= '2025-01-01' 下限 / 门店库存查询范围），暂不排查 |
| `batch_purchase_check` / `fifo_diff_check` action | 临时调试用，确认稳定后删 |
| `_shared/fifo.ts` Deno import 打包坑 | 本次验证通过，后续如果又出现 import WARN → 退回两边各内联等价代码 |
| 影响面统计待补 | 需等 Edge Function 稳定后跑 `impact_check.mjs` 输出"放开后新增完成的 report 数量、按商品/门店分布" |

---

## v3.20 → v373 → v374 逐笔独立判定 + 采购不重复消耗（2026-11-05 ~ 11-07）

### 一、问题背景

旧版 v3.17（商品级汇总判定）存在一个根本缺陷：**一个商品只算一次，所有活跃 report 共用"采购 ≥ 缺货汇总"的结果**。这导致两个严重误判：

| 问题 | 场景 | 后果 |
|------|------|------|
| **晚报卡死早报** | 商品有 10 笔活跃 report，最早 8/1 报缺、最晚 11/6 报缺，采购只到 10/28 | 锚点取最新 11/6 → 锚点后采购 = 0 → **全 10 笔保持待处理** |
| **汇总误判完成** | 商品多门店同时报缺，采购量刚好 ≥ 汇总，但早报的还没被满足 | 旧版**全部**标已完成 → 实际只有最早那几笔够了 |

### 二、演进过程

| 版本 | 锚点 | 粒度 | 核心缺陷 |
|------|------|------|---------|
| **v3.17** | 最早未完成上报日 | 商品级 | 晚报可能消耗早报采购、或被晚报卡死 |
| **v3.20** | 最早上报日 | 商品级 | 锚点太松，锚点后采购被多笔需求共享重复计算 |
| **v373** | 最新未完成上报日 | 商品级 | 一笔晚报 = 全商品作废 |
| **v374（当前）** | **每条 report 自己的上报日** | **逐笔 report 独立判定** | ✅ 早报早结，晚报晚结 |

### 三、v374 核心逻辑

```
对每个商品:
  1. SQL Server 查全量采购入库明细（BillType=34, InKRec='3'）
     → 形成入库池：[{date, qty, remaining}]
  
对每条活跃 report（按 created_at 升序）:
  2. 锚点 anchorDate = 该条 report 的 created_at（上报日）
  3. 入库池里：只消耗 BillDate > anchorDate 且 remaining > 0 的
  4. 入库不能重复消耗（remaining 递减）
  5. 消耗总量 ≥ 该笔缺货 → 标记这条 report 为已完成
     消耗总量 <  该笔缺货 → 保持待处理
```

**关键规则**：
- 锚点门槛严格 `>`，不是 `>=`：入库日期必须**严格晚于**上报日。理由：当天入库的货是采购之前的需求，当天上报的需求还没采购
- 采购不重复消耗：同一份入库只能被一条 report 吃掉，先报先得（FIFO）
- 判定保守：不够就保持待处理，绝不自动降级/关闭

### 四、代码改动清单

| 文件 | 函数/位置 | 改动 |
|------|----------|------|
| `query-shortage-data/index.ts` L786 | `queryPurchaseQty` → **`queryPurchaseDetails`** | 返回全量入库明细数组 `[{date, qty}]` 而非单个汇总数字 |
| `query-shortage-data/index.ts` L812-960 | **`preciseAutoDetectStatusV2` 整体重写** | 旧"商品级汇总判定" → 新"逐笔 report 独立判定" |
| `query-shortage-data/index.ts` | `completionMap`、`latestActiveAt`、`demandByCode` | **全部废弃删除**，不再需要商品级中间变量 |
| `query-shortage-data/index.ts` L2376 | **新增 `recheck_auto_completed` action** | 用新逐笔逻辑重新核查历史已完成 report，误判的回退待处理 |
| `get_my_reports` 兜底 | SQL Server `Shortage_OrderFeedback` | **彻底删除**，商品级补货状态唯一数据源 = Supabase reports 表 |
| `sync_with_auto_status` | 商品缓存同步前自动触发判定 | 保留，`preciseAutoDetectStatusV2` 是核心 |

### 五、误判回退执行记录（2026-11-07）

`recheck_auto_completed` 执行结果：

| 指标 | 数值 |
|------|------|
| 核查目标（10月后 + 系统自动标记已完成） | **176 条** / 149 个商品 |
| 新逐笔逻辑也满足 → 保持已完成 | **282 条** |
| 新逐笔逻辑不满足 → **回退待处理** | **2 条** |

**被回退的 2 条（典型场景）**：

| 商品 | 上报日 | 缺货 | 原因 |
|------|--------|------|------|
| 1440 | 2026-10-28 | 10 | 同商品 4 条活跃 report 按 created_at 升序前 3 条先吃光了采购入库，10/28 轮到时入库池已空 |
| 030076 | 2026-10-14 | 10 | 同商品 3 条活跃 report 前 2 条吃光采购，10/14 没了 |

### 六、逐笔判定推演验证（对应用户截图场景）

7 笔需求 + 4 笔入库：

| # | 需求 | 锚点 | 消耗入库 | 结果 |
|---|------|------|---------|------|
| 1 | 10/1 缺 8 | 10/1 | 10/7(-8) | ✅ 已完成 |
| 2 | 10/5 缺 5 | 10/5 | 10/7剩(-5) | ✅ 已完成 |
| 3 | 10/8 缺 8 | 10/8 | 10/7 早于锚点不可用 → 10/11(-8) | ✅ 已完成 |
| 4 | 10/10 缺 6 | 10/10 | 10/11剩(-2) + 10/16(-4) | ✅ 已完成 |
| 5 | 10/15 缺 8 | 10/15 | 10/16剩(-8) | ✅ 已完成 |
| 6 | 10/17 缺 20 | 10/17 | 10/16 早于锚点不可用 → 10/20(-20) | ✅ 已完成 |
| 7 | 10/18 缺 15 | 10/18 | 10/20剩(5) 不够 15 | ❌ 待处理 |

### 七、遗留事项

| 事项 | 状态 |
|------|------|
| `product_completion` 表（`last_completed_at` / `carryover_qty`） | 保留不删，代码不再读取，仅在判定完成时 upsert 更新 |
| `recheck_auto_completed` action | 保留 Edge Function（可随时重新核查历史已完成） |
| 过期采购仍在消耗池 | 不存在——锚点门槛自动挡住所有早于上报日的入库 |
| 低优先级边界（入库拆单、退货冲销、BillDate 精度） | 暂不处理，实际影响可忽略 |

---

## v3.17 简化版 — 判定逻辑去保护期 + 批量查询优化（2026-11-01 ~ 11-02）

### 一、问题背景

之前的 v3.x 判定逻辑引入了"事件驱动保护期"：上报日期晚于全历史最新采购日期的商品**暂时跳过判定**，等下次同步。实际运行发现这导致两个严重问题：
1. **大量商品被保护期卡住**（159 条里排除 142 条），真正参与判定的只有 17 条
2. **不是真正的"总账"逻辑**——简化版应该是：总需求 vs 采购累计，够了就完成，不够就不完成，不该有任何跳过

### 二、简化版逻辑（v3.17）

```
每个商品的判定:
  anchor = 最早未完成上报日
  purchase = SUM(采购入库数量) WHERE BillDate >= anchor
  demand = SUM(未完成缺货需求)
  if purchase >= demand → 全部标记已完成
  else → 不判定，等下次同步再查
```

**核心改动**（`supabase/functions/scheduled-task/index.ts`）：

| 步骤 | 旧 v3.x | 新 v3.17 简化版 |
|------|---------|----------------|
| 待处理筛选 | 事件驱动保护期过滤（排除 142 条） | **所有待处理 reports 全参与** |
| 采购查询 | N 次逐个商品 SQL（120 商品 × 2 = 240 次） | **2 次批量 SQL** + JS 内存分组 |
| 全新商品 | fail_count 豁免 | **所有商品一视同仁** |
| carryover/anchor | 读写 carryover_qty、last_anchor | **弃用，不再读写** |

### 三、SQL Server 连通性排查（2026-11-01 下午）

用户报告"debug_check_code 连不上 SQL Server"。排查结论：

| 检查项 | 结果 |
|--------|------|
| 本地 TCP → 221.6.168.13:1311 | ✅ 通 |
| Edge Function health | ✅ healthy |
| Edge Function → SQL Server | ✅ **能连上**（SQL 查询跑到第 909 行才报错） |
| debug_check_code 错误 | ❌ **代码 bug**：`ReferenceError: eligibleReports is not defined` |
| run_detect_only | ❌ **546 WORKER_RESOURCE_LIMIT**（240 次 SQL 超时） |

**不是 SQL Server 超时，是 Edge Function 代码 bug + 查询量过大。**

### 四、修复清单

| # | 问题 | 修复 | 文件 |
|---|------|------|------|
| 1 | debugCheckCode 里引用了 `eligibleReports` 但没定义 | 补上保护期过滤逻辑（后又简化移除） | index.ts |
| 2 | `newProductCodes`、`eligibleDemand`、`protectedReports` 未定义 | 全部按简化版移除 | index.ts |
| 3 | CONCURRENCY=5 + 240 次查询 → 546 超时 | **改成批量查询**：1 次 `IN (...) GROUP BY` + 1 次 `IN (...)` 明细 | index.ts Step 3-4 |
| 4 | Step 6 里 `info.total` 残留引用（简化版结构变了） | 改成 `info.qty` | index.ts L396 |
| 5 | Supabase CLI 过旧 | 2.99.0 → **2.122.0** | 全局 npm |

### 五、手工 SQL 验证（2026-11-02）

直接连 SQL Server 对 3 个商品跑锚点起采购累计，和 Edge Function debugCheck 结果**完全一致**：

| 商品 | anchor | 需求 | 手工SQL采购 | EdgeFunction采购 | 判定 | 一致 |
|------|--------|------|-----------|-----------------|------|------|
| 110224 | 2026-09-17 | 5 | 30 | 30 | ✅ 完成 | ✅ |
| 020816 | 2026-08-08 | 50 | 30 | 30 | ❌ 差20 | ✅ |
| 0710 | 2026-09-17 | 3 | 0 | 0 | ❌ 差3 | ✅ |

### 六、最终运行结果

```
run_detect_only (269 商品):
  超期90天自动关闭: 153 条
  待处理 reports: 445 条 / 159 个商品
  参与判定: 445 条 / 159 个（全部参与，无保护期过滤）
  判定完成: 150 个商品 ✅
  剩余采购不足: 9 个商品

最终数据库状态 (2026-11-02 上午):
  已完成   1,271 条
  待处理     159 条
  已关闭     153 条
  厂家断货    71 条
  已订购/待付款 13 条
```

### 七、文件变更

| 文件 | 变更 |
|------|------|
| `supabase/functions/scheduled-task/index.ts` | **核心重构**：移除保护期逻辑、批量查询替代循环、修复 debugCheck + Step 6 Bug |
| `package.json` | 无（客户端不需要改，只改 Edge Function） |
| Supabase CLI | **升级**：2.99.0 → 2.122.0 |

### 八、遗留事项

| 事项 | 状态 |
|------|------|
| `product_completion.carryover_qty` / `last_anchor` 字段 | 保留不删，代码不再读写 |
| `reports.close_reason` / `auto_closed_at` 字段 | 保留，90天自动关闭在用 |
| Cloudflare Pages `wszhyy.pages.dev` 门店网络超时 | 门店网络问题，Electron 可改本地加载 |
| pg_cron jobid=11（北京时间 00:30） | 正常运行中 |

### 九、已关闭状态前端汇总遗漏修复（2026-11-02 中午）

**问题**：商品 170038（盐酸萘甲唑啉滴）前端显示"需求 32"，但判定逻辑只用了 20。

**根因追查**：

| 环节 | 已关闭 reports 处理 | 结果 |
|------|---------------------|------|
| **v3.17 scheduled-task（判定）** | `.neq("replenish_status", "已关闭")` | ✅ 正确排除 |
| **query-shortage-data preciseAutoDetectStatus** | 只排除 `已完成/厂家断货` | ❌ **遗漏已关闭** |
| **query-shortage-data preciseAutoDetectStatusV2** | 只排除 `已完成`（PostgREST 层） | ❌ **遗漏已关闭/厂家断货** |
| **前端 utils.js isCompletedStatus()** | 只算 `已完成/厂家断货` 为终态 | ❌ **遗漏已关闭** |
| **前端 admin.js loadSummary()** | 直接拉全部 reports，按 isCompletedStatus 分组 | ❌ 已关闭被放进 shortage_by_product |

170038 的 3 条记录：
- #1718 10-30 上报 待处理 demand=10
- #1296 09-09 上报 待处理 demand=10
- #232 06-14 上报 **已关闭** demand=**12** ← 90天自动关，但前端还在累加

**修复**（3 处）：

| # | 文件 | 改动 |
|---|------|------|
| 1 | `static/js/utils.js` | `isCompletedStatus()` 加上 `已关闭` → 终态 |
| 2 | `supabase/functions/query-shortage-data/index.ts` L421 | `preciseAutoDetectStatus` 过滤加上 `已关闭` |
| 3 | `supabase/functions/query-shortage-data/index.ts` L816-818 | `preciseAutoDetectStatusV2` PostgREST 和 JS 过滤加上 `厂家断货/已关闭` |

**部署状态**：query-shortage-data Edge Function 已部署，utils.js 已同步到 deploy 和 dist。Cloudflare Pages 需要 wrangler CLOUDFLARE_API_TOKEN 才能推。

---

> 适用版本：v5.9.1 | 更新日期：2026-10-26

---

## v5.9.1 — 登录慢根治 + 一键同步自动定时闭环（2026-10-26）

### 一、登录慢根治：supabase-js 本地化（P0）

**问题**：Electron 客户端登录页加载耗时 ~40 秒，核心瓶颈是 jsDelivr CDN 从海外下载 supabase-js 库耗时 38 秒。

**修复**：
- 将 `supabase.min.js`（218KB）下载到项目本地 `static/js/supabase.min.js` + `deploy/static/js/supabase.min.js`
- 8 个页面（login/store/admin/procurement + deploy 副本）CDN 引用 `https://cdn.jsdelivr.net/...` 全部改为本地 `./static/js/supabase.min.js`
- Cloudflare Pages 重新部署（preview: `https://0a7b5286.wszhyy.pages.dev`，正式: `https://wszhyy.pages.dev`）

**效果**：登录加载 40s → **1-2s**，秒开 ✅

### 二、一键同步 pg_cron 定时任务闭环（P0）

**问题**：pg_cron 自动同步从未跑通过，根因有二：
1. **时区错误**：原 schedule `30 0 * * *` 在 pg_cron UTC 服务器上实际运行于 **北京时间 08:30**（晚了 8 小时）
2. **鉴权方式不可靠**：自定义 `x-task-secret` header 在 Edge Function 旧版本中可能未正确识别，调用返回 401

**修复**（`sql/create_auto_sync_cron.sql`）：

| 修复项 | 旧值 | 新值 |
|--------|------|------|
| schedule | `30 0 * * *`（UTC 00:30 = 北京 08:30） | **`30 16 * * *`**（UTC 16:30 = 北京 00:30） |
| 鉴权 | `x-task-secret` header | **`Authorization: Bearer service_role_key`** |
| jobid | 旧 job（已删除） | **新 jobid=11**，active=true |

**手动 full_sync 端到端验证（2026-10-26 14:16）**：
```
✅ RQZT 商品缓存刷新  2,642ms
✅ 商品缓存同步 Supabase  4,173 条
✅ 采购计划缓存 Supabase  19,058 条
✅ 自动判定"已完成"  8 个商品（采购入库 ≥ 缺货汇总）
✅ success = true
```

**pg_cron 完整 Job 清单**：

| jobid | jobname | schedule (UTC) | 北京时间 | 用途 |
|-------|---------|----------------|----------|------|
| 3 | sync-rqzt-product-cache | `0 3 * * *` | 11:00 | RQZT 缓存单独同步 |
| 5 | keep-edge-warm | `*/5 * * * *` | 每5分钟 | 预热 Edge Function 防冷启动 |
| 6 | clean-pg-net-response | `0 3 * * *` | 11:00 | 清理 pg_net 响应表（旧） |
| 8 | cleanup-http-response | `0 4 * * *` | 12:00 | 清理 pg_net 响应表（新） |
| **11** | **sync-spfxb-result** | **`30 16 * * *`** | **次日 00:30** | **一键同步（防重复采购）** ✅ |

### 三、Supabase 项目用量诊断（2026-10-26）

| 指标 | 当前值 | 免费上限 | 使用率 | 评估 |
|------|--------|----------|--------|------|
| 数据库总大小 | **48 MB** | 500 MB | 9.6% | ✅ 安全 |
| 数据库表数 | 76 | - | - | - |
| Auth 用户数 | 19 | 50,000 MAU | 0.04% | ✅ 安全 |
| pg_cron 活跃 Job | 5 | - | - | - |
| pg_cron 本周运行 | 2,037 次 | - | - | job5 keep-edge-warm 主力（288次/天） |
| Edge Function 调用估算 | ~10,200 次/月 | 100 万次 | ~1% | ✅ 安全 |
| Storage | 1 bucket (static) | 1 GB | 极小 | ✅ 安全 |

**前 10 大表**（增长监控）：

| 表名 | 大小 | 说明 |
|------|------|------|
| `shortage_storestock_cache` | 14 MB | 缺货门店库存缓存（最大） |
| `job_run_details` | 8 MB | pg_cron 运行日志（自动清理） |
| `product_cache` | 3.9 MB | 商品缓存 |
| `_http_response` | 3.3 MB | pg_net HTTP 响应（自动清理） |
| `reports` | 1.1 MB | 缺货上报记录 |
| `sessions` | 1.0 MB | Auth 会话 |
| `product_completion` | 184 KB | 商品完成锚点 |

### 四、文件变更

| 文件 | 变更 |
|------|------|
| `static/js/supabase.min.js` | **新增**，supabase-js v2 本地化（218KB） |
| `deploy/static/js/supabase.min.js` | **新增**，deploy 副本同步 |
| `login.html` / `deploy/login.html` | CDN → 本地引用 |
| `store.html` / `deploy/store.html` | CDN → 本地引用 |
| `admin.html` / `deploy/admin.html` | CDN → 本地引用 |
| `admin_test.html` / `admin_deploy.html` | CDN → 本地引用 |
| `supabase/functions/scheduled-task/index.ts` | 已含 checkSecret 鉴权逻辑（x-task-secret + Bearer 双通道） |
| `supabase/functions/scheduled-task/config.toml` | `verify_jwt = false`（允许 pg_cron 无 JWT 调用） |
| `sql/create_auto_sync_cron.sql` | **更新**：时区修正 `30 16 * * *` + Bearer service_role key |

### 五、遗留事项

| 事项 | 状态 |
|------|------|
| 旧 pg_cron jobid=6 `clean-pg-net-response` 冗余（jobid=8 已覆盖） | 可选：`SELECT cron.unschedule(6);` |
| 旧 pg_cron jobid=10（原始 sync-spfxb-result，已重建为 jobid=11） | 已自动删除 |
| GitHub Actions auto-full-sync 兜底 workflow | 文件已写，需推仓库 + 配 secrets |
| Supabase 免费额度监控 | Dashboard → Settings → Usage 定期查看 |
| Supabase Grace period 警告 | 只是宽限期已过，实际用量 ~10%，短期安全 |

### 六、踩坑记录

| 问题 | 根因 | 解决 |
|------|------|------|
| 旧版 pg_cron 时区 | 服务器 UTC，不自动转北京时间 | UTC 时间 = 目标北京时间 − 8 小时 |
| 旧版 pg_cron `cron.schedule()` 无 timezone 参数 | v1.6.4 旧版，无扩展参数 | 只传 3 参数 `(name, schedule, command)` |
| `net.http_post` 参数顺序 | 旧版 pg_net 是 3 参数 `(url, headers_jsonb, body_jsonb)` | 新版才是 named params |
| Supabase CLI telemetry EPERM 沙箱限制 | `.supabase/telemetry.json` 写入权限 | 不影响核心 db query 功能 |
| `cron.job` 表无 `next_run` 列 | 旧版 pg_cron 不暴露下次运行时间 | 只能手动推算或等运行后看 `job_run_details` |

---

## 故障记录 — 登录「Failed to fetch」→ Supabase 配额耗尽（2026-10-19 ~ 10-21）

### 现象

登录页（员工/管理员模式）点击登录后提示 `Failed to fetch`，所有账号均无法登录；同时客户端出现「双击无反应」。

### 排查与根因

| 测试项 | 结果 |
|--------|------|
| DNS 解析 `qswpgnnedqvuegwfbprd.supabase.co` | 正常 |
| Edge Function 预检 OPTIONS / POST | **HTTP 402（Payment Required）** |
| Supabase Auth 健康检查 `/auth/v1/health` | **HTTP 402** |

Supabase Dashboard 显示 `Services restricted`（组织配额耗尽，项目 Unhealthy + `EXCEEDING USAGE LIMITS`）。到 Usage 页确认超限项：**Database Size 1.212 / 0.5 GB（242%）**，其余指标（流量 3%、Edge Function 调用 <1%、MAU 1%）全部正常。

再用 SQL 定位大表：`net._http_response`（pg_net 响应队列表，注意 schema 是 **`net`**，不是 `supabase_functions`）占用 **1097 MB**，实际 0 行——纯表膨胀（Keep-Warm/定时任务的 HTTP 响应堆积后清理未归还磁盘），占整个库的 90%。业务表合计不足 50MB。

### 处理过程（含踩坑）

```sql
-- 正确做法（schema 是 net）
TRUNCATE TABLE net._http_response;
VACUUM FULL net._http_response;
```

| 踩坑 | 现象 | 解决 |
|------|------|------|
| schema 写错 | `relation "supabase_functions._http_response" does not exist` | 表实际在 `net` schema，用 `net._http_response` |
| VACUUM 与多语句一起执行 | `VACUUM cannot run inside a transaction block` | SQL Editor 多条语句会被包进事务，`VACUUM FULL` 必须**单条选中单独执行** |

- 清理结果：`net._http_response` 1097MB → 32kB，数据库总大小 1.212GB → **44MB（12%）**
- 防复发：pg_cron job 8 `cleanup-http-response`，每天 4:00 TRUNCATE
- 存量发现：job 6 `clean-pg-net-response`（每天 3:00 删 3 天前数据）早已存在，但**只 DELETE 不 VACUUM FULL**，故只删数据不归还磁盘——这正是当初表膨胀到 1GB 的间接原因，job 6 现已冗余（可 `SELECT cron.unschedule(6);` 删除）
- 客户端「双击无反应」：后台残留 4 个 `WSZH-ShortageStore` 僵尸进程（单实例锁）→ 用 `Stop-Process -Name 'WSZH-ShortageStore' -Force` 清理

### 最终结论（重要）

⚠️ **数据库降回 44MB 后，402 限制并未自动解除**。实测：重启项目（Settings → General → Restart project）无效，Auth / Edge Function 仍返回 402。

Supabase 官方口径（Usage 页横幅原文）：**升级 Pro 立即解除；或等到下个账单周期开始自动解除**（本周期 2026-10-14 ~ 2026-11-14）。限制一旦触发，不会因中途降回来自动解除。

### 待处理事项

| 事项 | 状态 |
|------|------|
| Supabase 服务 402 限制 | ✅ **2026-10-21 已恢复**（实测 Edge Function 返回 200；工单未回复，疑似 Supabase 侧重新评估后自动解除） |
| 数据库体积监控 | ⚠️ 恢复后 Usage 显示 86MB（清理后曾为 44MB），有回升趋势；job 8 每天 4:00 自动 TRUNCATE 兜底，需持续观察 |
| 删除冗余定时任务 job 6 | 可选：`SELECT cron.unschedule(6);` |
| 未来新建表需加 GRANT | Supabase 邮件：2026-10-30 起新建表不再自动授权，建表 SQL 末尾补 `grant ... to anon, authenticated, service_role;` |
| 长期备选方案 | 国内云自托管（腾讯云 4核4G ¥38/年 首选 / 京东 2核4G ¥158 备选；阿里云 2核2G 内存不足不推荐）；需验证到 SQL Server（221.6.168.13:1311）连通性 + 域名备案 |

### 历史同类现象（根因不同，勿混淆）

- 2026-05-20：Edge Function CORS 白名单未含 Cloudflare 新部署子域名 → 已修复为允许 `*.wszhyy.pages.dev` + localhost
- 2026-05-21：单台客户端缓存/网络问题 → 清缓存解决

---

## v5.9.0 — 药品状态变更新规则：取消「已到货」（2026-09-17）

### 一、方案概述

| 项 | 旧规则 | 新规则 |
|----|--------|--------|
| 状态机 | 待处理 / 已订购 / 已到货 / 已完成 / 厂家断货 / 待付款 | 待处理 / 已订购 / 已完成 / 厂家断货 / 待付款（**取消「已到货」**） |
| 「已完成」含义 | 货已配送到门店 | **采购入库累计 ≥ 缺货汇总**（仅代表货已到仓，配送由人工处理） |
| 完成判定 | 门店/仓库库存满足 + 智能回退 | **单调递增、永不回退**（采购入库只增不减） |
| 到货通知 | 绑在一键同步里自动发 | **独立「通知刷新」按钮**手动触发 + `notified_at` 去重 |
| 配送跟进 | 无 | 新增「配送待办」列表（已完成 + 仓库有货 + 门店库存 < 需求） |

> 核心洞察：采购入库量单调递增，「已完成」一旦满足永久成立，彻底消除旧方案的智能回退、二次校验、second-check 计划任务、通知库存耗尽回退等一批补丁。

### 二、数据库迁移（`supabase/migrations/20260917000000_status_logic_v2.sql`）

| 变更 | 说明 |
|------|------|
| `reports.settled_at` | 新增「已结算」标记，完成时回填 |
| `product_completion` 表 | 新建，商品级完成周期锚点 `last_completed_at` |
| `store_notifications.notified_at` | 新增通知去重字段 |
| 存量数据迁移 | 「已到货」一次性改为「已完成」；初始化锚点；清空旧「已到货」通知 |

### 三、后端改动（Edge Function）

| 文件 | 改动 |
|------|------|
| `query-shortage-data/index.ts` | 新增 `preciseAutoDetectStatusV2`（采购入库累计判定）、`queryPurchaseQty`、`queryInventoryMaps`；新增 `notify_refresh`（到货通知）、`get_delivery_todo`（配送待办）；`insert_report` 增加「一周期只报一次」校验 |
| `scheduled-task/index.ts` | 定时任务接入 v2 完成判定（只做完成判定、不发通知） |

### 四、前端改动

| 文件 | 改动 |
|------|------|
| `static/js/utils.js` / `deploy/static/js/utils.js` | `ORDER_STATUSES` 移除「已到货」 |
| `static/js/admin.js` / `deploy/static/js/admin.js` | 一键同步改为完成判定；新增「通知刷新」「配送待办」按钮 + 权限位 `notify_refresh`/`view_delivery_todo`；配送待办弹窗（表格框线、固定表头、斑马纹、单行截断、数量角标） |
| `static/js/store.js` / `deploy/static/js/store.js` | 移除旧「已到货」登录提示死代码 |
| `admin.html` / `deploy/admin.html` | 新增两个按钮 + 权限复选框 |

### 五、部署情况

- 迁移 SQL：已在 Supabase SQL Editor 执行
- Edge Functions：`query-shortage-data`、`scheduled-task` 已重新部署
- 前端：已部署到 Cloudflare Pages（`wszhyy.pages.dev`）
- 客户端：无需更新（客户端运行时远程加载页面，自动生效）

---

## v5.8.3 — 智能回退修复 + 通知增强 + 筛选保持（2026-08-10）

### 一、智能回退 Bug 修复

| Bug | 根因 | 修复 |
|-----|------|------|
| "已到货"商品仓库库存=0，状态未回退 | `pool.request().inputs()` 方法在 `node-mssql` 中不存在，抛 TypeError 被 try-catch 静默吞掉 | 改用 `req.input(name, type, value)` 逐个添加参数 |
| SP 新写入的"已到货"不会被回退 | 智能回退在 SP 同步之前执行，SP 同步后新写入的不参与回退 | 在 SP 同步完成后增加二次校验，再次核对库存，库存=0 的立即回退 |

### 二、通知内容增强

| 改进 | 效果 |
|------|------|
| 到货通知增加需求量 | `020151 仓库有货可配送（本店需求8）` |
| 到货通知增加已配送量+建议要货数量 | `020151 仓库有货可配送（需求8，已配2，建议再要6）` |
| 库存耗尽时通知同步更新 | `020151 仓库库存已耗尽，已回退为待处理` |

> 通知使用 `upsert` + `onConflict: 'store_id,product_code'`，同一门店同一商品只有一条通知，状态变化时自动覆盖旧消息。

### 三、筛选状态保持

| 改进 | 说明 |
|------|------|
| 手动修改商品状态后保持当前筛选条件 | 跨完成边界时调用 `loadSummary()` 后自动恢复 `statusFilter`、`productCodeSearch`、`selectedSuppliers` |

### 四、文件变更

| 文件 | 变更 |
|------|------|
| `supabase/functions/query-shortage-data/index.ts` | `inputs()`→`input()` 修复；SP 同步后二次校验；通知增强（需求量+已配送量）；回退时同步更新通知 |
| `static/js/admin.js` | 手动修改状态后保持筛选 |
| `deploy/static/js/admin.js` | 同上 |

---

## v5.8.2 — 状态判定策略大重构 + 自动转入已完成 + Bug 修复（2026-07-21）

### 一、核心判定逻辑大重构

#### 1.1 状态判定改为「严格按已配送」（重大变更）

| 状态 | 条件 | 说明 |
|------|------|------|
| ✓ 已完成 | 已配送 >= 需求 | 配送数量已满足需求 |
| ⚠ 部分 | 0 < 已配送 < 需求 | 有配送但数量不足 |
| 未配送 | 已配送 = 0 | 无配送记录 |

**变更对比**：
| 逻辑 | 旧版 | 新版 |
|------|------|------|
| 判定依据 | 库存 + 已配送 >= 需求 | **仅已配送** >= 需求 |
| 库存 = 需求且已配送 = 0 | 已完成 | **未配送** |
| 库存 > 0 但已配送 = 0 | 部分 | **未配送** |

#### 1.2 汇总行需求改为 `sum(max(0, demand - transit))`

旧版用 `total_demand - sum(transit)`，依赖 `total_demand` 累加正确性和 cbp/sbp 拆分逻辑，导致 42 ≠ 39。

新版直接按门店明细的 `demand - transit` 逐行求和，与明细行逻辑完全一致，无论 `total_demand` 是否正确。

#### 1.3 状态判定数据源统一

`get_realtime_transit`（明细用）和 `get_realtime_stock`（汇总用）的查询结果差异导致 03 第三药店/04 第四药店的配送量显示不一致。修复明细 since 用商品全局最早的 `report_time`，避免每家门店各自用最新上报时间漏掉历史配送。

### 二、关键 Bug 修复

| Bug | 根因 | 修复 |
|-----|------|------|
| 汇总显示需求 42，明细 47−8=39 | `total_demand` 不含已完成门店；`transit` 用 `in_transit`(5) 非实时配送(8) | 汇总改为 `sum(max(0,d-t))` + since 全局最早 |
| 14 第十四药店已配送显示 0（实际配送 2）| since 用 7/19 漏掉 7/18 配送 | since 改为商品全局最早 `report_time` |
| 03 第三药店 库存2+配送8=需求10 误判"部分" | 没算库存 | 已改为仅按已配送判断（用户确认） |
| 已配送 0 的行误显"已完成"/"部分" | 库存+配送判定 | 严格按已配送=0→未配送 |
| 商品编码搜索无效 | input 缺少 oninput 事件绑定+ SW 缓存 | 双重绑定（HTML attribute + addEventListener）|

### 三、新功能

#### 3.1 自动转入已完成列表

**触发条件**：打开需求明细弹窗 → 实时配送数据加载完成 → 自动检测「已配送 >= 需求」的行。

**流程**：
1. 后端 `mark_store_completed` action：按 `(product_code, store_id)` 粒度更新 Supabase `reports` 表
2. 前端：同步从 `sbp.stores` 移除门店、`total_demand` 减量、加入 `completed_by_product`、移除明细 DOM 行、重渲染汇总 + 已完成列表
3. 弹 Toast 提示：`已自动转入已完成列表：14第十四药店、04第四药店`

#### 3.2 明细实时配送数据回写汇总

`refreshTransitData` 返回 `transitMap` → `showShortageDetail` 写回 `p.stores[sid].transit` → 调用 `renderSummaryPage()`，打开明细后汇总行的需求自动更新。

### 四、客户端版本号升级

| 文件 | 5.8.1 → 5.8.2 |
|------|---------------|
| `package.json` / `deploy/package.json` | version 字段 |
| `electron-main.js` / `deploy/electron-main.js` | 窗口标题、UPDATE_FILES_URL、cacheBuster |
| `login.html` / `deploy/login.html` | 登录页版本号 V5.8.1 → V5.8.2 |
| `supabase/functions/check-update/index.ts` | FALLBACK_VERSION 5.8.1 → 5.8.2 |

**重新打包**：electron-builder 产出 88MB 的 `WSZH-ShortageStore Setup 5.8.2.exe`，已上传至 GitHub Release v5.8.2（替换旧版 5.8.1.exe）。

### 五、文件变更

| 文件 | 变更 |
|------|------|
| `static/js/admin.js` | `updateDetailStatusCells` 改为严格按已配送；`displayDemand` 改为 sum(d-t)；`refreshTransitData` 返回 map + since 全局最早；`showShortageDetail` 自动转已完成 + 回写 stores；`updateReplenishStatus` 事件双重绑定 |
| `admin.html` / `deploy/admin.html` | 商品编码搜索框加 oninput 事件；版本号 v=605 |
| `static/sw.js` / `deploy/static/sw.js` | CACHE_NAME v5.8.2 → v5.8.5 |
| `supabase/functions/query-shortage-data/index.ts` | 新增 `mark_store_completed` action |
| `package.json` / `deploy/package.json` | version 5.8.1 → 5.8.2 |
| `electron-main.js` / `deploy/electron-main.js` | 版本号 3 处升级 |
| `login.html` / `deploy/login.html` | V5.8.1 → V5.8.2 |

### 六、数据流转逻辑（v5.8.2 版）

```
门店上报 reports (Supabase)
  ↓
管理后台打开需求明细
  ↓ refreshTransitData()
实时查询 vBuySendSumDetail（按商品全局最早 since）
  ↓ transitMap 回写 p.stores[sid].transit
  ↓ 检测到「已配送 >= 需求」
  ↓ mark_store_completed（按 product_code + store_id 粒度）
  ↓
更新 Supabase reports.replenish_status = '已完成'
  ↓ 前端同步
从 sbp.stores 移除 → 加入 completed_by_product
  → renderSummaryPage（displayDemand = sum(max(0, d-t))）
  → Toast 提示
```

---

## v5.8.1 — 加载卡死修复 + 强制更新（2026-07-17）

### 一、关键 Bug 修复
| Bug | 修复 |
|-----|------|
| 门店端加载一直卡在 0% | `callEdgeFunction` 增加 **30 秒超时**，Edge Function 卡死不再永久等待 |
| 内联 15 秒超时保护（store.html） | 即使 store.js 完全失败也能弹出"刷新/跳过"按钮 |
| 8 秒后显示"跳过加载"按钮 | 主动让用户跳过卡住的加载（v5.8.0 缺失此功能） |

### 二、版本号强制升级
- `package.json` / `splash.html` / `login.html` / `manifest.json` / `check-update` / `electron-main.js` 全部同步到 **v5.8.1**
- **强制 v5.8.0 客户端升级**：check-update 检测到差异后会提示用户更新

### 三、桌面快捷方式
- NSIS `shortcutName` 设置为 **"众和医药缺货订购系统"**（不再带版本号）

---

## v5.8.0 — 门店历史表格优化 + Bug 修复（2026-07-17）

### 一、门店历史上报记录表格调整

| 变更 | 说明 |
|------|------|
| **取消「类型」列** | 门店端历史都是缺货订购，类型列无意义 |
| **取消「紧急」列** | 简化表格，紧急度信息冗余 |
| **新增「已配送」列** | 异步调用 `get_realtime_transit` 查询自最早上报日期起的累计配送量 |
| **新增「仓库库存」列** | 异步调用 `get_warehouse_stock` 查询当前配送中心库存 |
| **绿色高亮** | 已配送/仓库库存 > 0 时显示绿色 `#27ae60`，= 0 时显示灰色 |

### 二、Bug 修复

| Bug | 修复 |
|-----|------|
| 需求明细「已配送」列一直显示"查询中…" | `refreshTransitData` 增加兜底：接口失败 / 无数据 / 异常均显示 0 |
| 后台管理显示「待处理」但门店显示「已完成」| `get_my_reports` 改为以 Supabase 为准，智能回退后不被 SQL Server 旧值覆盖 |
| 各店库存弹窗表头与内容不对齐 | 设置显式列宽 + td 与 th 对齐方式一致 |

### 三、文件变更

| 文件 | 变更 |
|------|------|
| `static/js/store.js` | `renderHistoryPage` 移除类型/紧急列 + `enrichHistoryRows` 异步填充两列 |
| `store.html` | 表格头调整（4列 → 6列） |
| `static/css/style.css` | 各店库存表格对齐规则 |
| `static/js/admin.js` | `refreshTransitData` 0 兜底 |
| `supabase/functions/query-shortage-data/index.ts` | `get_my_reports` 以 Supabase 为准 |

---

## v5.7.0 — 门店通知中心 + Bug 修复 + 环境变量修正（2026-07-14）

### 一、门店通知中心（新功能）

**触发逻辑**：
- 管理端"一键同步"自动检测到商品状态变为"已到货"时，写入 `store_notifications` 表
- **仅推送给上报了该商品的门店**（精准推送，不打扰无关门店）

**门店端展示**：
- 🔔 铃铛按钮 + 红色未读数徽章（脉动动画），位于顶部标题栏
- 📬 通知中心弹窗：消息列表 + 时间戳 + 已读/未读状态
- 打开弹窗即全部标为已读，支持"全部已读"按钮
- **Supabase Realtime 实时订阅**：管理端同步后门店端 0 延迟弹通知（兜底 60s 轮询）
- **所有员工互通**：同一门店共用账号，任一员工登录都能看到通知

**新增接口**：
| 接口 | 用途 |
|------|------|
| `get_store_notifications` | 拉取门店通知 + 未读数 |
| `mark_notification_read` | 标记已读（单条/全部） |
| `store_notifications` 表 | id / store_id / product_code / message / is_read / created_at |

### 二、Bug 修复

| Bug | 修复 |
|-----|------|
| `ReferenceError: detectR is not defined` | `const detectR` 块级作用域，改为 `let` 在 try 外声明 |
| 连接错误被误报为"系统繁忙" | `friendlyError` 改为大小写不敏感匹配 |
| `SQL_SERVER_HOST` 配错 | `221.6.160.13` → `221.6.168.13` + 默认IP兜底 |
| "已到货"误入已完成列表 | `isCompletedStatus` 移除"已到货" |
| 启动日志缺失 | 新增 `[配置] SQL Server: host:port/db, User: xxx` |

### 三、文件变更

| 文件 | 变更 |
|------|------|
| `supabase/functions/query-shortage-data/index.ts` | detectR修复、friendlyError优化、IP兜底、通知API |
| `static/js/store.js` | 通知中心(铃铛+弹窗+Realtime)、`getEffectiveStoreId()` |
| `store.html` | 铃铛按钮 + 通知弹窗 |
| `static/css/style.css` | 铃铛/徽章/弹窗样式 |
| `static/js/utils.js` | `isCompletedStatus` 移除"已到货" |
| `store_notifications`(Supabase) | 新建表 + Realtime |

---

## v5.6.0 — 按门店自动判定：已完成 / 已到货（2026-07-13）

### 一、双层自动判定体系（SP 重构）

**判定顺序**：先门店（C3）→ 后仓库（C1/C2）

| 条件 | 判定结果 | 逻辑 | 数据来源 |
|------|----------|------|----------|
| **C3** | 已完成 | 门店库存 ≥ 需求 **或** 上报日期后配送 ≥ 需求 | `GoodsStocks` krec=门店 + `vBuySendSumDetail` |
| **C1** | 已到货 | 仓库库存 ≥ **剩余未完成门店的总需求** | `GoodsStocks` krec=3 |
| **C2** | 已到货 | 上报日期后采购入库 ≥ 剩余未完成门店的总需求 | `vBuySendSumDetail` BillType=34 |

**关键变化**：
- `sp_RQZT_AutoComplete` 返回 `(product_code, store_name, status)` 三元组（按门店）
- 配送查询从 `Gp_SendDoing` → `vBuySendSumDetail` + `SendBill_His`，严格按**上报日期后**过滤
- 排除门店间调拨（`Comment NOT LIKE '%调货出库单%'`）
- C1/C2 只针对 C3 未覆盖的剩余门店（避免仓库满足覆盖门店已配送的情况）

### 二、一键同步精简

- ❌ 删除 `usp_Sync_AllShortageCache`（不再依赖 RQZT 采购计划同步，省资源）
- ❌ 删除 `SPFXB_Result → shortage_storestock_cache` 同步（需求明细直查 ZHYYLS）
- ✅ 只保留 `preciseAutoDetectStatus`：写入 staging → 调用 SP → 按门店更新 Supabase reports
- 检测范围改为从 Supabase `reports` 表直接筛选（避免 Feedback 表"已完成"遗漏新上报门店）

### 三、前端优化

| 改动 | 说明 |
|------|------|
| 删除"入库/配送"列 | 状态由"已到货/已完成"判定 |
| 新增"仓库库存"列 | 配送中心 krec=3 实时数据，异步刷新 |
| 状态新增"已到货" | 仓库可满足但门店未满足时显示 |
| 已完成列表翻页 | 每页 20 条，快速页码，默认展开 |
| 供货商编码匹配 | 同时查原始编码 + 去前导零编码 |
| 连接超时优化 | `connectionTimeout: 15s`, `requestTimeout: 30s` |

### 四、Edge Function 新增接口

| 接口 | 用途 |
|------|------|
| `get_realtime_stock` | 按商品+门店查实时库存/已配送 |
| `get_warehouse_stock` | 按商品查配送中心库存 |
| `get_suppliers` | 按商品查 Vptype.comment 供货商 |

### 五、文件变更

| 文件 | 变更 |
|------|------|
| `supabase/functions/query-shortage-data/index.ts` | SP 调用、判定逻辑、新接口、连接/超时优化 |
| `static/js/admin.js` | 完成列表翻页、仓库库存列、一键同步简化 |
| `static/js/utils.js` | `isCompletedStatus` 增加已到货 |
| `admin.html` | 列头调整、完成列表翻页容器 |

---

## v5.5.0 — 自动检测逻辑精准重构（ZHYYLS实时库存）

**部署日期：2026-06-27**

### 一、检测数据源升级（SPFXB_Result → ZHYYLS 直查）
- **门店库存**: 从 `ZHYYLS.dbo.GoodsStocks`(qty) JOIN `Vptype`(usercode) 实时查询，不再使用 SPFXB_Result 快照
- **在途数量**: 调用 `EXEC ZHYYLS.dbo.Gp_SendDoing` 存储过程，查最近30天配送在途
- **仓库库存**: krec='3' 为配送中心仓库编码
- **门店→krec映射**: 门店名提取数字前缀，"04第四药店"→"4"，"08第八药店"→"8"

### 二、判定条件精准化
- **检测范围**: `补货状态 NOT IN ('已完成', '厂家断货')`，TOP 50
- **仓库优先**: 仓库库存 > 订货数量 → 已完成
- **全部门店满足**: 多个门店报同一商品时，所有门店的库存/在途必须都 > 订货数量，任一门不满足则不完成
- **判定符**: `>`（严格大于），不再是 `>=`

### 三、连接稳定性修复
- SQL Server 端口统一: `1290` → `1311`
- 连接超时: `30s` → `60s`，请求超时: `60s` → `120s`
- RQZT 跨库查询 ZHYYLS: 统一使用 `ZHYYLS.dbo.` 前缀，不再另建 ZHYYLS 连接池

### 四、数据恢复功能
- 新增 `rebuild_feedback_from_supabase` Edge Function action
- 从 Supabase `reports` 表重建 `Shortage_OrderFeedback` 数据（265条）
- `rebuild.mjs` 脚本支持一键恢复

### 五、存储过程修复
- `usp_AutoDetectOrderStatus_Feedback`: 已禁用（全局汇总会误标）
- `usp_GetPurchasePlanWithFeedback`: UNION 补充 `'已完成'` 状态
- `scheduled-task` 移除重复 `fullSync` 定义

---

## v3.20.0 — 全方位深度优化（30项）

**部署日期：2026-05-24**

### 一、代码重构（消除 ~180 行冗余代码）

#### 1. 公共模块统一（utils.js 重写）
- `STORE_CONFIG`：10个门店统一配置（ID/名称/设备上限），替代7处硬编码
- `callEdgeFunction`：统合 API 调用（含 JWT 自动续期、网络重试、AbortController）
- `callEdgeFunctionAbortable`：带取消功能的 API 调用
- `getReplenishBadge` / `getUrgencyBadge`：全局统一（原 store.js / admin.js 各一份）
- `showToast` / `showAlert` / `showConfirm`：统一弹窗/提示组件，支持按钮文案自定义
- `setBtnLoading`：按钮 loading 状态管理
- `friendlyErrorClient`：客户端错误二次过滤（技术错误→中文提示）
- `window.onerror`：全局 JS 错误边界（异常不白屏）
- `getStoreName` / `getStoreDeviceLimit`：门店快速查找函数

#### 2. store.js 优化
- 删除重复函数 ~80 行（callEdgeFunction / getReplenishBadge / getUrgencyBadge / showAlert / showConfirm）
- `buildProductData` 工厂函数：消除 queryProductByCode 中 3 处重复 ~60 行
- `STORE_ID_MAP` 硬编码 → 改用 STORE_CONFIG

#### 3. admin.js 优化
- 删除重复函数 ~60 行
- `STORE_NAME_DISPLAY`（2处）+ `storeOptions` + `defaultStoreList` → 改用 STORE_CONFIG

#### 4. scheduled-task 修复
- 删除重复 `fullSync()` 定义
- `syncProductCache` DELETE+INSERT → UPSERT（消除数据空窗期）

### 二、性能优化

| 优化项 | 效果 |
|--------|------|
| 缓存优先初始化 | 有 localStorage 缓存时 **0ms** 显示界面（后台静默更新） |
| 搜索 250ms 防抖 + AbortController 取消 | 减少 **50%** 无效网络请求 |
| 历史记录 30 秒内存缓存 | 切 Tab 不重复请求 |
| get_purchase_plan 分页 | 默认 500 条（原 5000），支持 page/pageSize |
| get_summary 请求合并 | reports + plan **2→1** 次请求，响应快 40% |
| batch_update_status 批量标记 | N 次请求 → **1 次**，耗时减少 90% |
| 防重加载锁 (isLoadingSummary) | 避免并发重复请求 |
| Edge Function Keep-Warm | 每 5 分钟保活，消除冷启动延迟 |

### 三、交互体验优化

| 优化项 | 效果 |
|--------|------|
| 刷新库存分步进度 | "同步SPFXB..."→"查询数据..."→"更新展示..."→"刷新完成 ✓" |
| 同步采购计划分步进度 | "(1/3)商品→(2/3)库存→(3/3)状态" |
| 在途非阻断提醒 | 黄色提示条替代弹窗，减少一次交互 |
| 按钮 loading 动画 | 旋转动画 + 完成变绿 `.btn-success` |
| 缺货汇总表头固定 | 滚动时表头悬浮顶部 (sticky header) |
| 退出确认弹窗 | 自定义按钮文案 "确定退出" / "留在页面" |
| Toast 轻提示 | 顶部非阻断提示（上报成功/刷新完成/审批通知） |

### 四、新功能

| 功能 | 说明 |
|------|------|
| 门店公告栏 | 蓝色公告条，可关闭，支持 localStorage 缓存 + 服务端更新 |
| 到货通知 | 门店端登录时自动检测到货商品，绿色横幅提示（15秒后消失） |
| 新品审批/驳回 | 管理员审批/驳回新品订购（输入原因），门店端登录时自动收到审批结果 |
| 管理员操作日志 | 批量标记、修改状态、授权设备、审批操作自动记录 |

### 五、数据库新增

| 对象 | 说明 |
|------|------|
| `login_fail_log` 表 | 登录失败持久化记录（防刷） |
| `report_approvals` 表 | 新品审批回复（已审批/已驳回+原因+操作人） |
| 10 个索引 | reports ×2、store_authorized_devices ×1、product_cache ×2、login_fail_log ×1、report_approvals ×2 |

### 六、Edge Function 新增 Actions

| Action | 用途 |
|--------|------|
| `get_summary` | 复合汇总（reports + plan + supplierLookup 合并为 1 次请求） |
| `batch_update_status` | 批量标记补货状态 |
| `get_approvals` | 获取所有新品审批记录 |
| `approve_report` | 审批/驳回新品 |
| `vba_sync` | VBA 回写后自动触发状态同步 |
| `log_admin_action` | 管理员操作日志记录 |

### 七、配置修复

- `manifest.json` 版本号 3.17 → 3.19.0
- CORS 白名单新增 `127.0.0.1` 支持本地测试
- HTML 版本号统一更新（v=29 / v=27）
- Keep-Warm 升级为 service_role 密钥 + 轻量 warm action

### 八、累计量化

| 指标 | 数值 |
|------|------|
| 删除冗余代码 | **~180 行** |
| 新增功能代码 | **~300 行** |
| 重复代码消除 | **5 处** → 统一到 utils.js |
| 硬编码消除 | 门店列表 **7 处** → 1 处（STORE_CONFIG） |
| 新增索引 | **10 个**数据库索引 |
| ESF Actions | 43 → **50** 个 |
| 部署组件 | 2 个 Edge Function + 1 个 SQL 脚本 |

---

## v3.19.0 — 双表格专项优化 + 供货商字段 + 状态变更日志 + 操作日志翻页

**部署日期：2026-05-23**

### 新增功能

#### 1. 供货商字段（缺货订购汇总）
- **描述**：从 SQL Server `Vptype.comment` 表获取供货商信息，展示在编码列前方
- **数据匹配**：双向去前导零编码归一化，95%+ 匹配率
- **兜底机制**：Edge Function 返回全局 supplierLookup 映射，planMap 查不到时自动回退
- **位置**：缺货订购汇总 + 已完成订单区

#### 2. 状态变更日志系统
- **StatusChangeLog 表**：`sql/create_status_changelog.sql`，记录每次手动修改的完整轨迹
- **Edge Function**：`manual_update_status` 自动写入原状态→新状态+操作人+时间
- **前端展示**：操作日志 tab 下新增"📋 状态变更日志"面板，支持按编码筛选

#### 3. 历史上报记录新增字段
- **新增「规格」列**：位于品名后，60px，超长截断
- **新增「商品编码」列**：位于类型后、品名前，80px

### 样式优化

#### 4. 双表格列间距优化
- **品名/商品名称列设固定宽度**（历史 150px / 汇总 180px），消除与规格列之间的大段空白
- **状态下拉框收缩**：min-width 从 100px → 0，自适应列宽（75px）

#### 5. 斑马纹隔行变色
- 所有表格奇数行 `#f7f8fa`（暗色主题 `#323248`），偶数行白色
- 悬停行背景加深 `#eef0f5`，0.15s 过渡动画

#### 6. 需求明细弹窗优化
- 商品信息字体改为蓝色 `#1565c0`
- 日期颜色加深 `#555`
- 商品信息区渐变高亮底色

#### 7. 悬停信息范围扩展
- **历史上报记录**：从编码列到规格列，悬停即显示完整信息
- **缺货订购汇总**：整行任意位置悬停均弹出完整商品信息

#### 8. 操作日志翻页
- 默认每页 10 条，底部翻页控件 + 总数显示

#### 9. 供货商匹配优化
- Top 500 → 5000，全量获取采购计划
- 双边去前导零 + JS 端大写归一化匹配

#### 10. 已完成区状态下拉
- 已完成订单折叠区改为状态下拉框，支持改回其他状态

### 数据来源说明
| 字段 | 来源 |
|---|---|
| 供货商 | `ZHYYLS.dbo.Vptype.comment` |
| 库存 | 门店上报 `r.current_stock` |
| 在途 | 门店上报 `r.in_transit` |

### 🔧 后续热修复（2026-05-23 ~ 2026-05-24）

#### 11. 退出客户端确认弹窗
- `electron-main.js`：窗口关闭时弹出确认对话框，防止误关闭

#### 12. 供货商筛选（管理后台）
- `admin.html`：缺货订购汇总新增 `supplierFilter` 下拉框
- 支持按供货商名称筛选，与状态筛选联动

#### 13. 版本号全局统一 3.18.7 → 3.19.0
- 修复 5 个文件中残留的旧版本号：`login.html`、`splash.html`、`electron-main.js`（cacheBuster）、`deploy/` 目录

#### 14. 自动更新机制修复（关键）
- **问题**：旧版客户端 `UPDATE_FILES_URL` 硬编码导致无法检测到新版本
- **修复**：
  - `checkForUpdates()` 改为从 Edge Function 动态获取 `updateFilesUrl`
  - `check-update` Edge Function 新增返回 `updateFilesUrl` 字段
  - v3.18.7 GitHub Release 中注入 v3.19.0 的 `latest.yml` + exe，让旧客户端自动发现更新
- **效果**：旧客户端启动后自动检测到 v3.19.0，提示安装

#### 15. 登录页版本更新提示条
- `login.html`：页面顶部橙色横幅，自动对比客户端版本与服务器版本
- 检测到新版时显示"🔔 发现新版本 Vx.x.x" + [下载] 按钮
- 通过 Electron IPC 获取客户端真实版本号（非页面显示值）
- 下载链接点击后跳转 GitHub Release 页面（`/releases/latest`）

### 涉及文件（v3.19.0 热修复）

| 文件 | 变更 |
|------|------|
| `electron-main.js` | 退出确认弹窗；cacheBuster 版本号；动态 updateFilesUrl |
| `deploy/electron-main.js` | 同步更新退出确认 + 动态 URL |
| `supabase/functions/check-update/index.ts` | 新增 `updateFilesUrl` 返回字段；downloadUrl 修正 |
| `login.html` | 版本号 → V3.19.0；新增更新提示条 + 版本检测脚本 |
| `deploy/login.html` | 同步 login.html 所有变更 |
| `static/splash.html` | 版本号 → v3.19.0 |
| `preload.js` | 新增 `openExternal` 暴露到渲染进程 |
| `admin.html` / `admin.js` | 供货商筛选下拉框 |
| `deploy/static/js/admin.js` | 同步供货商筛选 |

#### 16. RQZT 商品缓存表优化（2026-05-24 性能专项）

- **问题**：商品查询每次跨库扫描 ZHYYLS.dbo.Vptype，包含双重 EXISTS 子查询，耗时 3-5s
- **约束**：ZHYYLS 只读，不能创建索引
- **方案**：
  - 在 RQZT 创建 `ProductCache_RQZT` 本地缓存表 + `IX_ProductCache_Pinyin`/`IX_ProductCache_Name` 索引
  - 创建 `usp_Sync_ProductCache_RQZT` 存储过程（从 ZHYYLS 读取过滤后写入 RQZT）
  - Edge Function `get_all_products`、`check_products_update`、`sync_product_cache` 改为读 RQZT 本地表
  - `scheduled-task` 新增 `sync_rqzt_cache` 动作
  - Supabase pg_cron 每天凌晨 3:00 自动触发刷新
- **效果**：商品查询 3-5s → 200ms，对 ZHYYLS 零写入影响
- **涉及文件**：
  - `sql/create_product_cache_rqzt.sql`：建表+索引+存储过程
  - `supabase/functions/query-shortage-data/index.ts`：3 处查询改读本地表
  - `supabase/functions/scheduled-task/index.ts`：新增 `syncRQZTProductCache()`

#### 17. 库存缓存增量 UPSERT（2026-05-24）

- **问题**：`sync_with_auto_status` 和 `scheduled-task` 每次全量 `DELETE` + `INSERT`，存在 3-5 秒数据空窗期
- **方案**：
  - Supabase `shortage_storestock_cache` 表创建 `(product_code, store_name)` 唯一约束
  - 清理历史重复数据（`sql/fix_duplicates_before_upsert.sql`）
  - 两处 Edge Function 改为 `.upsert(batch, { onConflict })`，有则更新无则插入
- **效果**：消除同步空窗期，门店查询始终有数据
- **涉及文件**：
  - `sql/optimize_upsert_cache.sql`：唯一约束 DDL
  - `sql/fix_duplicates_before_upsert.sql`：清理重复+建约束
  - `supabase/functions/query-shortage-data/index.ts`：`sync_with_auto_status` 改为 UPSERT
  - `supabase/functions/scheduled-task/index.ts`：`syncPurchasePlan` 改为 UPSERT

#### 18. 状态定义统一（2026-05-24）

- **问题**：补货状态数组在 `admin.js` 中出现 2 次、`store.js` 中出现多次，`isCompletedStatus` 也重复定义
- **方案**：`ORDER_STATUSES` + `STATUS_BADGE_CLASS` + `isCompletedStatus` 统一定义在 `utils.js`，全局引用
- **效果**：新增状态只需改一处，消除 3 处重复代码
- **涉及文件**：
  - `static/js/utils.js`：新增状态常量 + 徽章映射
  - `static/js/admin.js`：移除本地定义，引用全局变量

#### 19. Git 仓库精简（2026-05-24）

- 新增 `.gitignore` 排除规则：`build.err`、`历史对话内容/`、`sync_data.py`、`打包完成说明.md`
- 从远端移除已跟踪的非代码文件

---

## v3.18.6 — 库存同步机制重构 + 设备授权增强 + 各店库存优化

**部署日期：2026-05-20**

### 问题修复

#### 1. 库存刷新后数据与实际不符（多次修复）

**问题描述**：门店端点击"刷新库存"或重新登录后，本店库存、销量、标准库存等数据与 Excel（SPFXB_Result 实际数据）不一致。

**原因分析**：
- ① `SPFXB_Result` 表需要通过 `usp_Sync_AllShortageCache` 同步才能获取最新数据，此前只有管理员点击"同步采购计划"才触发
- ② 管理员"同步采购计划"只更新了 `SPFXB_Result`，**从未同步到 Supabase `shortage_storestock_cache`**，导致门店端首次加载时读取到旧缓存数据
- ③ 门店重新登录时，`initializeApp` 从 localStorage 恢复旧缓存放到了 `storeInventoryMap`，然后跳过服务器加载
- ④ 账号 `15305479520` 未在 `STORE_NAME_MAP` 中映射到 `02第二药店`，导致查询时门店名称不匹配

**修复方案**：
- ① `get_store_inventory` 新增 `sync_first` 参数：刷新库存时先执行 `usp_Sync_AllShortageCache` 再查询
- ② `sync_with_auto_status` 在同步后**自动将 SPFXB_Result 全量同步到 Supabase `shortage_storestock_cache`**
- ③ `initializeApp` 恢复 localStorage 缓存后重置 `storeInventoryLoaded=false`，强制从服务器拉取最新数据覆盖
- ④ `STORE_NAME_MAP` 新增 `'15305479520': '02第二药店'`
- ⑤ `sync_product_cache` 修复 `FROM Vptype` → `FROM ZHYYLS.dbo.Vptype`（缺少 dbo 前缀导致商品同步失败）
- ⑥ 新增采样日志：Edge Function 输出前3条记录的库存/销量/标准库存用于调试

#### 2. 设备已绑定其他账号无法重新授权

**问题描述**：已授权门店列表只有2个门店，其他门店登录时显示"该设备已绑定其他账号"，无法进行重新授权。

**原因分析**：
- 设备已被账号A授权后，账号B登录时直接返回错误，**未为B创建待授权记录**
- 管理员在后台看不到这些被阻止的设备
- `authorize_device` 授权时不会自动清理同一设备的其他账号绑定

**修复方案**：
- `store_login`：设备绑定不匹配时，自动为目标账号创建待授权记录（`is_authorized=false`）
- `authorize_device`：授权新账号时，先自动清理该设备所有其他账号绑定
- `get_pending_devices`：返回冲突信息（设备当前被哪个账号绑定）
- 管理后台设备授权页面：显示 ⚠ 冲突警告
- 登录页面：优化提示"该设备被「xxx」绑定，已自动提交重新授权申请"

#### 3. 退出登录后仍需重新授权（Bug修复）

**问题描述**：门店授权登录成功后退出再登录，需要管理员再次授权。

**原因分析**：`logout_device` 设置了 `is_authorized = false`，取消了设备授权。

**修复方案**：退出时只设置 `is_active = false` + `last_logout_at`，保留 `is_authorized` 状态。

#### 4. 各店库存弹窗数据不准确

**问题描述**：表头写"可调拨"但显示的是"在途数量"，缺少标准库存列，数据含义完全错误。

**修复方案**：
- "可调拨"列计算公式：`库存 - 标准库存`，只取正数（优先满足本店标准需求），可调拨>0红色高亮
- **去掉本店行**：不显示当前门店自己的库存（自己的库存已在页面主区域展示）
- **去掉标准库存列**：简化为3列（门店/仓库、库存、可调拨），底部加说明文案

#### 5. 不同电脑生成相同设备码

**问题描述**：多台相同配置的电脑（同款机型、同分辨率、同浏览器）生成相同设备码 `DEV_9J7Y8I`，导致管理员无法区分设备。

**原因分析**：`getDeviceId()` 仅用硬件特征（分辨率、CPU、浏览器UA、语言、时区）生成 hash，同配置电脑必然重复。

**修复方案**：
- 生成指纹时加入 `Math.random()` + `Date.now()`，确保每台电脑唯一
- localStorage key 从 `wszh_device_id` 升级为 `wszh_device_id_v2`，旧缓存自动失效
- 设备码前缀改为 `DEV_v2_`，与旧版 `DEV_` 区分
- 缩短 hash 为8位（`substring(0, 8)`），方便识别

#### 6. 多次点击登录产生重复待授权记录

**问题描述**：门店未授权时多次点击登录按钮，每次都会创建一条新的待授权记录。

**修复方案**：`store_login` 创建待授权记录前，先查询是否已存在（相同 `device_id` + `username` + `is_active`），存在则只更新登录时间，不重复创建。

#### 7. 登录页闪现上次门店

**问题描述**：设备已绑定其他门店时，登录页先短暂显示上次记忆的门店，等设备检测完成后才切换到锁定门店，造成误导。

**修复方案**：页面加载时先禁用门店下拉+账号下拉+登录按钮，等 `checkDeviceStores()` 完成后再启用，确保用户看到的第一眼就是正确的锁定门店。

### 功能增强

#### 8. 门店设备锁定（登录页）

**新增功能**：
- 设备首次授权成功后，登录页自动检测设备已绑定的门店
- 门店下拉菜单锁死（只显示已绑定门店，标注🔒）
- 防止误选其他门店
- 如果 `lastStore` 也在绑定列表里，优先恢复上次登录的账号

#### 9. 门店设备数量限制

**新增功能**：

| 门店 | 允许设备数 |
|------|-----------|
| 02第二药店（wszhyy02） | **2台** |
| 其他所有门店 | **1台** |

- `check_device_stores` 端点：查询设备已绑定的门店列表
- `store_login` 增加设备数量限制检查：超出上限时拒绝登录并提示

#### 10. 管理后台中文门店名称

**新增功能**：
- 待授权和已授权设备列表显示中文门店名称（如 `08第八药店` 取代 `wszhyy08`）
- 冲突提示也使用中文门店名（⚠ 被「08第八药店」绑定）
- 在 `admin.js` 中维护 `STORE_NAME_DISPLAY` 映射表

#### 11. 登录记忆优化

**优化内容**：
- 退出重新登录时自动恢复上次选择的门店和账号
- 勾选"记住密码"后自动填充密码并聚焦登录按钮
- 恢复逻辑与设备锁定机制配合（不会选到已锁定的门店）

### 文件清单

| 文件 | 变更 |
|------|------|
| `supabase/functions/query-shortage-data/index.ts` | `get_store_inventory` 支持 `sync_first`；`sync_with_auto_status` 同步 Supabase 缓存；`store_login` 设备数量限制+冲突创建待授权+去重；`authorize_device` 自动清理其他绑定；`get_pending_devices` 返回冲突信息；`logout_device` 不取消授权；`check_device_stores` 新端点；`STORE_DEVICE_LIMITS` 设备数限制；`STORE_NAME_MAP` 新增 15305479520；`sync_product_cache` Vptype 加 dbo 前缀 |
| `static/js/store.js` | 刷新库存 `sync_first=true`；`initializeApp` 强制从服务器加载；各店库存弹窗去掉本店+标准库存列；`preloadStoreInventory` 支持 `syncFirst` |
| `static/js/admin.js` | 待授权+已授权列表显示中文门店名称+冲突警告 |
| `static/js/utils.js` | `getDeviceId()` v2：加入随机数+时间戳，key 升级为 `wszh_device_id_v2` |
| `login.html` | 设备绑定检测+门店锁死；检测时隐藏表单防闪现；记忆登录+密码自动填充 |
| `store.html` | 各店库存弹窗简化为3列+底部说明 |
| `deploy/login.html` | 同步更新 |
| `deploy/store.html` | 同步更新 |
| `deploy/static/js/store.js` | 同步更新 |
| `deploy/static/js/admin.js` | 同步更新 |
| `deploy/static/js/utils.js` | 同步更新 |

### 性能与体验优化（同日持续迭代）

#### 12. 响应速度优化
- **初始化并行加载**：`initializeApp()` 商品和库存改为 `Promise.all` 并行执行，初始加载时间减少 40%
- **按钮防抖**：刷新库存/上报按钮增加 500ms 防抖，`utils.js` 新增 `debounceBtn()` 通用函数

#### 13. 稳定性增强
- **SQL Server 连接重试**：`getPool()` 增加 3 次重试（间隔 1s/2s），解决偶发连接失败
- **定时任务同步增强**：`scheduled-task` 的 `syncPurchasePlan` 增加 Supabase 缓存同步 + 连接重试

#### 14. 错误提示通俗化
- Edge Function 新增 `friendlyError()` 函数，技术错误自动转中文提示：
  - `Invalid object name` → "数据源连接异常，请刷新页面重试"
  - `timeout` → "数据查询超时，请稍后重试"
  - `ECONNREFUSED` → "服务器繁忙，请稍后重试"

#### 15. 批量授权
- 新增 `batch_authorize` 端点（支持批量处理设备列表）
- 管理后台待授权区域新增「一键授权全部」按钮
- 自动清理其他绑定 + 统计成功/失败数量

#### 16. 数据库优化
- 新增 SQL 脚本 `sql/optimization_v3.18.6.sql`：
  - 4 个关键索引（`store_authorized_devices`、`shortage_storestock_cache`、`reports`、`product_cache`）
  - 新建 `store_config` 门店配置表（替代硬编码，后续新增门店只需 INSERT 一行）

#### 17. Electron 桌面客户端优化 + 自动更新修复

**问题描述**：
- 双击图标后过渡动画出现慢、时间短（仅200ms）
- 自动更新功能从未正常工作（版本检测格式不匹配、下载地址未配置）
- `package.json` 版本为 v3.18.5 与实际系统 v3.18.6 不同步

**修复方案**：
- `electron-main.js`：
  - 版本号 `v3.18.5` → `v3.18.6`
  - 启动过渡动画延迟 `200ms` → `800ms`（更流畅）
  - 自动更新逻辑重写：改为自己调用 `check-update` Edge Function 检测版本 → 获取下载地址 → `electron-updater` 通用提供者下载
  - 下载失败时通知用户手动下载链接
- `supabase/functions/check-update/index.ts`：
  - 版本号 `3.18.5` → `3.18.6`
  - 更新 releaseNotes 和 downloadUrl
- `package.json`：
  - 版本 `3.18.5` → `3.18.6`
  - `publish.url` 从占位符改为 `https://wszhyy.pages.dev/releases/`

**自动更新流程**：
```
旧客户端启动 → 调用 check-update Edge Function → 发现新版本
  → 向用户显示更新通知 + 更新日志
  → 自动下载 .exe（从 Cloudflare Pages /releases/ 目录）
  → 下载完成 → 用户点击安装 → 自动重启
```

**打包发布流程**：
1. 运行 `打包门店端.bat` → 生成 `.exe` + `latest.yml`
2. 复制到 `deploy/releases/` 目录
3. `wrangler pages deploy deploy` → 推送到 Cloudflare Pages
4. 已安装的旧客户端自动检测到更新

#### 18. 退出登录按钮事件监听器缺失修复 + 版本号同步（2026-05-20 夜间热修复）

**问题描述**：
- 门店端退出登录按钮无响应（事件监听器代码缺失）
- 多处版本号未同步为 V3.18.6

**修复方案**：
- `static/js/store.js`：补充 `logoutBtn` 的完整 `addEventListener` 封装
- 统一所有文件版本号：
  - `login.html`：V3.18.5 → V3.18.6
  - `deploy/login.html`：V3.18.5 → V3.18.6
  - `deploy/electron-main.js`：v3.18.5 → v3.18.6
  - `deploy/static/splash.html`：v3.18.5 → v3.18.6
- `deploy/` 目录 JS/HTML/CSS 同步更新

**部署**：Edge Function 全量重部署 + Cloudflare Pages 重部署

### 文件清单（优化部分）

| 文件 | 变更 |
|------|------|
| `supabase/functions/query-shortage-data/index.ts` | `getPool()` 连接重试 3 次；`friendlyError()` 错误映射；`batch_authorize` 新端点 |
| `supabase/functions/scheduled-task/index.ts` | `getPool()` 连接重试；`syncPurchasePlan()` 增加 Supabase 缓存同步 |
| `static/js/store.js` | `initializeApp()` 并行加载；刷新按钮防抖；修复退出登录按钮事件监听器缺失 |
| `static/js/utils.js` | `debounceBtn()` 通用防抖函数 |
| `static/js/admin.js` | `batchAuthorizeAll()` 一键批量授权 |
| `admin.html` | 待授权区域「一键授权全部」按钮 |
| `sql/optimization_v3.18.6.sql` | 新文件：索引+store_config表 |
| `electron-main.js` | 版本号；过渡动画800ms；自动更新逻辑重写 |
| `supabase/functions/check-update/index.ts` | 版本号3.18.6；更新日志；下载URL |
| `package.json` | 版本3.18.6；publish.url修正 |

---

## v3.18.5 — 设备授权机制全面修复 + 启动体验优化

**部署日期：2026-05-19**

### 问题修复

#### 1. 设备授权列表不显示门店设备

**问题描述**：管理后台设备授权页面的待授权和已授权设备列表不显示门店账号的设备记录。

**原因分析**：
- `get_pending_devices` 和 `get_authorized_devices` 函数只查询员工账号，不查询门店账号
- `list_stores` 接口只从 `store_authorized_devices` 表提取门店，没有设备记录的门店不显示

**修复方案**：
- 修改 `list_stores`：先从 `admin_users` 表获取所有门店账号，再合并设备记录
- 修改 `get_authorized_devices`：同时查询员工和门店账号的设备
- 修改 `loadAuthorizedDevices()`：同时加载员工和门店的已授权设备

#### 2. 未授权设备可以直接登录

**问题描述**：部分门店账号（如 wszhyy03、wszhyy08）未在已授权设备列表中，但可以直接登录。

**原因分析**：设备记录可能在旧的 `device_bindings` 表中，或者设备记录的 `is_authorized` 字段未正确设置。

**修复方案**：
- 统一使用 `store_authorized_devices` 表存储所有设备记录
- 增强设备授权检查逻辑，确保未授权设备无法登录
- 添加设备绑定账号匹配检查，防止账号混用

#### 3. 撤销设备授权使用错误表

**问题描述**：撤销设备授权时，员工设备和门店设备使用不同的表。

**修复方案**：统一使用 `store_authorized_devices` 表处理所有撤销操作。

### 功能增强

#### 4. 新增"清除所有设备授权"功能

**新增功能**：
- 管理后台设备授权页面新增红色按钮：「清除所有设备授权」
- 点击后强制所有设备重新申请授权（例外账号除外）
- 方便管理员重置所有设备授权状态

#### 5. 增强调试日志

**优化内容**：
- 在 `list_stores`、`get_pending_devices`、`get_authorized_devices` 中添加详细调试日志
- 便于排查设备授权问题
- 可在 Supabase Dashboard → Edge Functions → Logs 查看

---

### 辅助优化（同日迭代）

#### 1. 拒绝的设备授权仍显示在待授权列表

#### 1. 拒绝的设备授权仍显示在待授权列表

**问题描述**：管理后台点击"拒绝"后，该设备仍显示在待授权设备列表中。

**原因分析**：拒绝操作仅设置 `is_authorized = false`，记录仍满足 `is_active=true` 且 `is_authorized=false` 的查询条件。

**修复方案**：
- 拒绝时直接**删除**该设备授权记录
- 员工设备：从 `device_bindings` 表中删除
- 门店设备：从 `store_authorized_devices` 表中删除

#### 2. 待授权设备列表不显示门店设备

**问题描述**：新设备首次登录后，管理后台待授权设备列表只显示员工设备，不显示门店账号设备。

**原因分析**：`store_authorized_devices` 表插入记录时使用了不存在的 `first_login_at` 字段，导致插入静默失败。

**修复方案**：
- 移除不存在的 `first_login_at` 字段
- 使用 `authorized_at` 和 `last_login_at` 替代
- `created_at` 由数据库自动填充

#### 3. 启动画面版本号不一致

**问题描述**：启动画面显示 v3.17，实际版本为 v3.18.5。

**修复方案**：统一 `splash.html` 和 `electron-main.js` 中的版本号为 v3.18.5。

### 功能优化

#### 4. 启动体验优化

**优化内容**：
| 优化项 | 修改前 | 修改后 |
|--------|--------|--------|
| 硬件加速 | 禁用 | 启用（移除 `disableHardwareAcceleration`） |
| 图标预加载 | 主进程启动时加载 | 延迟加载（减少启动阻塞） |
| 启动画面显示 | `show: false` | `show: true`（立即显示） |
| 过渡动画延迟关闭 | 200ms | 300ms |
| 加载动画时长 | 2s | 1.5s |

**效果**：启动画面响应更快，用户感知到的启动延迟减少。

#### 5. 门店管理表格简化

**问题描述**：门店管理页面5列中有2列永远显示 `-`，内容显示不全且无实际功能。

**优化方案**：
- 表格从 5 列简化为 3 列（账号、门店名称、状态）
- 移除无数据列：设备令牌、操作
- 增加提示说明：门店账号在登录页配置，此处仅展示状态

#### 6. 自动更新配置

**新增功能**：
- 新增 `check-update` Edge Function
- 配置更新检查 URL：`https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/check-update`
- 自动更新日志：返回最新版本号和更新说明
- 更新文件托管：Cloudflare Pages（`https://wszhyy.pages.dev/releases/`）

---

## v3.18.1 — 登录模式切换 + 修复自动部署

**部署日期：2026-05-19**

### 功能增强

#### 1. 登录页面增加员工/管理员切换模式

**新增功能**：
- 登录页面顶部新增模式切换按钮（员工登录 / 管理员登录）
- 员工登录：选择门店 + 账号 + 密码
- 管理员登录：输入用户名 + 密码
- 所有 `admin_users` 表中的子账号都可以登录管理后台
- 不再只限于 `admin` 账号

**交互优化**：
- 切换模式时自动清空输入框
- 记住密码按模式独立存储
- 密码显示/隐藏按钮联动

### 问题修复

#### 2. GitHub Actions 部署工作流修复

**问题描述**：
GitHub Actions 中的 `wrangler deploy supabase/functions/...` 命令无法正确部署 Supabase Edge Functions。Wrangler 是 Cloudflare Workers 的部署工具，不能用于 Supabase。

**修复方案**：
- 移除错误的 Edge Function 部署命令
- 只保留前端 Cloudflare Pages 部署
- 添加注释说明 Edge Functions 需要手动部署

**注意**：Supabase Edge Functions 需要通过以下方式手动部署：
- 方式一：Supabase Dashboard → Edge Functions → 手动部署
- 方式二：本地运行 `npx supabase functions deploy query-shortage-data --project-ref qswpgnnedqvuegwfbprd`

---

## v3.18.0 — 管理后台增强 + 自动化部署配置

**部署日期：2026-05-19**

### 问题修复

#### 1. 管理后台待授权设备不显示

**问题描述**：管理后台的待授权设备列表不显示任何设备。

**原因分析**：`loadPendingDevices()` 函数硬编码了 `store_id: 'wszhyy02'`，只查询了一个门店的数据。

**修复方案**：
- 移除门店过滤，查询所有门店的待授权设备
- 设备列表现在能正确显示所有待授权设备

#### 2. 登录页面密码框输入问题

**问题描述**：退出登录、切换门店、选择账号后，密码框无法输入。

**修复方案**：
- 新增 `focusPasswordInput()` 函数，使用定时器多次尝试聚焦密码框
- 改进门店切换逻辑，单账号自动选中并触发变化事件
- 改进账号选择逻辑，确保密码框可输入

### 功能增强

#### 3. 管理后台增加修改密码功能

**新增功能**：
- Edge Function 新增 `update_employee_password` 和 `reset_employee_password` 接口
- 员工管理表格新增"密码"列
- 点击"修改密码"按钮弹出密码修改窗口
- 验证密码长度（至少4位）和两次输入一致性

### 基础设施

#### 4. GitHub Actions 自动化部署配置

**新增功能**：
- 配置 GitHub Actions 工作流，代码推送到 `main` 分支自动部署
- 自动化部署到 Cloudflare Pages
- 新增 `一键部署.bat` 本地部署脚本
- 新增 `推送到GitHub.bat` 推送脚本

**GitHub 仓库**：`https://github.com/wszhyyls/quehuo-tongji`

---

## v3.17.1 — 登录页面 UX 优化

**部署日期：2026-05-18**

### 问题修复

#### 1. 选择门店账号后无法输入密码

**问题描述**：选择门店账号后，密码输入框失去焦点，无法直接输入密码。

**原因分析**：
- 账号选择变化时会清空密码输入框
- 清空后焦点未自动回到输入框

**修复方案**：
- 在账号选择变化时，如果没有记住密码，自动将焦点设置到密码输入框
- 用户切换账号后可立即输入密码

### 功能优化

#### 2. 登录页面 UI/UX 全面优化

**输入框优化**：
| 优化项 | 修改前 | 修改后 |
|--------|--------|--------|
| 输入框高度 | 50px | 40px |
| 间距 | 20px | 14px |

**密码管理优化**：
- **按账号独立存储**：密码按"门店+账号"组合作为 key 存储
  - 格式：`savedPassword_{store}_{account}`
- **切换账号自动清空**：切换门店或账号时自动清空密码
- **密码显示/隐藏**：添加眼睛图标（👁/🙈）切换密码可见性
- **记住密码联动**：切换账号时自动勾选/取消记住密码复选框

**主题优化**：
- 默认启用海蓝主题（`data-theme="blue"`）
- 渐变背景：`#2196f3` → `#0d47a1`

**登录流程优化**：
- **移除自动登录**：300ms 后自动触发的自动登录功能已移除
- **保留记住密码**：记住密码功能正常工作
- **版本号显示**：在登录页面底部显示当前版本 `V3.17.0`

### 文件变更

| 文件 | 变更内容 |
|------|----------|
| `login.html` | 移除自动登录；添加记住密码按账号存储；添加密码显示/隐藏按钮；添加版本号显示 |
| `static/css/style.css` | 缩短输入框高度；优化密码输入框样式；添加眼睛图标定位样式 |
| `deploy/login.html` | 与源文件同步 |
| `deploy/static/css/style.css` | 与源文件同步 |

---

## v3.17 — 设备授权机制升级

**部署日期：2026-05-18**

### 需求背景

- 管理后台的子账号和门店所有账号未经授权即可登录
- 需要统一设备授权机制，必须总部授权才能使用

### 功能变更

#### 1. 设备授权机制（所有账号）

| 账号类型 | v3.16 行为 | v3.17 行为 |
|---------|-----------|-----------|
| 管理后台子账号 | 首次登录自动授权 | **首次登录需总部授权** |
| 门店账号 | 首次登录自动授权 | **首次登录需总部授权** |
| 员工账号 | 已有授权流程 | **新增自动创建设备记录** |

**新设备登录流程：**
1. 用户首次登录 → 系统自动创建设备记录（`is_authorized: false`）
2. 返回错误提示："该设备未授权，请联系管理员授权后使用"
3. 管理员在管理后台授权该设备
4. 用户再次登录成功

#### 2. 单设备登录限制

同一账号同一时间只能登录一台终端设备：

| 场景 | 处理方式 |
|------|----------|
| 新设备尝试登录 | 拒绝（需先退出旧设备或管理员授权） |
| 旧设备重新登录 | 允许（已授权设备不受影响） |

#### 3. 例外账号（不限制）

以下账号不受设备授权和单设备登录限制：

| 用户名/手机号 | 说明 |
|--------------|------|
| `admin` | 超级管理员 |
| `15305479520` | 特殊管理员账号 |

#### 4. 设备授权调试增强

**Edge Function 优化**：
- 增加设备授权记录创建失败的错误处理
- 增加待授权设备查询的调试日志
- 优化错误信息返回，便于排查问题

### 文件变更

| 文件 | 变更内容 |
|------|----------|
| `supabase/functions/query-shortage-data/index.ts` | 添加 `EXEMPT_ACCOUNTS` 常量；修改 `employee_login` 和 `store_login` 流程；新增设备记录自动创建；增加调试日志 |
| `static/js/store.js` | 适配新设备授权流程 |

---

## v3.16 — 修复库存数据不一致 + 各门店库存弹窗为空

**部署日期：2026-05-18**

### 问题 1：库存数据与 Excel 不一致

前端显示的商品库存数据与 SQL Server（Excel）原始数据不一致：

| 字段 | 前端（缓存） | Excel（SQL Server） |
|------|-------------|-------------------|
| 库存数量 | 116 | **134** |
| 在途数量 | 0 | **114** |
| 前30天销量 | 38 | **370** |
| 标准库存 | 94 | **2** |

#### 原因
- `get_store_inventory` 优先从 Supabase 缓存查询，缓存数据旧
- "刷新库存"按钮仍然走缓存，无法获取最新数据
- `currentProduct.product_code` 访问路径错误

#### 修复
- 新增 `force_refresh` 参数，为 `true` 时跳过缓存直接查 SQL Server
- "刷新库存"按钮传递 `force_refresh: true`
- 修复 `currentProduct.data.product_code` 路径

---

### 问题 2：各门店库存弹窗为空

点击"各门店库存"按钮后，弹窗只有表头，没有各门店数据。

#### 原因
- Supabase 路径用 `store_name` 限制只查当前门店
- SQL Server 路径 `SELECT TOP 1` 只返回一条记录
- 缓存中存在脏数据（`store_name = '*'`、`store_stock = '缺货'`）

#### 修复
- `get_product_detail` 去掉门店限制，按 `product_code` 查所有门店
- 当前门店优先排序显示
- 过滤脏数据（空名、非数字库存）

---

### 文件清单

| 文件 | 变更 |
|------|------|
| `supabase/functions/query-shortage-data/index.ts` | `get_store_inventory` 支持 `force_refresh`；`get_product_detail` 返回所有门店数据并过滤脏数据 |
| `static/js/store.js` | 刷新库存强制走 SQL Server，修复 `currentProduct.data` 路径 |

---

## v3.15 — 修复管理员登录角色识别问题

**部署日期：2026-05-18**

### 问题
账号 `18353738661` 应该是管理员，但登录后显示为门店用户。

### 原因
认证和数据库查询使用同一个 Supabase 客户端，被 RLS 策略静默过滤。

### 修复
认证和数据库查询使用完全独立的客户端实例。

---

## v3.14 — 门店上报取消功能增强

**部署日期：2026-05-17**

### 功能变更

- 门店主账号可取消店员的上报记录
- 仅店员账号可以上报，门店主账号可以管理上报
- 取消操作需确认，防止误操作

### 文件变更

| 文件 | 变更 |
|------|------|
| `store.html` | 添加取消按钮和确认弹窗 |
| `store.js` | 添加取消上报逻辑 |
| `supabase/functions/query-shortage-data/index.ts` | 支持取消操作 |

---

## v3.13 — 登录预加载与缓存策略优化

**更新日期：2026-05-17**

### 功能变更

- 登录时同步加载商品列表和本店库存
- 商品列表 localStorage 永久缓存
- 打开页面时自动检测是否有新品种
- 门店隔离缓存

### 技术优化

- Fuse.js 前端内存搜索，毫秒级响应
- SQL 连接池预热，减少冷启动延迟

---

## v3.12 — 性能优化与定时任务支持

**更新日期：2026-05-16**

### 性能优化
- Fuse.js 搜索替代后端数据库 like 查询
- SQL 连接池预热机制
- 5分钟连接超时复用

### 新增功能
- 定时任务支持（可通过外部调度器触发）

---

## v3.11 — Edge Function 状态查询与手动更新修复

**更新日期：2026-05-15**

### 问题 1：状态被存储过程覆盖
- `usp_GetPurchasePlanWithFeedback` 有时会自行根据库存计算状态
- 导致与 `Shortage_OrderFeedback` 真实值不一致

**修复**：Edge Function 在获取结果后用直接 SQL 查询真实状态并覆盖

### 问题 2：手动更新状态返回 500 错误
- 调用 `usp_UpdateActualOrderStatus` 存储过程时出错

**修复**：改为直接 SQL UPDATE/INSERT 操作 `Shortage_OrderFeedback` 表

---

## v3.10 — 后台与门店端订货状态统一修复

**更新日期：2026-05-14**

### 问题
后台与门店端订货状态显示不一致

### 修复
统一使用 SQL Server `Shortage_OrderFeedback` 表的真实状态

---

## v3.9 — VBA 功能增强

**更新日期：2026-05-13**

### 新增功能
- 上传订货数量（批量写入 SQL Server）
- 查看订货记录
- 测试连接
- 清除颜色

### 门店端修复
- 订货状态同步修复

---

## v3.8 — 前端优化与拼音搜索完善

**更新日期：2026-05-13**

### 功能优化
- 商品搜索增加拼音码支持（PYZJM）
- 拼音搜索失败时显示友好提示
- 热门搜索请求合并，减少网络请求

---

## v3.7 — 热门搜索与请求优化

**更新日期：2026-05-12**

### 功能变更
- 商品搜索增加热门搜索功能
- 合并热门搜索请求，减少 API 调用
- 优化搜索响应时间

---

## v3.6 — 同步状态查询优化

**更新日期：2026-05-12**

### 功能变更
- 同步状态改查 Supabase 日志表（sync_log_table）
- 实时显示同步进度和结果
- 记录同步时间、操作人、状态

---

## v3.5 — 订单状态反馈功能完善

**更新日期：2026-05-11**

### 新增功能
- 订货状态反馈机制（待处理/已订购/已到货）
- 一键同步 + 自动状态检测
- 员工上报记录完整追踪

### 技术改进
- 新增 `Shortage_OrderFeedback` 表
- Edge Function 新增相关 Action

---

## v3.4 — 员工上报管理功能

**更新日期：2026-05-10**

### 新增功能
- 上报人信息记录（姓名、手机号）
- 员工可查看自己的上报历史
- 管理端可按员工筛选上报记录

### 数据库变更
- `reports` 表新增 `reporter_id`、`reporter_phone`、`reporter_name` 字段

---

## v3.3 — 安全加固与性能优化

**部署日期：2026-05-17**

### 安全机制增强

1. **统一版本号管理**
   - 所有前端文件统一版本号至 v19
   - 解决版本号不一致导致的缓存问题

2. **公共工具模块 (utils.js)**
   - 新增 `static/js/utils.js` 公共模块
   - 统一设备ID生成算法（`getDeviceId`）
   - 统一HTML转义函数（`escapeHtml`、`safeText`、`safeHtml`）
   - 统一错误处理函数（`logError`、`logInfo`）
   - 解决代码重复问题，提升可维护性

3. **XSS防护全面增强**
   - 所有用户输入展示点使用 `safeText()` 包装
   - 覆盖：商品编码、商品名称、规格、厂家、备注等所有动态内容
   - 防止跨站脚本攻击（XSS）

4. **错误处理完善**
   - 所有 async 函数添加 try-catch 包裹
   - 统一使用 `logError()` 记录错误日志
   - 增强 `callEdgeFunction` 函数，添加 `response.ok` 检查

### 性能优化

1. **SQL连接池实现**
   - Edge Function 实现连接池机制（`getPool` / `releasePool`）
   - 最多缓存5个连接，5分钟超时自动关闭
   - 减少数据库连接创建开销，提升响应速度

2. **输入验证增强**
   - 新增 `validateInput()` 函数进行参数校验
   - 所有外部输入进行长度限制和特殊字符过滤
   - 防止SQL注入攻击

### 文件清单

| 文件 | 版本变化 | 变更内容 |
|------|----------|----------|
| `static/js/utils.js` | **新增** | 公共工具模块 |
| `store.html` | v18 → v19 | 引用 utils.js；添加 XSS 防护 |
| `store.js` | v15 → v16 | 使用 safeText()；统一设备ID |
| `admin.html` | v17 → v19 | 引用 utils.js；添加 XSS 防护 |
| `admin.js` | v12 → v13 | 使用 safeText()；统一设备ID |
| `supabase/functions/query-shortage-data/index.ts` | - | 连接池；输入验证 |

---

## v3.2 — 手机端界面全面优化 + PWA 支持

**部署日期：2026-05-17**

### 升级内容

#### 1. PWA 离线支持

- 新增 `manifest.json` 配置文件
- 添加应用图标（icon-192.png / icon-512.png）
- 配置 iOS/Android 全屏运行
- Service Worker 实现离线缓存

#### 2. 手机端界面优化

- 响应式布局优化，手机端显示更友好
- 门店端、管理端适配手机屏幕
- 优化触摸操作体验

#### 3. 设备授权机制

- 员工首次登录需管理员授权设备
- 防止未授权设备访问系统
- 管理员可管理授权设备列表

### 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `manifest.json` | **新增** | PWA 配置 |
| `static/sw.js` | **新增** | Service Worker |
| `static/icon-192.png` | **新增** | PWA 图标（小） |
| `static/icon-512.png` | **新增** | PWA 图标（大） |
| `store.html` | 更新 | 添加 PWA meta 标签 |
| `admin.html` | 更新 | 添加 PWA meta 标签 |
| `login.html` | 更新 | 添加 PWA meta 标签 |

---

## v3.1 — 用户体验优化与批量操作

**部署日期：2026-05-17**

### 升级内容

#### 门店端优化

1. **历史记录筛选**
   - 支持按类型筛选（缺货订购/新品订购）
   - 支持按状态筛选（待处理/已订购/已到货）
   - 支持按时间筛选（最近7天/30天/90天/全部）
   - 加载更多分页功能

2. **搜索结果分页**
   - 默认显示20条结果
   - 「加载更多」按钮分页加载
   - 避免长列表影响性能

3. **订货数量默认值**
   - 查询商品详情后自动填入「建议订货数量」
   - 减少用户手动输入操作
   - 从 `shortage_purchaseplancache` 表获取建议值

#### 管理端优化

4. **批量操作**
   - 复选框多选商品
   - 批量标记「已到货」
   - 全选/取消全选功能
   - 批量操作工具栏

5. **自动刷新功能**
   - 可选刷新间隔（30秒/1分钟/5分钟/10分钟）
   - 状态指示器显示刷新倒计时
   - Tab 切换时自动停止刷新

### 文件清单

| 文件 | 版本 | 变更内容 |
|------|------|----------|
| `store.html` | - | 添加筛选器HTML、加载更多按钮 |
| `store.js` | v15 → v16 | 筛选逻辑、分页逻辑、自动填入建议订货 |
| `admin.html` | - | 添加批量操作工具栏、自动刷新设置HTML |
| `admin.js` | v12 → v13 | 批量选择函数、自动刷新实现 |
| `style.css` | v14 → v15 | 新增 .history-filter-bar、.load-more-container、.batch-toolbar、.auto-refresh-bar 等样式 |
| `supabase/functions/query-shortage-data/index.ts` | - | `get_product_detail` 增加建议订货数量查询 |

---

## v3.0 — 订货状态反馈系统

**部署日期：2026-05-13**

### 新增功能

- 订货状态反馈机制
  - 状态：待处理 → 已订购 → 已到货
- 一键同步采购计划
- 自动检测到货状态
- 员工设备绑定登录（PWA）

### 数据库变更

- 新增 `Shortage_OrderFeedback` 表
- 新增 `sync_log_table` 表
- Edge Function 新增 Action：
  - `get_purchase_plan`
  - `set_actual_order_qty`
  - `manual_update_status`
  - `sync_with_auto_status`

---

## v2.0 — Supabase 云服务架构

**部署日期：2026-05**

### 架构升级

- 从本地 Flask 迁移到 Supabase 云服务
- 实现零运维
- 前端直连 Supabase
- Edge Function 处理业务逻辑

### 技术栈

- 前端：HTML5 + CSS3 + JavaScript
- 认证：Supabase Auth + JWT
- 后端：Supabase Edge Functions (Deno)
- 数据库：Supabase PostgreSQL + SQL Server

---

## v1.0 — 本地 Flask + SQLite 部署

**部署日期：2026-04**

### 初始功能

- 商品搜索（编码/名称/规格/厂家）
- 门店上报缺货/新品
- 管理后台汇总查看
- 基础 UI 优化

### 技术栈

- 后端：Python Flask
- 数据库：SQLite
- 前端：HTML + JavaScript

---

## v0.x — 本地测试版本

**日期：2026-04**

### 初始功能

- 基于 `shortage_tool_deploy` 文件夹中的早期版本
- 使用 `SPFXB_Result` 表（SPFXB 项目派生数据）作为探索性数据源
- 探索性测试，验证业务流程
- 快速原型验证

> **说明**：v0.x 阶段的 `SPFXB_Result` 数据源已废弃，当前版本使用 `Shortage_*` 系列缓存表。

---

## v3.18.7 — 登录页重大修复 + 设备授权增强 + 缓存优化

**部署日期：2026-05-21**

### 🐛 Bug 修复

#### 1. 登录页 JS 语法错误导致全部功能失效（致命）

**问题描述**：门店/员工登录页面账号无法选择、模式切换按钮无效、密码框无响应。

**根因**：`utils.js` 第 7 行已声明 `var SUPABASE_URL`，`login.html` 第 137 行又用 `const SUPABASE_URL` 重复声明，导致 `SyntaxError: Identifier 'SUPABASE_URL' has already been declared`，**整个 JS 脚本中断**，所有功能完全失效。

**修复**：移除 `login.html` 中重复的 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 声明，改为注释说明。

#### 2. 退出登录按钮无响应

**问题**：门店端退出按钮的事件监听器代码缺失（`addEventListener` 开头丢失），点击无反应。

**修复**：`static/js/store.js` → 补充完整的 `logoutBtn.addEventListener('click', ...)` 代码。

#### 3. 重启客户端设备授权超限

**问题**：关闭客户端重新打开后，提示"该门店最多允许 N 台设备"。

**根因**：`electron-main.js` 启动时调用 `session.clearStorageData({ storages: ['localstorage'] })` 清空了 localStorage 中的设备码，每次重启生成新设备码，数据库中的旧记录仍标记为 `is_active: true`，导致超限。

**修复**：
- `electron-main.js` → `clearStorageData` 排除 `localstorage`（只清 `cookies` 和 `cachestorage`）
- `store_login` → 优先匹配当前用户自己的设备记录（退出重登不拦截）
- `authorize_device` → 授权时同时设 `is_active: true`
- `logout_device` → 拒绝时彻底删除该设备+账号所有记录

#### 4. CDN 缓存导致前端更新不生效

**问题**：`_headers` 中 `/*.html` 规则不匹配带 `?v=` 查询参数的 URL，页面被 Cloudflare CDN 缓存。

**修复**：`_headers` → 添加 `/login*` 精确规则，强制 `Cache-Control: no-cache, no-store, must-revalidate, max-age=0`。

### ⚡ 优化增强

#### 5. 设备绑定锁定瞬间生效

**问题**：已授权门店重新登录后，门店选择框需等 2-5 秒（`checkDeviceStores` 异步完成）才锁定，期间显示完整门店列表。

**修复**：`checkDeviceStores` 结果缓存到 `localStorage`，下次打开页面**立即读取缓存锁定门店**（0 毫秒延迟），后台静默刷新。

#### 6. 管理员后台优化

- 豁免账号（`15305479520`、`admin`）不出现在已授权/待授权列表中
- `debug_get_all_authorized` 查询排除管理员和豁免账号

### 🔧 工具优化

#### 7. 一键发布工具 `发布.bat`

合并原来的 3 个工具（`打包门店端.bat`、`推送到GitHub.bat`、`一键部署.bat`）为统一的菜单式工具：

| 选项 | 功能 |
|------|------|
| `[1]` 仅部署网页 | Edge Function + Cloudflare Pages |
| `[2]` 部署 + 打包 | 日常发版用 |
| `[3]` 完整发布 + GitHub | 正式发版用 |
| `[5]` 仅打包客户端 | 只改 electron-main.js 时用 |

### 📁 涉及文件

| 文件 | 变更 |
|------|------|
| `login.html` | 移除重复 `const` 声明；简化为 `fillAccounts()`；缓存设备绑定结果 |
| `static/js/store.js` | 修复退出按钮事件监听器 |
| `electron-main.js` | `clearStorageData` 排除 `localStorage`；去重清理逻辑 |
| `_headers` | 添加 `/login*` 精确禁缓存规则 |
| `supabase/functions/query-shortage-data/index.ts` | 修复 `store_login`、`authorize_device`、`logout_device`、`debug_get_all_authorized` |
| `发布.bat` | 新增统一发布工具 |

### 🚀 功能增强（同日持续迭代）

#### 8. 管理后台状态筛选 + 新状态徽章

**问题描述**：管理后台「缺货订购汇总」页面无法按状态筛选，所有记录混在一起。

**修复方案**：
- `admin.html` → 新增 `statusFilter` 下拉框（全部 / 待处理 / 配货中 / 已订购 / 已到货 / 已完成）
- `static/js/admin.js` → 新增 `applyStatusFilter()` 筛选函数；`getReplenishBadge()` 支持配货中/已完成状态
- `static/css/style.css` → 新增 `.replenish-completed` 深绿加粗样式 + 暗色主题适配

**状态闭环定义**：`待处理 → 已订购 → 配货中（在途>0）→ 已完成（库存达标）`

#### 9. 门店重复上报拦截

**问题描述**：门店可以在短时间内重复上报同一商品，产生无效重复记录。

**修复方案**：`insert_report` Edge Function 新增检测逻辑：
- 同门店 + 同商品编码 + 7 天内 → 拒绝提交并提示
- 返回友好提示：`该商品在 X 天前已上报过，请勿重复提交`

#### 10. 上报自动判断在途状态

**问题描述**：门店上报缺货后，管理员才能手动修改状态为"配货中"，无法自动感知在途。

**修复方案**：
- `insert_report` → 上报时自动查询 SPFXB_Result 在途数量
- 在途 > 0 → 自动设状态为「配货中」
- 无在途 → 保持「待处理」

#### 11. 同步采购计划自动检测配货中 → 已完成

**问题描述**：已订购且有在途的商品，系统只检测"已订购→已到货"，缺少中间的"配货中"状态。

**修复方案**：
- `sql/fix_auto_detect_arrival.sql` → `usp_AutoDetectOrderStatus_Feedback` 改为查 SPFXB_Result（实时数据）
- 新增**两步检测**：
  ① 已订购/配货中 → 已完成（库存 ≥ 标准库存）
  ② 已订购 → 配货中（在途 > 0）
- 需在 SSMS 中执行该 SQL，再点击"同步采购计划"

#### 12. 刷新库存直接调用 SPFXB + 共享时间戳

**问题描述**：门店刷新库存只查 SPFXB_Result 静态数据，数据可能是旧的；刷新后看不到更新时间。

**修复方案**：
- `get_store_inventory` 刷新库存时改为 `EXEC SPFXB @RefreshRanking = 0`（实时从 ZHYYLS 取库存/销售/在途）
- 刷新后将时间戳存入 Supabase `sync_metadata` 表（所有门店共享）
- `store.html` 选项卡行右侧显示：`库存更新时间：🕐 2026/5/22 11:21:12`

#### 13. CORS 子域名白名单

**问题描述**：重新部署后 Cloudflare Pages 会分配新的二级域名（如 `5d25a5d3.wszhyy.pages.dev`），原 CORS 白名单只认 `wszhyy.pages.dev` 导致无法访问。

**修复方案**：CORS 白名单从精确匹配改为正则匹配 `/^https:\/\/[\w-]+\.wszhyy\.pages\.dev$/`，支持所有 `*.wszhyy.pages.dev` 子域名。

#### 14. 商品缓存过滤放宽

**问题描述**：商品 020493 有过销售记录但搜索不到，因 `sync_product_cache` 过滤条件过严（近 2 年销售 + BillType 101-105）。

**修复方案**：放宽过滤条件为近 **1 年**有销售或无库存，移除 BillType 限制，确保所有有效商品可被搜索。

### 📁 文件清单（功能增强部分）

| 文件 | 变更 |
|------|------|
| `supabase/functions/query-shortage-data/index.ts` | CORS regex 匹配；刷新改调 SPFXB；`insert_report` 重复上报拦截+自动在途判断；`sync_product_cache` 放宽过滤 |
| `sql/fix_auto_detect_arrival.sql` | `usp_AutoDetectOrderStatus_Feedback` 改查 SPFXB_Result；配货中→已完成自动检测 |
| `admin.html` | 缺货订购汇总新增 statusFilter 下拉框 |
| `static/js/admin.js` | `applyStatusFilter()`；`getReplenishBadge()` 扩展状态；statuses 数组扩展 |
| `static/css/style.css` | `.replenish-completed` 样式 + 暗色主题适配 |
| `store.html` | 刷新按钮+时间移至选项卡行右侧；新增 `lastRefreshTime` 元素 |
| `static/js/store.js` | 时间格式 `库存更新时间：🕐 yyyy/M/d HH:mm:ss` |
| `README.md` | 更新数据链路、SPFXB、刷新库存、同步采购计划说明 |

---

## v3.18.8 — 订货状态完善 + 上报人管理 + UI优化

**部署日期：2026-05-23**

### 新增功能

#### 1. 新增订货状态「待付款」「厂家断货」
- 用于采购人员手动标记特殊状态
- **待付款**：琥珀色徽章，采购已下单但未付款
- **厂家断货**：红色徽章，厂家无货供应
- 管理员手动标记，存储过程自动检测不会覆盖这两个状态
- 逻辑上「厂家断货」等同于「已完成」，合并到底部已完成折叠区域

#### 2. 门店端上报人下拉框
- 上报按钮前方新增「上报人」下拉选择框，数据来源为管理后台门店员工管理
- **上报人改为必填项**，未选择时报错提示
- 批量导入 20 名门店员工（`sql/batch_add_employees.sql`，虚拟手机号）
- 员工登录限制白名单：仅 `15305479520` 可登录测试，其他仅供上报人名册选择
- `add_employee` 支持手机号留空

#### 3. 需求明细弹窗改版
- 商品信息同行显示：`0011 小儿止咳糖浆(仁和) (100ml | 厂家)`，规格厂家小字灰色
- 改回表格格式：日期 | 门店 | 库存 | 在途 | 需求 | 上报人
- 固定列宽 `table-layout:fixed` 防换行，弹窗宽度 560px

#### 4. 已完成订单折叠区域
- 主表格默认不显示「已完成」和「厂家断货」
- 底部「已完成订单」折叠卡片，默认收起
- `isCompletedStatus()` 辅助函数统一判断
- 筛选"已完成"时，已完成 + 厂家断货合并显示

### 优化修复

#### 5. 排序：缺货汇总按最新上报时间倒序
- 新增 `latest_report_time` 字段，按时间倒序排列

#### 6. 门店ID映射修复
- `15305479520` 手机号登录自动映射为 `wszhyy02`
- 修复上报人下拉框为空、明细弹窗显示手机号的问题

#### 7. 商品查询名称回退
- 服务器名称 → 本地缓存 → 编码，三级回退
- 修复搜索后选择商品不显示信息、历史记录只有编码的问题

#### 8. 门店端历史记录格式优化
- 「时间」→「日期」，只显示日期（悬停显示完整时间）
- 「类型」列居中 55px；「品名」单行不换行，溢出省略号

#### 9. 状态回退Bug修复
- `manual_update_status` 同步更新 Supabase `reports` 表
- 修复管理员改状态后刷新回退到旧状态的问题

#### 10. 管理后台状态下拉框完善
- 筛选+弹窗 dropdown 增至 7 种状态
- 门店端历史记录筛选同步更新
- `data-status` 即时更新，选中即变色

### 涉及文件

| 文件 | 变更 |
|------|------|
| `admin.html` | 状态筛选+弹窗7种状态；明细弹窗改版；已完成折叠区 |
| `admin.js` | `isCompletedStatus()`；statuses数组；badge映射；排序；门店ID映射；状态回退修复 |
| `store.html` | 上报人下拉框；历史记录表头优化；筛选7种状态 |
| `store.js` | 上报人加载+筛选+必填；badge补齐7种；名称回退；日期/品名格式 |
| `style.css` | `replenish-payment`/`replenish-outstock` 徽章+select+暗色主题 |
| `index.ts` | `manual_update_status`同步Supabase；`employee_login`白名单；`add_employee`空手机号 |
| `fix_auto_detect_arrival.sql` | 保护待付款/厂家断货不被自动覆盖 |
| `batch_add_employees.sql` | 20名员工批量添加 |

---

## 项目发展历程

| 版本 | 日期 | 主要内容 |
|------|------|----------|
| v0.x | 2026-04 | 本地测试原型，基于 SPFXB_Result 表 |
| v1.0 | 2026-04 | 本地 Flask+SQLite 部署，核心 UI 优化 |
| v2.0 | 2026-05 | 迁移到 Supabase 云服务，实现零运维 |
| v3.0 | 2026-05-13 | 订货状态反馈系统，员工设备绑定 |
| v3.1 | 2026-05-17 | PWA 离线支持、批量操作、用户体验优化 |
| v3.2 | 2026-05-17 | 手机端界面全面优化、设备授权机制 |
| v3.3 | 2026-05-17 | 安全加固（XSS防护、输入验证）与性能优化（SQL连接池） |
| v3.4 | 2026-05-10 | 员工上报管理功能 |
| v3.5 | 2026-05-11 | 订单状态反馈功能完善 |
| v3.6 | 2026-05-12 | 同步状态查询优化 |
| v3.7 | 2026-05-12 | 热门搜索与请求优化 |
| v3.8 | 2026-05-13 | 前端优化与拼音搜索完善 |
| v3.9 | 2026-05-13 | VBA 功能增强 |
| v3.10 | 2026-05-14 | 统一前后端订货状态 |
| v3.11 | 2026-05-15 | 修复状态查询与手动更新问题 |
| v3.12 | 2026-05-16 | 性能优化（Fuse.js搜索 + 连接池） |
| v3.13 | 2026-05-17 | 登录预加载与缓存策略优化 |
| v3.14 | 2026-05-17 | 门店上报取消功能增强 |
| v3.15 | 2026-05-18 | 修复管理员登录角色识别问题 |
| v3.16 | 2026-05-18 | 修复库存数据不一致、各门店库存弹窗为空 |
| v3.17 | 2026-05-18 | 设备授权机制升级（所有账号需授权、单设备登录） |
| v3.17.1 | 2026-05-18 | 登录页面 UX 优化（密码管理、输入框优化） |
| v3.18.0 | 2026-05-19 | 管理后台增强（修改密码、自动化部署配置） |
| v3.18.1 | 2026-05-19 | 登录模式切换（员工/管理员）、修复自动部署 |
| v3.18.5 | 2026-05-19 | 设备授权优化、启动体验优化、自动更新配置 |
| v3.18.6 | 2026-05-20 | 库存同步机制重构、设备授权增强、各店库存优化 |
| v3.18.8 | 2026-05-23 | 订货状态完善(待付款/厂家断货)、上报人管理、UI优化、历史记录格式 |
| v3.18.7 | 2026-05-21 | 登录页致命 Bug 修复、设备码持久化、缓存优化 |
| v3.19.0 | 2026-05-23~24 | 双表格优化、供货商字段、状态日志、自动更新修复、版本提示条 |
