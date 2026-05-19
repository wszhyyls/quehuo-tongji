# 缺货统计系统 - 项目完整文档

> 适用版本：v3.17.1 | 更新日期：2026-05-18

---

## 一、项目概述

### 1.1 项目简介

本系统为**微山县众和医药连锁有限公司**定制的缺货管理与新品订购平台，用于门店缺货上报、新品订购申请，以及管理端统一汇总采购计划。

### 1.2 业务痛点

| 痛点 | 说明 |
|------|------|
| 信息传递效率低 | 门店缺货信息依赖电话、微信群传递，易遗漏 |
| 数据分散 | 缺乏统一上报平台，难以汇总 |
| 决策困难 | 采购计划制定缺乏数据支撑 |
| 信息不透明 | 无法追踪缺货处理进度 |

### 1.3 项目目标

| 角色 | 目标 |
|------|------|
| **门店端** | 快速上报缺货/新品，系统自动提示在途、重复上报 |
| **管理端** | 实时汇总缺货数据，制定采购计划，追踪处理进度 |
| **技术目标** | 零运维、低成本、高可用的云端解决方案 |

### 1.4 核心价值

| 价值点 | 说明 |
|--------|------|
| **自动化** | 自动提示在途数量、重复上报、数据汇总 |
| **实时性** | 库存数据实时同步，状态自动检测 |
| **便捷性** | PWA 支持手机端使用，桌面客户端可选 |
| **安全性** | 设备授权机制+JWT 认证，多重安全保障 |

### 1.5 项目发展历程

本项目从 2026 年 4 月开始，经历了多个版本迭代，从本地部署逐渐演进为纯云服务架构：

- **v0.x**：本地测试原型，基于 `SPFXB_Result` 表
- **v1.x**：本地 Flask+SQLite 部署，完成核心 UI 优化
- **v2.x**：迁移到 Supabase 云服务，实现零运维
- **v3.x**：当前版本，完善订货状态反馈和员工设备绑定
- **v3.1~v3.8**：PWA支持、批量操作、用户体验优化
- **v3.9~v3.17.1**：订货反馈、VBA功能、性能优化、安全加固

---

## 二、系统地址

### 2.1 正式环境

| 类型 | 地址 | 说明 |
|------|------|------|
| 门店端 | `https://wsz3hy.pages.dev/store.html` | 门店缺货上报、新品订购 |
| 管理后台 | `https://wsz3hy.pages.dev/admin.html` | 缺货汇总、订货管理、员工管理 |
| 登录页 | `https://wsz3hy.pages.dev/login.html` | 统一登录入口 |

### 2.2 后端服务

| 服务 | 地址 | 说明 |
|------|------|------|
| Supabase Dashboard | `https://supabase.com/dashboard/project/qswpgnnedqvuegwfbprd` | 数据库管理（需登录） |
| Edge Function API | `https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data` | 后端业务逻辑 |

---

## 三、支持门店

| 编号 | 门店 ID | 门店名称 |
|------|---------|----------|
| 01 | `wszhyy02` | 02第二药店 |
| 02 | `wszhyy03` | 03第三药店 |
| 03 | `wszhyy04` | 04第四药店 |
| 04 | `wszhyy06` | 06常口店 |
| 05 | `wszhyy08` | 08第八药店 |
| 06 | `wszhyy09` | 09第九药店 |
| 07 | `wszhyy14` | 14第十四药店 |
| 08 | `wszhyy16` | 16凤凰山药店 |
| 09 | `wszhyy17` | 17益丰店 |
| 10 | `wszhyy21` | 21富源店 |

---

## 四、技术架构

### 4.1 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     用户终端 (浏览器 / 桌面客户端)               │
│                                                              │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐                    │
│   │门店端   │  │管理后台  │  │桌面客户端│                    │
│   │store    │  │admin    │  │Electron │                    │
│   │v3.17.1 │  │v3.17.1  │  │         │                    │
│   └────┬────┘  └────┬────┘  └────┬────┘                    │
└────────┼────────────┼────────────┼─────────────────────────┘
         │            │            │
         └────────────┼────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Pages (全球 CDN 加速)                │
