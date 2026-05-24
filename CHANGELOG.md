# 版本升级记录 (CHANGELOG)

> 适用版本：v3.19.0 | 更新日期：2026-05-24

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

## v3.18.5 — 设备授权机制全面修复

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

## v3.18.5 — 设备授权优化 + 启动体验优化

**部署日期：2026-05-19**

### 问题修复

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
