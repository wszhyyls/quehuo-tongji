# 缺货统计系统 — 完整项目文档

> **适用版本**：v3.20.0 | **更新日期**：2026-05-24  
> **项目名称**：WSZH-ShortageStore | **所属**：微山县众和医药连锁有限公司

---

## ⚡ AI Agent 快速理解（30秒概览）

**这是什么？** 药品连锁门店缺货上报 + 管理端汇总采购系统。10 个门店通过 Electron 客户端上报缺货/新品，管理员查看汇总后采购，数据同步到 SQL Server。

**核心架构**：
```
门店客户端 (Electron/login.html → store.html) 
    ↓ Edge Function (query-shortage-data: 45个action, 3150行)
    ↓ SQL Server RQZT (读写) + ZHYYLS (只读源数据) + Supabase (缓存/认证)
管理后台 (admin.html)
```

**修改文件指南**：
- 改前端 → `login.html` / `store.html` + `static/js/store.js` / `admin.html` + `static/js/admin.js`
- 改样式 → `static/css/style.css`
- 改业务逻辑 → `supabase/functions/query-shortage-data/index.ts`
- 改定时任务 → `supabase/functions/scheduled-task/index.ts`
- 改自动更新 → `supabase/functions/check-update/index.ts` + `electron-main.js`
- 改数据库 → `sql/` 目录脚本 + Supabase SQL Editor

**部署命令**：
```bash
# 部署 Edge Function
npx supabase functions deploy query-shortage-data --project-ref qswpgnnedqvuegwfbprd
# 部署前端
npx wrangler pages deploy . --project-name=wszhyy --branch=main
# 打包客户端
npx electron-builder --win
# 上传 Release
gh release upload v3.19.0 "dist/*.exe" "dist/*.yml" "dist/*.blockmap" --clobber
```

**⚠️ 权限约束**：ZHYYLS 数据库只读，禁止创建索引/修改表；RQZT 可读写；Supabase 完全管理。

---

## 一、项目总览

### 1.1 核心定位

本系统为微山县众和医药连锁有限公司定制的**缺货管理与新品订购平台**，覆盖 10 个门店的日常缺货上报、新品申请、库存查询，以及管理端的统一汇总采购计划。

### 1.2 核心用户角色

| 角色 | 入口 | 权限 |
|------|------|------|
| **门店员工** | `login.html` → 员工登录 → `store.html` | 搜索商品、查看库存、上报缺货/新品、查看上报历史 |
| **门店主账号** | `login.html` → 门店登录 → `store.html` | 同员工，并可代表门店上报 |
| **管理员** | `login.html` → 管理员登录 → `admin.html` | 汇总查看、订货管理、员工管理、设备授权、数据同步 |
| **超级管理员** | 同管理员 | 额外拥有子账号管理权限 |

### 1.3 核心业务流程

```
门店端                                  管理端
  │                                       │
  ├─ 登录（设备授权）                      │
  ├─ 搜索商品（Fuse.js 毫秒级）            │
  ├─ 查看本店库存/销量/标准库存             │
  ├─ 查看各店库存（可调拨计算）             │
  ├─ 上报缺货/新品 ──────────────────→ 汇总缺货列表
  │                                       ├─ 查看各门店缺货汇总
  │                                       ├─ 订货管理（设置实际订货数量）
  │                                       ├─ 修改补货状态（待处理→已订购→已到货）
  │                                       ├─ 同步采购计划
  │                                       └─ Excel VBA 批量回写
  └─ 查看上报历史 + 审批通知     │
```

### 1.4 已上线功能

| 模块 | 功能 |
|------|------|
| 登录鉴权 | 门店/员工/管理员三种模式、设备授权、设备数量限制、记住密码 |
| 商品搜索 | Fuse.js 全文搜索、拼音码精确匹配、商品编码/名称/规格模糊匹配 |
| 库存查询 | 本店库存/销量/标准库存、各店库存+可调拨数量、刷新库存（强制同步） |
| 缺货上报 | 缺货订购（含在途提示）、新品订购、紧急程度、建议订货量 |
| 管理汇总 | 缺货汇总表（固定表头）、新品汇总表（含审批/驳回）、需求明细（含上报人）、批量标记状态、操作日志记录 |
| 订货管理 | 设置实际订货数量、手动修改补货状态、自动检测状态变化 |
| 设备授权 | 待授权列表、已授权列表、授权/拒绝/撤销、冲突提示、设备锁定 |
| 数据同步 | 同步采购计划（刷新库存/在途/销量/标准库存/门店计划+自动检测状态变更）、商品缓存定时刷新、Supabase 增量 UPSERT |
| 员工管理 | 添加/停用员工、修改密码、解绑设备 |
| 子账号管理 | 添加/编辑/停用/删除管理员子账号、细粒度权限控制 |
| 桌面客户端 | Electron 打包、自动更新检测 |
| 门店公告栏 | 自定义公告展示、可关闭、自动从缓存/服务端加载 |
| 到货通知 | 门店端登录时自动检测到货商品，绿色横幅提示 |
| 新品审批 | 管理员审批/驳回新品订购，门店端登录时自动收到审批结果通知 |

### 1.5 支持门店

| 编号 | 门店 ID | 门店名称 | 设备上限 |
|------|---------|----------|:--:|
| 01 | `wszhyy02` | 02第二药店 | 2台 |
| 02 | `wszhyy03` | 03第三药店 | 1台 |
| 03 | `wszhyy04` | 04第四药店 | 1台 |
| 04 | `wszhyy06` | 06常口店 | 1台 |
| 05 | `wszhyy08` | 08第八药店 | 1台 |
| 06 | `wszhyy09` | 09第九药店 | 1台 |
| 07 | `wszhyy14` | 14第十四药店 | 1台 |
| 08 | `wszhyy16` | 16凤凰山药店 | 1台 |
| 09 | `wszhyy17` | 17益丰店 | 1台 |
| 10 | `wszhyy21` | 21富源店 | 1台 |

### 1.6 例外账号

| 账号 | 说明 |
|------|------|
| `admin` | 超级管理员，不受设备授权限制 |
| `15305479520` | 02第二药店管理员账号（映射到 02第二药店） |

### 1.7 数据架构与性能优化（2026-05-24）