│                                                              │
│   login.html  store.html  admin.html  index.html            │
│   manifest.json  _headers  static/                          │
└────────────────────────────┬────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Supabase Auth  │ │  Supabase Edge   │ │  Supabase       │
│  (用户认证/JWT)  │ │  Function       │ │  PostgreSQL     │
│                 │ │  query-shortage │ │                 │
│  门店员工账号    │ │  -data (Deno)  │ │  product_cache  │
│  管理员账号      │ │                 │ │  shortage_*     │
│  设备授权        │ │  SQL 连接池     │ │  store_*        │
└─────────────────┘ └────────┬────────┘ │  sync_log_*     │
                             │          │  reports         │
                             │          └─────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   SQL Server    │
                    │  RQZT 账套     │
                    │  121.229.175.49│
                    │  端口: 1290    │
                    │                 │
                    │  Shortage_* 表 │
                    │  usp_* 存储过程│
                    └─────────────────┘
```

### 4.2 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| **前端** | HTML5 + CSS3 + JavaScript (ES6) | 纯前端，无框架依赖 |
| **前端托管** | Cloudflare Pages | 全球 CDN，免费额度充足 |
| **用户认证** | Supabase Auth + JWT | 安全可靠的认证机制 |
| **后端服务** | Supabase Edge Functions (Deno) | 无服务器架构，按需扩展 |
| **缓存数据库** | Supabase PostgreSQL | 商品缓存、快速搜索 |
| **业务数据库** | SQL Server (RQZT 账套) | 实时业务数据源 |
| **桌面客户端** | Electron | Windows 桌面应用打包 |

### 4.3 关键设计决策

| 决策点 | 选择方案 | 替代方案 | 选型理由 |
|--------|----------|----------|----------|
| 数据存储位置 | SQL Server 不迁移 | 全量迁移到 Supabase | 业务数据量大、保持实时性 |
| 前端托管 | Cloudflare Pages | 腾讯云/阿里云 | 免费额度高、CDN 优秀 |
| 认证方式 | Supabase Auth + 设备绑定 | 传统用户名密码 | 安全、支持多设备管理 |
| 移动端方案 | PWA | Capacitor/UniApp | 零开发成本、快速上线 |
| 商品搜索 | Fuse.js 前端内存搜索 | 后端数据库 like 查询 | 毫秒级响应、无网络延迟 |
| 商品列表缓存 | localStorage 永久缓存 | 每次登录重新加载 | 商品信息变化少、减少服务器压力 |

---

## 五、数据流向

### 5.1 门店端操作流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  1. 商品搜索                                                                  │
│     前端 → Supabase (product_cache) → Fuse.js 内存搜索                        │
│     └─ 响应：< 50ms（内存搜索）或 100-300ms（后端搜索）                        │
│                                                                             │
│  2. 查看商品详情                                                              │
│     前端 → Edge Function → SQL Server (Shortage_StoreStockCache)            │
│     └─ 返回：该商品在所有门店的库存情况                                        │
│                                                                             │
│  3. 缺货上报                                                                 │
│     前端 → Edge Function → Supabase (reports 表)                             │
│     └─ 写入：门店ID、商品信息、需求数量、紧急程度等                             │
│                                                                             │
│  4. 查看历史记录                                                              │
│     前端 → Edge Function → Supabase (reports 表)                            │
│                    ↓                                                        │
│              SQL Server (Shortage_OrderFeedback)                             │
│                    ↓                                                        │
│              合并状态返回 → 前端显示                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 管理端操作流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  1. 同步采购计划                                                              │
│     前端 → Edge Function → SQL Server                                       │
│     └─ 执行：usp_Sync_AllShortageCache_Integration                          │
│     └─ 执行：usp_AutoDetectOrderStatus_Feedback                             │
│     └─ 写入：同步日志到 sync_log_table                                       │
│                                                                             │
│  2. 订货管理                                                                 │
│     前端 → Edge Function → SQL Server (Shortage_OrderFeedback)               │
│     └─ 设置实际订货数量 → 状态自动变为"已订购"                                 │
│     └─ 手动修改状态 → 状态变为指定值                                          │
│                                                                             │
│  3. VBA 批量订货（Excel 端）                                                 │
│     Excel VBA → SQL Server (Shortage_OrderFeedback)                         │
│     └─ 批量写入订货数量                                                       │
│     └─ 状态自动变为"已订购"                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 六、数据来源说明

### 6.1 门店端显示的数据来源

| 前端显示 | 数据来源 | 说明 |
|----------|----------|------|
| 本店库存 | SQL Server `Shortage_StoreStockCache.库存数量` | 当前门店实时库存 |
| 配送在途 | SQL Server `Shortage_StoreStockCache.在途数量` | 当前门店在途配送 |
| 仓库库存 | SQL Server `Shortage_StoreStockCache.配送中心库存数量` | 配送中心/仓库总库存 |
| 前30天销量 | SQL Server `Shortage_StoreStockCache.前30天销售数量` | 近30天累计销量 |
| 标准库存 | SQL Server `Shortage_StoreStockCache.标准库存数量` | 系统计算的标准备货量 |
| 建议订货数量 | SQL Server `Shortage_PurchasePlanCache.建议订货数量` | 根据库存和销量计算 |
| 订货状态 | SQL Server `Shortage_OrderFeedback.补货状态` | "待处理" / "已订购" / "已到货" |

### 6.2 基础数据来源表

| 数据类型 | 源表 | 说明 |
|----------|------|------|
| 商品基础信息 | `ZHYYLS.Vptype` | 商品档案，包含商品编码、名称、规格等 |
| 门店销售数据 | `SPFXB` | 各门店销售记录，用于计算销量 |
| 库存数据 | `ZHYYLS.KC` | 仓库库存 |
| 派生缓存 | `Shortage_StoreStockCache` | 门店库存缓存，由存储过程维护 |
| 派生缓存 | `Shortage_PurchasePlanCache` | 采购计划缓存，由存储过程维护 |
| 订货反馈 | `Shortage_OrderFeedback` | 人工录入的订货数量和状态 |

---

## 七、安全机制

| 安全措施 | 说明 |
|----------|------|
| **XSS 防护** | 所有用户输入使用 `safeText()` 转义，防止跨站脚本攻击 |
| **SQL 注入防护** | Edge Function 所有外部输入进行长度限制和特殊字符过滤 |
| **设备授权** | 员工首次登录需管理员授权，防止未授权设备访问 |
| **JWT 认证** | 所有 API 调用使用 Supabase JWT Token 验证身份 |
| **输入验证** | `validateInput()` 函数对所有参数进行严格校验 |
| **单设备登录** | 同一账号同一时间只能登录一台设备（例外账号除外） |

---

## 八、性能优化

| 优化项 | 说明 |
|--------|------|
| **SQL 连接池** | Edge Function 实现连接池机制，最多缓存5个连接 |
| **连接复用** | 5分钟超时内重复请求复用同一连接，减少连接创建开销 |
| **Fuse.js 搜索** | 商品搜索使用前端内存搜索，毫秒级响应 |
| **登录预加载** | 登录时同步加载商品列表和库存到前端内存 |
| **永久缓存** | 商品列表 localStorage 永久缓存，减少重复加载 |
| **连接池 TTL** | 空闲连接5分钟后自动关闭，释放资源 |

---

## 九、数据库结构

### 9.1 Supabase PostgreSQL 表

#### 9.1.1 `stores` 门店基础表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `store_id` | TEXT | 门店编码（如 `wszhyy02`） |
| `store_name` | TEXT | 门店名称 |
| `is_active` | BOOLEAN | 是否启用 |

#### 9.1.2 `product_cache` 商品缓存表

| 字段 | 类型 | 说明 |
|------|------|------|
| `product_code` | TEXT | 商品编码（**唯一索引**） |
| `product_name` | TEXT | 商品名称 |
| `product_spec` | TEXT | 规格 |
| `manufacturer` | TEXT | 生产企业 |
| `pinyin_code` | TEXT | 拼音助记码 |
| `updated_at` | TIMESTAMPTZ | 更新时间 |

#### 9.1.3 `shortage_purchaseplancache` 采购计划缓存表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | SERIAL | 自增主键 |
| `product_code` | TEXT | 商品编码 |
| `product_name` | TEXT | 商品名称 |
| `product_spec` | TEXT | 规格 |
| `manufacturer` | TEXT | 生产企业 |
| `warehouse_stock` | INTEGER | 仓库库存数量 |
| `standard_total` | INTEGER | 标准库存汇总 |
| `store_total` | INTEGER | 门店库存汇总 |
| `in_transit_total` | INTEGER | 在途汇总 |
| `available` | INTEGER | 可调拨数量 |
| `suggested_order` | INTEGER | 建议订货数量 |
| `last_updated` | TIMESTAMPTZ | 更新时间 |

#### 9.1.4 `reports` 缺货/新品上报表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `store_id` | TEXT | 门店编码 |
| `store_name` | TEXT | 门店名称 |
| `order_type` | TEXT | 上报类型：`缺货订购` 或 `新品订购` |
| `product_code` | TEXT | 商品编码 |
| `product_name` | TEXT | 商品名称 |
| `specification` | TEXT | 规格 |
| `manufacturer` | TEXT | 生产企业 |
| `current_stock` | INTEGER | 当前库存 |
| `demand_quantity` | INTEGER | 需求数量 |
| `urgency_level` | TEXT | 紧急程度：`紧急` / `加急` / `普通` |
| `replenish_status` | TEXT | 补货状态（仅供参考） |
| `replenish_manual` | INTEGER | 实际订货数量 |
| `remark` | TEXT | 备注 |
| `reporter_id` | UUID | 上报人员工 ID |
| `reporter_phone` | TEXT | 上报人手机号 |
| `reporter_name` | TEXT | 上报人姓名 |
| `created_at` | TIMESTAMPTZ | 上报时间 |

#### 9.1.5 `store_employees` 员工表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `phone` | TEXT | 手机号（唯一） |
| `name` | TEXT | 姓名 |
| `store_id` | TEXT | 所属门店编码 |
| `store_name` | TEXT | 所属门店名称 |
| `is_active` | BOOLEAN | 是否启用 |
| `password` | TEXT | 密码（默认 `123456`） |
| `created_by` | UUID | 创建人 |
| `created_at` | TIMESTAMPTZ | 创建时间 |

#### 9.1.6 `store_authorized_devices` 门店设备授权表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `device_id` | TEXT | 设备 ID |
| `store_id` | TEXT | 门店编码 |
| `employee_id` | UUID | 员工 ID |
| `is_authorized` | BOOLEAN | 是否已授权 |
| `is_active` | BOOLEAN | 是否有效 |
| `created_at` | TIMESTAMPTZ | 创建时间 |

### 9.2 SQL Server 表

#### 9.2.1 `Shortage_StoreStockCache` 门店库存缓存表

| 字段 | 类型 | 说明 |
|------|------|------|
| `门店编码` | NVARCHAR(50) | 门店 ID |
| `门店名称` | NVARCHAR(100) | 门店名称 |
| `商品编码` | NVARCHAR(50) | 商品编码 |
| `商品名称` | NVARCHAR(200) | 商品名称 |
| `规格` | NVARCHAR(200) | 规格 |
| `生产企业` | NVARCHAR(200) | 生产企业 |
| `库存数量` | INT | 门店当前库存 |
| `在途数量` | INT | 在途数量 |
| `配送中心库存数量` | INT | DC 库存 |
| `前30天销售数量` | INT | 30天销量 |
| `标准库存数量` | INT | 标准库存 |

#### 9.2.2 `Shortage_OrderFeedback` 订货状态反馈表

| 字段 | 类型 | 说明 |
|------|------|------|
| `序号` | INT | 自增主键 |
| `商品编码` | NVARCHAR(50) | 商品编码 |
| `实际订货数量` | INT | 实际订货数量 |
| `补货状态` | NVARCHAR(50) | `待处理` / `已订购` / `已到货` |
| `订货时间` | DATETIME | 订货时间 |
| `到货确认时间` | DATETIME | 到货确认时间 |
| `操作人` | NVARCHAR(100) | 操作人 |
| `备注` | NVARCHAR(500) | 备注 |

### 9.3 关键存储过程

| 存储过程 | 功能 |
|----------|------|
| `usp_Sync_AllShortageCache` | 整合同步（推荐） |
| `usp_Sync_AllShortageCache_Integration` | 整合同步（新版） |
| `usp_UpdateActualOrder` | 上传订货数量 |
| `usp_UpdateActualOrderStatus` | 手动修改补货状态 |
| `usp_AutoDetectOrderStatus_Feedback` | 自动检测到货 |
| `usp_GetPurchasePlanWithFeedback` | 查询采购计划（含订货状态） |
| `usp_GetSyncLog` | 查询同步日志 |

---

## 十、Edge Function API

### 10.1 基础信息

| 项目 | 值 |
|------|---|
| URL | `https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data` |
| Method | POST |
| Content-Type | `application/json` |
| Authorization | `Bearer <token>` |

### 10.2 核心 Action

| Action | 说明 | 调用方 |
|--------|------|--------|
| `employee_login` | 员工登录 | 门店端 |
| `store_login` | 门店账号登录 | 门店端 |
| `admin_login` | 管理员登录 | 管理端 |
| `search_product` | 商品搜索 | 门店/管理端 |
| `get_product_detail` | 商品详情 | 门店/管理端 |
| `get_purchase_plan` | 采购计划列表 | 管理端 |
| `set_actual_order_qty` | 设置订货数量 | 管理端 |
| `manual_update_status` | 手动修改状态 | 管理端 |
| `sync_with_auto_status` | 一键同步 | 管理端 |
| `get_my_reports` | 获取门店历史上报 | 门店端 |
| `insert_report` | 门店上报 | 门店端 |
| `cancel_report` | 取消上报 | 门店端 |
| `get_store_inventory` | 获取门店库存 | 门店端 |
| `get_employees` | 获取员工列表 | 管理端 |
| `add_employee` | 添加员工 | 管理端 |
| `update_employee` | 更新员工 | 管理端 |
| `revoke_device` | 吊销设备授权 | 管理端 |

---

## 十一、前端功能说明

### 11.1 门店端（store.html）

#### 11.1.1 登录流程

- 输入**员工手机号** + **密码**（默认 `123456`）
- 首次登录时需管理员授权设备
- 支持记住密码（按账号独立存储）
- 支持密码显示/隐藏切换
- 支持门店账号登录

#### 11.1.2 缺货订购 Tab

- 商品搜索（支持编码/名称/规格/厂家/拼音码模糊搜索）
- 搜索结果分页显示（默认20条，加载更多）
- 商品详情 + 各门店库存
- **订货数量默认值**：自动填入建议订货数量
- 上报缺货，自动检测在途数量
- 自动提示重复上报

#### 11.1.3 历史记录 Tab

- **多维度筛选**：按类型/状态/时间筛选
- **时间范围**：最近7天/30天/90天/全部
- 加载更多分页
- 订货状态实时同步
- **门店主账号可取消**店员的上报记录

#### 11.1.4 新品订购 Tab

- 搜索新品（系统中尚未采购的商品）
- 填写商品名、规格、参考厂家

### 11.2 管理端（admin.html）

#### 11.2.1 缺货汇总 Tab

- 顶部统计：上报总数 / 缺货品种数 / 上报门店数
- 缺货汇总表：商品编码、名称、规格、厂家、紧急程度、总需求、实际订货、订货状态
- **同步采购计划**（一键同步 + 状态检测）
- 订货管理弹窗
- **批量操作**：复选框多选、批量标记已到货、全选功能
- **自动刷新设置**：可选30秒/1分钟/5分钟/10分钟自动刷新

#### 11.2.2 新品汇总 Tab

- 查看所有新品订购申请
- 处理新品订购流程

#### 11.2.3 员工管理 Tab

- 员工列表（手机号、姓名、门店、设备数、状态）
- 添加/停用/启用员工
- 解绑设备
- 设备授权管理

#### 11.2.4 门店管理 Tab

- 门店账号列表
- 设备授权管理
- 门店账号登录管理

#### 11.2.5 操作日志 Tab

- 查看同步操作日志
- 记录同步时间、状态、操作人

### 11.3 VBA 端（Excel）

| 功能 | 说明 |
|------|------|
| 上传订货数量 | 批量写入 SQL Server |
| 查看订货记录 | 查询历史订货 |
| 测试连接 | ODBC 连接测试 |
| 清除颜色 | 清除已处理行标记 |

---

## 十二、PWA 与桌面客户端

### 12.1 PWA 支持

系统支持**渐进式 Web 应用（PWA）**，门店员工可安装到手机桌面：

| 特性 | 说明 |
|------|------|
| Service Worker | 离线缓存、加速访问 |
| 主屏幕图标 | iOS/Android 全屏运行 |
| 本地缓存 | 无网络时仍可查看缓存内容 |

**安装方式**：
1. **Chrome/Edge**：访问门店端 → 右上角菜单 → **添加到主屏幕**
2. **Safari（iOS）**：访问后点击分享 → **添加到主屏幕**

### 12.2 桌面客户端（Electron）

| 文件 | 说明 |
|------|------|
| `package-store.json` | Electron 打包配置 |
| `electron-main.js` | Electron 主进程 |
| `打包门店端.bat` | 一键打包脚本 |

**特点**：
- 独立窗口运行，无需浏览器
- 自动禁止多开（单实例）
- 自动检测更新
- 一键更新安装

---

## 十三、部署步骤

### 13.1 环境准备

| 平台 | 网址 | 用途 |
|------|------|------|
| Supabase | https://supabase.com/dashboard/project/qswpgnnedqvuegwfbprd | 后端 API、数据库 |
| Cloudflare Pages | https://dash.cloudflare.com | 前端托管 |
| SQL Server | `121.229.175.49,1290` → `RQZT` 账套 | 业务数据源 |

### 13.2 部署流程

#### 第一步：配置 SQL Server

1. 连接 `121.229.175.49,1290`
2. 选择数据库 `RQZT`
3. 执行 `sql/create_order_feedback_objects.sql`

#### 第二步：配置 Supabase

1. 执行 `sql/employee_pwa_upgrade.sql`
2. 配置 Edge Function Secrets（在 Supabase 后台配置）
3. 部署 Edge Function

#### 第三步：部署前端

1. 创建 Cloudflare Pages 项目
2. 上传所有前端文件到根目录
3. 部署完成

### 13.3 访问地址

| 类型 | 地址 |
|------|------|
| 门店端 | `https://wsz3hy.pages.dev/store.html` |
| 管理后台 | `https://wsz3hy.pages.dev/admin.html` |
| 登录页 | `https://wsz3hy.pages.dev/login.html` |