```
┌─────────────┐    只读查询     ┌──────────────┐    读写操作    ┌──────────────────┐
│  ZHYYLS     │ ←────────────→ │    RQZT      │ ←───────────→ │  Supabase (云)    │
│  源系统数据库 │  跨库查询      │  缺货系统数据库 │  Edge Function │  缓存 + 认证      │
│  (只读)      │                │  (可读写)      │               │                  │
└─────────────┘                └──────────────┘               └──────────────────┘
                                      │                              │
                           ┌──────────┴──────────┐          ┌───────┴────────┐
                           │ ProductCache_RQZT  │          │ product_cache  │
                           │ (商品缓存, 200ms)   │          │ shortage_store │
                           │ 索引: pinyin + name │          │ stock_cache    │
                           └────────────────────┘          └────────────────┘
```

| 优化项 | 说明 | 效果 |
|--------|------|------|
| **RQZT 商品缓存表** | `ProductCache_RQZT` 本地缓存商品基础信息，避免跨库全表扫描 | 3-5s → 200ms |
| **定时自动刷新** | Supabase pg_cron 每天 3:00 自动执行 `usp_Sync_ProductCache_RQZT` | 零人工维护 |
| **登录页更新提示** | 橙色横幅自动检测版本并提示下载 | 旧客户端无需重装 |
| **自动更新修复** | `checkForUpdates` 动态获取下载 URL，旧版 Release 注入新版文件 | 全门店自动发现更新 |
| **退出确认弹窗** | 关闭客户端弹出确认对话框 | 防误关闭 |

### 1.8 数据库访问权限

| 数据库 | 权限 | 用途 |
|--------|------|------|
| ZHYYLS | **只读** | 源数据查询（商品、库存、销售记录），禁止任何修改 |
| RQZT | **读写** | 缺货系统业务数据、缓存表、存储过程 |
| Supabase | **完全管理** | 云端缓存、用户认证、Edge Function |

---

## 二、系统地址

### 2.1 正式环境

| 类型 | 地址 |
|------|------|
| 登录页 | `https://wszhyy.pages.dev/login.html` |
| 门店端 | `https://wszhyy.pages.dev/store.html` |
| 管理后台 | `https://wszhyy.pages.dev/admin.html` |

### 2.2 后端服务

| 服务 | 地址 |
|------|------|
| Supabase Dashboard | `https://supabase.com/dashboard/project/qswpgnnedqvuegwfbprd` |
| Edge Function API | `https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data` |
| Cloudflare Pages | `https://wszhyy.pages.dev`（项目名 `wszhyy`） |

---

## 三、技术架构

### 3.1 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                    用户终端（浏览器 / Electron 桌面客户端）            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                          │
│  │ 门店端    │  │ 管理后台  │  │ 桌面客户端│                          │
│  │ store    │  │ admin    │  │ Electron │                          │
│  │ v3.19.0  │  │ v3.19.0  │  │ v3.19.0  │                          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                          │
└───────┼─────────────┼─────────────┼────────────────────────────────┘
        └─────────────┼─────────────┘
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Cloudflare Pages（全球 CDN 加速）                       │
│  login.html  store.html  admin.html  static/  manifest.json         │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Supabase（认证 + 缓存 + 计算）                     │
│  ┌────────────┐  ┌──────────────────────┐  ┌─────────────────┐     │
│  │ Auth (JWT) │  │ Edge Functions (Deno)│  │  PostgreSQL     │     │
│  │ 用户认证    │  │ query-shortage-data  │  │  product_cache  │     │
│  │ 设备授权    │  │ check-update         │  │  shortage_*     │     │
│  │ 权限管理    │  │ scheduled-task       │  │  store_*        │     │
│  └────────────┘  └──────────┬───────────┘  │  reports        │     │
│                              │              │  sync_log_*     │     │
└──────────────────────────────┼──────────────┴─────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  SQL Server（业务数据源）                             │
│  服务器：(内网地址)  端口：1290  账套：RQZT                          │
│  ┌──────────────────┐  ┌───────────────────┐                       │
│  │ RQZT.dbo.        │  │ ZHYYLS.dbo.       │                       │
│  │ SPFXB_Result     │  │ Vptype（商品主表） │                       │
│  │ Shortage_*       │  │ cstype（生产厂商） │                       │
│  │ usp_* 存储过程    │  │ Vsalebill（销售）  │                       │
│  └──────────────────┘  │ GoodsStocks（库存）│                       │
│                         └───────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 技术栈

| 层级 | 技术 | 版本/说明 |
|------|------|-----------|
| **前端** | HTML5 + CSS3 + JavaScript (ES6) | 纯原生，零框架依赖 |
| **CSS** | 自定义主题（紫韵/海蓝/翠绿/暗夜/暖橙） | 5套主题 |
| **搜索** | Fuse.js | v6+ CDN 引入，前端内存搜索 |
| **前端托管** | Cloudflare Pages | 项目名 `wszhyy`，全球 CDN |
| **后端计算** | Supabase Edge Functions (Deno) | `query-shortage-data` 主函数 |
| **后端依赖** | `mssql@9`（SQL Server 连接） | `@supabase/supabase-js@2` |
| **认证** | Supabase Auth (JWT) | 邮箱注册，设备绑定 |
| **缓存数据库** | Supabase PostgreSQL | 商品缓存、库存缓存、日志 |
| **业务数据库** | SQL Server | RQZT 账套，存储过程 |
| **桌面客户端** | Electron | Windows 打包 |
| **VBA** | Excel VBA + ADODB | 批量回写订货数量 |

### 3.3 关键设计决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| 数据存储 | SQL Server 不迁移 | 业务数据量大，保持实时性 |
| 前端托管 | Cloudflare Pages | 免费 + CDN 优秀 |
| 认证 | Supabase Auth + 设备绑定 | 安全 + 多设备管理 |
| 移动端 | PWA | 零开发成本 |
| 商品搜索 | Fuse.js 前端内存搜索 | 毫秒级，无网络延迟 |
| 库存加载 | Supabase 缓存优先 → SQL Server 降级 | 速度 + 可靠性 |
| 后端计算 | Edge Functions (Deno) | 无服务器，按需扩展 |

---

## 四、数据流向

### 4.1 完整数据链路

```
ZHYYLS 实时数据库（药房 ERP 系统）
  │  ┌ Zhyyls.dbo.Vbillindex, Vsalebill    → 90天/180天销售明细
  │  ├ Zhyyls.dbo.GoodsStocks               → 门店实时库存
  │  ├ Zhyyls.dbo.Vptype, cstype            → 商品主表、生产厂商
  │  └ Zhyyls.dbo.Gp_SendDoing              → 配送在途数量
  │
  ↓ SPFXB 存储过程（系统内调用 + Excel VBA 均可用）
  │  ┌ @RefreshRanking = 1：全量刷新（重算排名/标记/标准库存）— 仅 Excel VBA
  │  └ @RefreshRanking = 0：数据刷新（仅更新销售/库存/在途）— 系统+Excel 均可
  │
RQZT.dbo.SPFXB_Result（核心缓存表 → 网页直读）
  │
  ├──→ 门店「刷新库存」→ SPFXB @RefreshRanking=0 → 查 SPFXB_Result（实时，5-15s）
  │     注：SPFXB 从 ZHYYLS 实时取库存/销售/在途，写入 SPFXB_Result
  │
  ├──→ 定时任务（每30分钟）→ usp_Sync_AllShortageCache → Supabase shortage_storestock_cache
  │     用途：预热缓存，门店打开页面即显示（50ms）
  │
  └──→ 管理员「同步采购计划」→ usp_Sync_AllShortageCache → usp_AutoDetectOrderStatus
         + 同步到 Supabase

ZHYYLS → SPFXB 刷新：    ✅ 门店点击「刷新库存」→ 自动调用 @RefreshRanking=0（实时） + Excel VBA @RefreshRanking=1（全量）
SPFXB_Result → Supabase： ✅ 每30分钟自动同步 + 管理员同步采购计划时同步

### 4.2 「刷新库存」按钮（v3.18.7 优化）

```
门店点击「刷新库存」
  ↓
Edge Function 调用 EXEC SPFXB @RefreshRanking = 0
  ↓ 5-15s（从 ZHYYLS 实时取库存/销售/在途）
SPFXB_Result 更新为最新
  ↓
返回当前门店数据 + last_refresh 时间戳
  ↓
门店页面显示：库存更新时间：🕐 2026/5/22 11:21:12
```

**时间提示规则：**
- 存 Supabase `sync_metadata` 表（所有门店共享）
- 任一门店刷新 → 时间同步更新 → 其他门店打开也看到这个时间
- 门店据此判断是否需要再刷一次

### 4.3 「同步采购计划」按钮（管理员后台）

```
管理员点击「同步采购计划」
  ↓
① EXEC usp_Sync_AllShortageCache    → 搬运 SPFXB_Result → Supabase缓存
② EXEC usp_AutoDetectOrderStatus_Feedback → 自动检测已订购商品是否到货
③ 同步到 Supabase shortage_storestock_cache
```

| 刷新内容 | 说明 |
|---------|------|
| Supabase 缓存 | SPFXB_Result → shortage_storestock_cache |
| 订货状态 | 自动检测：已订购且库存已补足 → 标记「已到货」|
| 缺货汇总 | 更新管理后台缺货/新品列表展示 |

### 4.4 关键理解

| 问题 | 答案 |
|------|------|
| 30分钟定时任务刷新的是源数据吗？ | ❌ 否。它只从 SPFXB_Result 同步到 Supabase 缓存，不会更新 SPFXB_Result 本身 |
| 真正让数据「变新」的是什么？ | 门店点击「刷新库存」→ Edge Function 自动调用 `SPFXB @RefreshRanking=0`，从 ZHYYLS 实时取库存/销售/在途并写入 SPFXB_Result |
| 门店刷新库存拿到的是最新数据吗？ | ✅ 是（系统内调用 SPFXB 从 ZHYYLS 实时获取，不需要 Excel VBA） |
| SPFXB_Result 能自动更新吗？ | ✅ 能（门店刷新库存时自动触发增量刷新；管理端同步时也可触发） |
| 还需要 Excel VBA 吗？ | 仅 @RefreshRanking=1（全量刷新排名）需要 VBA；@RefreshRanking=0（数据刷新）系统已自动执行 |

### 4.5 门店端数据流

```
登录 → 设备授权检查
  ↓
预加载：商品列表（永久缓存） + 本店库存（10分钟缓存 → 服务器覆盖）
  ↓
搜索商品 → Fuse.js 内存搜索 → 未命中 → Edge Function → SQL Server
  ↓
选择商品 → 从内存读取（秒速）→ API 补充各店库存
  ↓
查看各店库存 → 可调拨 = 库存 − 标准库存（正数）
  ↓
上报缺货/新品 → Edge Function → Supabase reports 表
  ↓
查看历史 → Supabase reports + SQL Server 补货状态
```

### 4.6 管理端数据流

```
登录 → 角色+权限识别
  ↓
缺货汇总 → 合并 reports + 采购计划(SPFXB_Result)
  ↓
订货管理 → 设置订货数量 → SQL Server Shortage_OrderFeedback
  ↓
状态修改 → 手动/自动检测 → SQL Server
  ↓
同步采购计划 → usp_Sync_AllShortageCache → Supabase 缓存
              → usp_AutoDetectOrderStatus_Feedback → 自动检测
              → 同步到 Supabase shortage_storestock_cache