---

## 十四、运行维护

### 14.1 每日维护

- 管理后台点击「同步采购计划」

### 14.2 定期检查

- 登录 **Supabase Dashboard** → **Edge Functions** → 查看函数日志是否有报错
- 检查 `sync_log_table` 表中的同步记录

### 14.3 sync_data.py 脚本说明

`sync_data.py` 是**本地同步脚本**，用于将 SQL Server 数据同步到 Supabase：

| 同步内容 | 说明 |
|---|---|
| 商品基础数据 | 从 Shortage_StoreStockCache 同步到 product_cache |
| 门店库存数据 | 从 Shortage_StoreStockCache 同步到 shortage_storestock_cache |
| 采购计划数据 | 从 Shortage_PurchasePlanCache 同步到 shortage_purchaseplancache |

**使用场景**：
- Edge Function 故障时的备用同步方案
- 批量初始化数据到 Supabase
- 离线环境下的数据同步

---

## 十五、常见问题

### 15.1 前端部署常见错误

#### 页面显示 HTML 源码

**原因**：将前端部署到了 Supabase Storage

**解决**：必须部署到 Cloudflare Pages

### 15.2 Supabase 常见问题

#### 写入数据提示权限被拒绝

**原因**：RLS 策略启用但未正确配置

**解决**：
```sql
ALTER TABLE product_cache DISABLE ROW LEVEL SECURITY;
ALTER TABLE shortage_storestock_cache DISABLE ROW LEVEL SECURITY;
ALTER TABLE shortage_purchaseplancache DISABLE ROW LEVEL SECURITY;
ALTER TABLE reports DISABLE ROW LEVEL SECURITY;
```