```

---

## 五、数据库设计

### 5.1 Supabase PostgreSQL 表

#### `product_cache` 商品缓存表

| 字段 | 类型 | 说明 |
|------|------|------|
| `product_code` | TEXT | 商品编码（USERCODE，如 0002100277） |
| `product_name` | TEXT | 商品名称 |
| `product_spec` | TEXT | 规格 |
| `manufacturer` | TEXT | 生产企业 |
| `pinyin_code` | TEXT | 拼音助记码（小写） |

> 数据来源：管理员「同步采购计划」时从 `ZHYYLS.dbo.Vptype` + `cstype` 同步

#### `shortage_storestock_cache` 门店库存缓存表

| 字段 | 类型 | 说明 |
|------|------|------|
| `product_code` | TEXT | 商品编码 |
| `store_name` | TEXT | 门店名称 |
| `store_stock` | INT | 门店库存数量 |
| `in_transit` | INT | 在途数量 |
| `store_total` | INT | 门店库存汇总 |
| `dc_stock` | INT | 配送中心库存 |
| `sales_30days` | INT | 前30天销量 |
| `sales_90days` | INT | 前90天销量 |
| `monthly_sales` | INT | 月均销量 |
| `standard_stock` | INT | 标准库存 |
| `store_plan` | INT | 门店计划 |
| `last_updated` | TIMESTAMPTZ | 最后更新时间 |

> 数据来源：管理员「同步采购计划」时从 `SPFXB_Result` 全量同步

#### `reports` 上报记录表

| 字段 | 类型 | 说明 |
|------|------|------|
| `store_id` | TEXT | 门店编码 |
| `store_name` | TEXT | 门店名称 |
| `order_type` | TEXT | 类型（缺货订购/新品订购） |
| `product_code` | TEXT | 商品编码 |
| `product_name` | TEXT | 商品名称 |
| `demand_quantity` | INT | 需求数量 |
| `urgency_level` | TEXT | 紧急程度 |
| `replenish_status` | TEXT | 补货状态（从 SQL Server 同步） |
| `reporter_id/phone/name` | TEXT | 上报人信息 |
| `created_at` | TIMESTAMPTZ | 创建时间 |

#### `store_employees` 员工表

| 字段 | 类型 | 说明 |
|------|------|------|
| `phone` | TEXT | 手机号（唯一） |
| `name` | TEXT | 姓名 |
| `store_id` | TEXT | 所属门店 |
| `store_name` | TEXT | 门店名称 |
| `password` | TEXT | 密码（加密存储，默认值由环境变量配置） |
| `is_active` | BOOLEAN | 是否启用 |

#### `store_authorized_devices` 设备授权表

| 字段 | 类型 | 说明 |
|------|------|------|
| `device_id` | TEXT | 设备码（`DEV_v2_XXXXXXXX`） |
| `username` | TEXT | 门店账号 |
| `is_authorized` | BOOLEAN | 是否已授权 |
| `is_active` | BOOLEAN | 是否活跃 |
| `authorized_at` | TIMESTAMPTZ | 授权时间 |
| `last_login_at` | TIMESTAMPTZ | 最后登录时间 |
| `last_logout_at` | TIMESTAMPTZ | 最后退出时间 |

#### `admin_users` 管理员子账号表

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | UUID | Auth 用户 ID |
| `username` | TEXT | 登录账号 |
| `name` | TEXT | 显示名称 |
| `role` | TEXT | 角色（super_admin/admin/viewer） |
| `permissions` | JSONB | 权限配置 |
| `is_active` | BOOLEAN | 是否启用 |

#### 其他 Supabase 表

| 表名 | 用途 |
|------|------|
| `sync_log_table` | 同步操作日志 + 管理员操作日志 |
| `sync_metadata` | 同步元数据（最后同步时间） |
| `store_config` | 门店配置表（替代硬编码，预留） |
| `login_fail_log` | 登录失败记录（持久化防刷） |
| `report_approvals` | 新品审批回复表（已审批/已驳回+原因） |
| `status_changelog` | 状态变更日志 |
| `device_bindings` | 员工设备绑定（旧版，逐步废弃） |

### 5.2 SQL Server 表（RQZT 账套）

| 表名 | 用途 |
|------|------|
| `SPFXB_Result` | 库存/销量/标准库存汇总表（核心数据源） |
| `Shortage_OrderFeedback` | 订货状态反馈表（实际订货数量、补货状态、操作人） |
| `Shortage_PurchasePlanCache` | 采购计划缓存 |
| `sys_diagrams` | 系统图表 |

### 5.3 SQL Server 存储过程

| 存储过程 | 数据库 | 用途 | 调用方式 |
|------|------|------|------|
| **`SPFXB`** | RQZT | **核心**：从 ZHYYLS 实时表取数 → 写入 SPFXB_Result。@RefreshRanking=1 全量(含排名)，=0 增量 | 系统内调用 + Excel VBA 均可 |
| `SPFXB_RefreshDerived` | RQZT | 刷新派生字段（标准差、安全库存、门店计划） | 确认值更新后触发 |
| `usp_Sync_AllShortageCache` | RQZT | 调度器：依次调用3个子过程（搬运数据，不刷新源） | 定时任务/管理员同步 |
| `usp_Sync_ShortageStoreStockCache` | RQZT | 子过程1：只统计行数（实际无写入逻辑） | 被父过程调用 |
| `usp_Sync_ShortageProductCache` | RQZT | 子过程2：从缓存表去重商品数 | 被父过程调用 |
| `usp_Sync_ShortagePurchasePlanCache` | RQZT | 子过程3：汇总缺货商品到采购计划缓存 | 被父过程调用 |
| `usp_GetPurchasePlan` | RQZT | 查询采购计划（含订货反馈） | VBA 生成采购计划 |
| `usp_GetPurchasePlanWithFeedback` | RQZT | 采购计划查询（含订货反馈状态） | Edge Function |
| `usp_UpdateActualOrder` | RQZT | 写入实际订货数量 → 自动改状态为"已订购" | VBA 上传 / Edge Function |
| `usp_AutoDetectOrderStatus_Feedback` | RQZT | 自动检测已订购商品是否到货（基于 SPFXB_Result 实时库存） | 同步采购计划时触发 |
| `usp_UpdateActualOrderStatus` | RQZT | 管理员手动修改补货状态（待处理/已订购/已到货） | 管理后台 |
| `Gp_SendDoing` | ZHYYLS | 查询配送在途数据 | 被 SPFXB 调用 |

### 5.4 Excel VBA 按钮功能

> Excel 文件：商品分析表 SPFXB（通过 ADODB 直连 SQL Server）

| 按钮 | 调用 | 作用 | 耗时 |
|------|------|------|:--:|
| **全量刷新** | `SPFXB @RefreshRanking=1` | 从 ZHYYLS 实时取销售/库存/在途 → 重新计算排名/标记/标准库存 → 写入 SPFXB_Result | 10-20s |
| **数据刷新** | `SPFXB @RefreshRanking=0` | 从 ZHYYLS 实时更新销售/库存/在途（不改排名和标记）→ 保留手工确认值 | 5-15s |
| **手工确认** | `UPDATE SPFXB_Result` | 将 Excel 修改的「标准库存数量确认」写入数据库 → 重新计算派生字段 | 1-3s |
| **导入门店确认** | `UPDATE + SPFXB_RefreshDerived` | 批量导入门店回传的确认文件，差值>50 弹窗提醒 | — |
| **重置确认值** | `UPDATE 确认值 = 标准值` | 所有「标准库存数量确认」重置为系统自动计算值 | 2-5s |
| **生成采购计划** | `usp_GetPurchasePlan` | 从 SPFXB_Result 汇总缺货商品 → 写入 Excel「采购计划」工作表 | — |
| **上传订货数量** | `usp_UpdateActualOrder` | 读取采购计划工作表的实际订货列 → 逐行调用存储过程回写数据库 | — |
| **拆分导出** | 纯 VBA | 按门店拆分标准库存表 → 排除敏感字段 → 生成 .xlsx（供门店确认） | 15-30s |

### 5.5 VBA 按钮使用顺序

```
① 全量刷新  →  ② 手工确认（调整标准库存）  →  ③ 生成采购计划
                                                    ↓
    ④ 拆分导出（分发给门店）                        ⑤ 上传订货数量
    
    ↻ 每天重复：数据刷新（增量，保留排名和确认值）
```

---

## 六、后端设计与实现

### 6.1 Edge Functions 清单

| 函数 | 路径 | 用途 |
|------|------|------|
| `query-shortage-data` | `supabase/functions/query-shortage-data/index.ts` | **主函数**，50 个 action，处理所有业务逻辑 |
| `check-update` | `supabase/functions/check-update/` | 版本检查（返回最新版本号） |
| `scheduled-task` | `supabase/functions/scheduled-task/` | 定时任务（商品同步、健康检查） |

### 6.2 query-shortage-data Action 清单

#### 商品数据

| Action | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `search_product` | `keyword` | 商品数组 | 拼音码精确+模糊匹配，Supabase product_cache |
| `get_all_products` | 无 | 商品数组 | 全量从 RQZT dbo.ProductCache_RQZT 缓存表获取（200ms） |
| `check_products_update` | 无 | `{product_count}` | 检测商品数量变化 |

#### 库存查询

| Action | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `get_store_inventory` | `store_name`, `force_refresh`, `sync_first` | 库存记录数组 | 预加载本店全量库存（Supabase→SQL Server降级） |
| `get_product_detail` | `product_code`, `store_name`, `force_refresh` | 各门店库存 | 单商品全门店数据 |

#### 采购计划 & 订货

| Action | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `get_purchase_plan` | `keyword`, `status_filter` | 采购计划列表 | 调用 usp_GetPurchasePlanWithFeedback |
| `set_actual_order_qty` | `product_code`, `actual_qty`, `operator` | 更新结果 | 自动改状态为"已订购" |
| `manual_update_status` | `product_code`, `target_status`, `operator` | 更新结果 | 手动修改补货状态 |
| `auto_detect_status` | 无 | 检测结果 | 自动检测所有商品补货状态变化 |

#### 数据同步

| Action | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `sync_product_cache` | 无 | `{synced: N}` | 同步商品数据到 Supabase product_cache |
| `sync_cache` | 无 | 存储过程输出 | 标准同步 SPFXB_Result |
| `sync_with_auto_status` | 无 | `{success, supabase_synced}` | **一键**：同步+状态检测+更新 Supabase 库存缓存 |
| `sync_inventory_incremental` | `since?` | `{synced: N}` | 增量同步库存到 Supabase |
| `sync_inventory_full` | 无 | `{synced: N}` | 全量同步库存到 Supabase |

#### 认证 & 设备授权

| Action | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `store_login` | `username`, `password`, `device_id` | `{user, session}` | 门店/管理员登录（含设备授权检查、登录防刷） |
| `employee_login` | `phone`, `password`, `device_id` | `{employee}` | 员工登录 |
| `logout_device` | `target_type`, `target_id`, `device_id` | `{logged_out}` | 退出（不取消授权） |
| `authorize_device` | `device_id`, `target_type`, `target_id`, `authorize` | `{success}` | 管理员授权/拒绝设备 |
| `revoke_device` | `device_id`, `target_type`, `target_id` | `{revoked}` | 撤销设备授权 |
| `get_pending_devices` | 无 | `{store_devices, employee_devices}` | 待授权列表（含冲突信息） |
| `get_authorized_devices` | `target_type`, `target_id` | 设备数组 | 已授权设备 |
| `check_device_stores` | `device_id` | `{stores}` | 设备已绑定的门店列表 |
| `clear_all_device_auth` | 无 | `{cleared, device_count}` | 清除所有授权 |
| `debug_get_all_authorized` | 无 | 设备数组 | 调试：所有已授权设备 |
| `batch_update_status` | `product_codes`, `target_status`, `operator` | `{success_count, fail_count}` | 批量标记补货状态（N→1请求） |
| `get_approvals` | 无 | 审批映射 | 获取所有新品审批记录 |
| `approve_report` | `product_code`, `status`, `reason`, `operator` | 审批结果 | 审批/驳回新品 |
| `vba_sync` | 无 | `{synced_count}` | VBA回写后自动触发状态同步 |
| `get_summary` | 无 | `{reports, plan, supplierLookup}` | 复合汇总（reports+plan合并为1次请求） |
| `log_admin_action` | `user`, `action`, `detail` | `{success}` | 管理员操作日志记录 |

#### 上报 & 员工管理

| Action | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `get_reports` | 无 | 上报数组 | 获取所有上报记录 |
| `insert_report` | 上报对象 | `{inserted}` | 门店上报缺货/新品 |
| `get_my_reports` | `store_id` | 上报数组（含状态） | 门店自己的上报历史 |
| `list_employees` | `store_id?` | 员工数组 | 员工列表 |
| `add_employee` | `phone`, `name`, `store_id`, `store_name` | 新员工 | 添加员工 |
| `toggle_employee` | `id`, `is_active` | 更新结果 | 启用/停用员工 |
| `update_employee_password` | `id`, `new_password` | `{success}` | 修改密码（同步 Auth） |
| `reset_employee_password` | `id` | `{success}` | 重置为默认密码 |

#### 管理功能

| Action | 输入 | 输出 | 说明 |
|--------|------|------|------|
| `list_stores` | 无 | 门店数组 | 门店列表（含登录时间） |
| `get_sync_log` | `Top` | 日志数组 | 同步操作日志 |
| `get_audit_log` | `limit` | 日志数组 | 操作审计日志 |
| `list_admin_users` | 无 | 管理员数组 | 子账号列表 |
| `add_admin_user` | `username`, `password`, `name`, `role`, `permissions` | 新管理员 | 创建子账号 |
| `update_admin_user` | `id`, `name`, `role`, `permissions` | 更新结果 | 编辑子账号 |
| `toggle_admin_user` | `id`, `is_active` | 更新结果 | 启用/停用 |
| `delete_admin_user` | `id` | `{success}` | 删除子账号 |

### 6.3 认证逻辑

1. **门店登录**（`store_login`）：
   - Supabase Auth 邮箱登录（`username@wszh.com` + 密码）
   - 查询 `admin_users` 表确认角色
   - 非管理员账号：设备授权检查 + 设备数量限制
2. **员工登录**（`employee_login`）：手机号 + 密码 + 设备绑定
3. **设备授权流程**：新设备创建待授权记录 → 管理员审批 → 再次登录自动通过
4. **设备锁定**：授权后同一设备再次登录，门店下拉自动锁死

### 6.4 安全机制

| 措施 | 实现 |
|------|------|
| XSS 防护 | `safeText()` / `escapeHtml()` 转义所有用户输入 |
| SQL 注入防护 | `validateInput()` 长度限制 + 特殊字符过滤 |
| 设备授权 | 门店首次登录需管理员授权；退出不取消授权 |
| 设备数量限制 | 02店2台，其余1台，超限拒绝 |
| 设备指纹 v2 | 硬件特征 + 随机数 + 时间戳生成唯一 `DEV_v2_XXXXXXXX` |
| 去重保护 | 同设备同账号多次登录只保留一条待授权记录 |
| JWT 认证 | Supabase JWT Token，所有 API 请求需 Bearer Token |
| 权限控制 | 基于 role + permissions JSONB 的细粒度权限 |
| 错误提示通俗化 | `friendlyError()` 自动将技术错误转为中文提示 |
| SQL 连接重试 | `getPool()` 3次重试（间隔1s/2s），解决偶发断连 |

### 6.5 性能优化措施

| 措施 | 说明 |
|------|------|
| 初始化并行加载 | 商品列表和库存数据 `Promise.all` 并行加载，减少 40% 等待时间 |
| 缓存优先初始化 | 有 localStorage 缓存时直接显示界面（0ms），后台静默更新 |
| 按钮防抖 | `debounceBtn()` 500ms 防抖，防止重复点击导致多重请求 |
| 搜索防抖+取消 | 250ms 防抖 + AbortController 取消旧请求，减少 50% 无效请求 |
| 批量授权 | `batch_authorize` 端点 + 「一键授权全部」按钮 |
| 批量标记 | `batch_update_status` N 次请求 → 1 次请求，耗时减少 90% |
| 请求合并 | `get_summary` 合并 reports + plan 为 1 次请求，响应快 40% |
| 分页查询 | `get_purchase_plan` 支持分页参数 page/pageSize |
| 历史缓存 | 上报历史 30 秒内存缓存，切 Tab 不重复请求 |
| 定时自动同步 | `scheduled-task` 函数支持自动同步 SPFXB_Result + Supabase 缓存 |
| UPSERT 替代 DELETE+INSERT | 商品缓存同步消除数据空窗期 |
| 数据库索引 | 6 个关键索引加速设备查询、库存查询、历史查询、审批查询 |
| 加载状态可视化 | 按钮 loading 旋转动画 + 成功变绿提示 |
| 请求防重 | `isLoadingSummary` 锁防止并发重复请求 |
| Edge Function 保活 | Keep-Warm 每 5 分钟预热，消除冷启动延迟 |
| 网络重试 | 网络错误自动重试 2 次（间隔 1s/2s） |
| 全局错误边界 | `window.onerror` 捕获未处理异常，不白屏 |
| 错误通俗化 | `friendlyErrorClient` 技术错误 → 中文提示二次过滤 |

### 6.6 数据库优化

```sql
-- 已建索引（sql/optimization_v3.19.0.sql）
idx_devices_device_username   -- store_authorized_devices 联合索引
idx_devices_auth_status       -- store_authorized_devices 授权状态查询
idx_stock_store_product       -- shortage_storestock_cache 查询加速
idx_reports_store_created     -- reports 历史查询加速（store_id + created_at DESC）
idx_reports_product_store     -- reports 按商品+门店查询
idx_product_cache_pinyin      -- product_cache 拼音码搜索加速
idx_product_cache_code        -- product_cache 编码搜索加速
idx_login_fail_id_time        -- login_fail_log 登录防刷查询
idx_approvals_report          -- report_approvals 审批查询
idx_approvals_product         -- report_approvals 商品审批唯一索引