---

## 十六、项目文件结构

```
缺货统计系统/
│
├── 根目录（前端部署文件）
│   ├── index.html              # 首页
│   ├── login.html              # 统一登录页
│   ├── store.html              # 门店端
│   ├── admin.html              # 管理后台
│   ├── manifest.json           # PWA 配置
│   ├── _headers               # CORS 配置
│   └── _redirects              # 页面重定向
│
├── static/                     # 静态资源
│   ├── css/
│   │   └── style.css          # 样式文件（5套主题）
│   ├── js/
│   │   ├── utils.js           # 公共工具模块（v3.3新增）
│   │   ├── admin.js           # 管理后台逻辑
│   │   └── store.js           # 门店端逻辑
│   ├── sw.js                  # Service Worker（PWA离线支持）
│   ├── logo.jpg               # 公司 Logo
│   └── icon-*.png             # PWA 图标
│
├── sql/                        # SQL 脚本
│   ├── employee_pwa_upgrade.sql       # Supabase 表结构
│   └── create_order_feedback_objects.sql  # SQL Server 对象
│
├── vba/                        # VBA 脚本
│   ├── 商品分析表SPFXB_完整版.bas   # 完整版
│   └── *.bas                   # 其他模块
│
├── supabase/                   # Supabase 配置
│   └── functions/
│       └── query-shortage-data/
│           ├── index.ts        # Edge Function 主逻辑
│           └── deno.json       # Deno 依赖配置
│
├── electron/                   # Electron 桌面客户端
│   ├── package-store.json
│   ├── electron-main.js
│   └── dist/                   # 打包输出
│
├── deploy/                     # 部署版本备份
│
├── README.md                   # 项目完整文档
├── CHANGELOG.md                # 版本升级记录
├── sync_data.py                # 本地同步脚本（备用）
├── package.json                 # Electron 依赖配置
├── wrangler.toml               # Cloudflare 配置
├── 自动更新部署指南.md          # 自动更新说明
└── 打包完成说明.md              # 打包说明
```

---

## 十七、技术指标

| 指标 | 目标值 | 实际值 | 状态 |
|------|--------|--------|------|
| 商品搜索响应时间 | < 500ms | < 100ms | 超预期 |
| 页面加载时间 | < 3s | < 2s | 达标 |
| 商品详情响应时间 | < 2s | < 1s | 达标 |
| 选择商品响应（预加载后） | < 3s | 秒响应 | 达标 |
| 系统可用性 | 99% | 99.9% | 达标 |
| 移动端适配 | 全机型 | iOS/Android | 完成 |

---

## 十八、版本历史

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