-- 门店配置表（替代硬编码，预留）
CREATE TABLE store_config (
  store_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  device_limit INT DEFAULT 1,
  is_active BOOLEAN DEFAULT true
);
```

---

## 七、前端设计与实现

### 7.1 页面清单

| 页面 | 文件 | 功能 |
|------|------|------|
| 登录页 | `login.html` | 员工/门店/管理员三种模式、设备锁、记住密码 |
| 门店端 | `store.html` | 商品搜索、库存查询、缺货/新品上报、历史记录 |
| 管理后台 | `admin.html` | 缺货汇总、新品汇总、订货管理、员工管理、设备授权、门店管理、操作日志、子账号管理 |
| 入口页 | `index.html` | 自动跳转到 login.html |

### 7.2 JavaScript 模块

| 模块 | 说明 |
|------|------|
| `utils.js` | 设备指纹 v2、XSS 防护（safeText/escapeHtml）、格式化函数、日志函数 |
| `store.js` | 门店端完整业务逻辑（预加载、搜索、库存、上报、历史） |
| `admin.js` | 管理后台完整业务逻辑（汇总、订货、员工、设备、同步） |
| `fuse.min.js` | Fuse.js 模糊搜索库（CDN 引入） |
| `sw.js` | PWA Service Worker |

### 7.3 门店端核心逻辑

```
initializeApp()
  ├─ restoreProductCache()       // localStorage 永久缓存
  ├─ checkProductsUpdate()       // 检测新品
  ├─ loadAllProducts()           // 首次从 SQL Server 加载
  ├─ restoreStoreInventoryCache() // localStorage 10分钟缓存
  ├─ preloadStoreInventory()     // 从 Supabase 缓存加载
  │   └─ storeInventoryMap{}     // 内存 Map，按商品编码索引
  │
searchProducts(keyword)
  ├─ searchLocal() → Fuse.js
  ├─ 未命中 → Edge Function 'search_product'
  │
queryProductByCode(code, forceRefresh)
  ├─ !forceRefresh → storeInventoryMap[code]（秒速）
  ├─ forceRefresh → Edge Function 'get_product_detail'（SQL Server）
  │
刷新库存按钮
  ├─ preloadStoreInventory(true, true)  // force_refresh + sync_first
  │   ├─ EXEC SPFXB @RefreshRanking=0（增量刷新 SPFXB_Result）
  │   └─ 从 SQL Server SPFXB_Result 查询最新数据
  │
各店库存弹窗
  ├─ get_product_detail（所有门店该商品数据）
  └─ 可调拨 = max(0, 库存 − 标准库存)，排除本店
```

### 7.4 管理后台权限

| 权限键 | 说明 |
|--------|------|
| `view_summary` | 查看缺货汇总 |
| `edit_status` | 修改补货状态 |
| `manage_order` | 管理订货数量 |
| `manage_employees` | 管理员工 |
| `manage_devices` | 管理设备授权 |
| `manage_stores` | 查看门店列表 |
| `manage_admins` | 管理子账号（仅超管） |
| `sync_data` | 同步数据 |
| `view_audit_log` | 查看操作日志 |

---

## 八、部署运维

### 8.1 部署命令

```bash
# 部署 Edge Function
cd "g:\Trae项目\缺货统计系统"
npx supabase functions deploy query-shortage-data --project-ref qswpgnnedqvuegwfbprd

# 部署前端到 Cloudflare Pages
npx wrangler pages deploy . --project-name=wszhyy --branch=main
```

### 8.2 环境变量（Supabase Edge Functions）

| 变量名 | 说明 |
|--------|------|
| `SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key |
| `SQL_SERVER_HOST` | SQL Server 地址 |
| `SQL_SERVER_PORT` | SQL Server 端口（1290） |
| `SQL_SERVER_USER` | SQL Server 用户名 |
| `SQL_SERVER_PASSWORD` | SQL Server 密码 |
| `SQL_SERVER_DATABASE` | 数据库名称（RQZT） |
| `DEFAULT_EMPLOYEE_PASSWORD` | 员工默认密码（由环境变量配置，勿硬编码） |

### 8.3 配置文件

| 文件 | 用途 |
|------|------|
| `wrangler.toml` | Cloudflare Pages 配置（项目名 `wszhyy`） |
| `_headers` | Cloudflare Pages CORS 头 |
| `package.json` | Electron 打包配置（版本 v3.19.0） |
| `.npmrc` | npm 国内镜像 |

### 8.4 桌面客户端自动更新

**原理**：
```
旧客户端(如v3.18.5)启动
  → electron-main.js 调用 check-update Edge Function
  → 返回 latest.yml + .exe 下载地址
  → electron-updater 自动下载到临时目录
  → 提示用户安装 → 自动重启 → 升级到 v3.18.6
```

**关键配置**：

| 组件 | 文件 | 作用 |
|------|------|------|
| 版本检测 | `supabase/functions/check-update/index.ts` | 返回最新版本号、更新日志、下载URL |
| 客户端检测 | `electron-main.js` 的 `checkForUpdates()` | 启动后3秒自动检测；`UPDATE_FILES_URL` 指向 .exe 存放目录 |
| 安装包托管 | GitHub Releases | 存放 `WSZH-ShortageStore Setup 3.19.0.exe` + `latest.yml` |
| 打包配置 | `package.json` `publish.url` | 指向 GitHub Releases（通过 Edge Function 动态获取） |

**发布新版本流程**：
```bash
# 1. 打包（生成 .exe + latest.yml）
npx electron-builder --win --c.directories.output=dist

# 2. 上传到 GitHub Release（使用 gh CLI）
gh release upload v3.19.0 "dist\WSZH-ShortageStore Setup 3.19.0.exe" "dist\WSZH-ShortageStore Setup 3.19.0.exe.blockmap" "dist\latest.yml" --clobber

# 3. 更新 check-update 函数版本号 + 部署
npx supabase functions deploy check-update --project-ref qswpgnnedqvuegwfbprd

# 4. 推送到 Cloudflare Pages
npx wrangler pages deploy deploy --project-name=wszhyy --commit-dirty=true
```

### 8.5 日志查看

- **Edge Function 日志**：Supabase Dashboard → Edge Functions → query-shortage-data → Logs
- **关键日志关键词**：`SPFXB_Result同步完成`、`从SQL Server返回`、`[采样数据]`、`[store_login]`

---

## 九、常见问题排查

### 9.1 数据相关

| 问题 | 排查步骤 |
|------|---------|
| 库存数据与 Excel 不一致 | ① 管理员点「同步采购计划」→ ② 门店端点「刷新库存」→ ③ 重新登录 |
| 同步采购计划报错 | 查看 Edge Function 日志 → 常见原因：Vptype 表名错误、SQL Server 连接失败 |
| 刷新库存后数据仍不对 | 检查当前登录账号是否正确映射到门店（`STORE_NAME_MAP`） |

### 9.2 设备授权

| 问题 | 排查步骤 |
|------|---------|
| 所有设备码相同 | 旧版设备码需要刷新 → 清除浏览器缓存或用无痕模式 → 生成 `DEV_v2_` 新码 |
| 门店被锁死在错误门店 | 管理员 → 设备授权 → 撤销该设备 → 门店重新登录 |
| 多次点击产生重复待授权 | 已修复（去重），刷新页面即可 |
| 授权后退出又需要授权 | 已修复（退出不取消授权），如仍出现检查是否被手动撤销 |

### 9.3 Supabase 常见问题

```sql
-- 写入权限被拒绝 → 关闭 RLS
ALTER TABLE product_cache DISABLE ROW LEVEL SECURITY;
ALTER TABLE shortage_storestock_cache DISABLE ROW LEVEL SECURITY;
ALTER TABLE shortage_purchaseplancache DISABLE ROW LEVEL SECURITY;
ALTER TABLE reports DISABLE ROW LEVEL SECURITY;
```

---

## 十、项目文件结构

```
缺货统计系统/
├── index.html                    # 入口（跳转登录）
├── login.html                    # 统一登录页（员工/门店/管理员）
├── store.html                    # 门店端
├── admin.html                    # 管理后台
├── package.json                  # Electron 打包配置
├── electron-main.js              # Electron 主进程
├── preload.js                    # Electron 预加载
├── wrangler.toml                 # Cloudflare 配置
├── _headers                      # Cloudflare CORS
├── manifest.json                 # PWA 清单
├── CHANGELOG.md                  # 版本更新日志
├── README.md                     # 本文档
├── PROJECT_FILES_GUIDE.md        # 文件速查手册
│
├── static/
│   ├── css/style.css             # 全局样式（5套主题）
│   ├── js/
│   │   ├── utils.js              # 工具模块（设备ID v2/XSS防护）
│   │   ├── store.js              # 门店端逻辑
│   │   ├── admin.js              # 管理后台逻辑
│   │   ├── fuse.min.js           # Fuse.js 搜索
│   │   └── supabase-init.js      # Supabase 初始化
│   ├── sw.js                     # PWA Service Worker
│   ├── logo.jpg                  # 企业LOGO
│   └── icon-*.png                # PWA 图标
│
├── supabase/
│   └── functions/
│       ├── query-shortage-data/
│       │   └── index.ts          # 主 Edge Function（43 action）
│       ├── check-update/
│       │   └── index.ts          # 版本检查
│       └── scheduled-task/
│           └── index.ts          # 定时任务
│
├── deploy/                       # 部署目录（与根目录 HTML/static 同步）
│   ├── login.html
│   ├── store.html
│   ├── admin.html
│   └── static/
│
├── sql/                          # SQL 脚本（共21个）
│   ├── create_product_cache_rqzt.sql   # RQZT 商品缓存表+存储过程
│   ├── optimize_upsert_cache.sql       # Supabase 库存缓存唯一约束
│   ├── fix_duplicates_before_upsert.sql# 清理重复+建约束
│   ├── check_spfxb_index.sql           # SPFXB_Result 索引检查
│   ├── create_admin_users.sql          # 子账号表+权限+RLS
│   ├── create_order_feedback_objects.sql # 订货反馈表+存储过程
│   └── ...
│
└── vba/                          # Excel VBA 批量回写
    ├── 商品分析表SPFXB_完整版.bas
    ├── 回写实际订货.bas
    ├── ErrorProgressForm.frm
    └── README.md
```

---

## 十一、接手者快速上手指南

### 第一步：拉取代码
```bash
git clone <仓库地址>
cd "缺货统计系统"
```

### 第二步：理解核心文件
1. 读 `README.md`（本文档）了解全貌
2. 读 `CHANGELOG.md` 了解版本历史
3. 读 `supabase/functions/query-shortage-data/index.ts` 了解后端 API
4. 读 `static/js/store.js` + `static/js/admin.js` 了解前端逻辑

### 第三步：本地测试
- 直接打开 `login.html` 可测试前端（API 调用正式环境）
- Edge Function 部署后自动生效，无需本地运行

### 第四步：修改部署
```bash
# 修改 Edge Function 后
npx supabase functions deploy query-shortage-data --project-ref qswpgnnedqvuegwfbprd

# 修改前端后
npx wrangler pages deploy . --project-name=wszhyy --branch=main
```

### 第五步：查看日志
- Supabase Dashboard → Edge Functions → Logs
- 搜索关键词：`SPFXB_Result`、`store_login`、`采样数据`

### 关键账号
- 管理员：`admin`（超级管理员）
- 02店管理员：`15305479520`
- 员工默认密码：`wszh123456`
- Supabase 项目：`qswpgnnedqvuegwfbprd`

---

## 十二、下一步优化计划（按优先级）

| 优先级 | 优化项 | 收益 | 方式 |
|:--:|--------|------|------|
| ⭐ | 门店配置全面数据库化 | 新增门店一行SQL | 所有硬编码迁移到 `store_config` 表 |
| ⭐⭐ | 代码拆分 Edge Function | 3200行→每个模块<600行 | 按 auth/inventory/sync/devices 拆分 |
| ⭐⭐ | get_all_products 字段精简 | 传输减少 30% | 移除前端不需要的字段 |
| ⭐⭐ | SPFXB_Result 查询统一加 NOLOCK | 避免锁等待 | ESF 中 SQL 语句加 WITH (NOLOCK) |
| ⭐⭐⭐ | 统计分析模块 | 按时间段/品类/供货商统计 | 管理后台新增 Tab |

## 十三、版本历史

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| v3.20.0 | 2026-05-24 | **全方位深度优化**：代码去重180行、STORE_CONFIG统一门店、缓存优先初始化、搜索250ms防抖+取消、历史30秒缓存、在途非阻断提醒、同步分步进度、批量标记N→1、公告栏、到货通知、新品审批/驳回、按钮loading动画、固定表头、Toast轻提示、get_summary合并请求、网络自动重试、全局错误边界、Keep-Warm保活、10个数据库索引、登录防刷持久化 |
| v3.19.0 | 2026-05-23~24 | 双表格优化、供货商+状态日志、RQZT商品缓存(200ms)、库存UPSERT、自动更新修复、登录页更新提示条 |
| v3.18.8 | 2026-05-23 | 订货状态完善(待付款/厂家断货)、上报人管理、历史记录格式优化 |
| v3.18.7 | 2026-05-21 | 登录页致命Bug修复、设备码持久化、CDN缓存优化、一键发布工具 |
| v3.18.6 | 2026-05-20 | 库存同步重构、各店库存优化、设备锁定+数量限制、设备码v2、批量授权 |
| v3.18.5 | 2026-05-19 | 设备授权优化、启动体验优化、自动更新配置 |
| v3.18.0 | 2026-05-19 | 管理后台增强（修改密码、自动化部署配置） |
| v3.17 | 2026-05-18 | 设备授权机制升级 |
| v3.16 | 2026-05-18 | 修复库存数据不一致 |
| v3.0 | 2026-05-13 | 订货状态反馈系统，员工设备绑定 |
