# 缺货统计系统 - 项目文件速查手册

> **适用版本**：v3.19.0 | **更新日期**：2026-05-24  
> 详细文档见 [README.md](./README.md)，本文档仅作文件索引。

---

## 📁 项目结构总览

```
缺货统计系统/
├── 📄 login.html              # 登录页面
├── 📄 store.html              # 门店端页面
├── 📄 admin.html              # 管理端页面
├── 📂 deploy/                 # 部署镜像目录（与源文件同步）
├── 📂 static/                 # 静态资源
│   ├── css/style.css          # 全局样式（~3200行）
│   ├── js/store.js            # 门店端逻辑（~1600行）
│   ├── js/admin.js            # 管理端逻辑（~1900行）
│   ├── js/utils.js            # 公共工具（状态/设备ID/XSS防护）
│   └── logo.jpg / icon-*     # 图标资源
├── 📂 supabase/functions/     # Edge Functions（Deno/TS）
│   ├── query-shortage-data/   # 核心业务（45个action，3150行）
│   ├── scheduled-task/        # 定时任务（同步/RQZT缓存刷新）
│   └── check-update/          # 客户端更新检查
├── 📂 sql/                    # SQL 脚本（17个文件）
│   ├── create_product_cache_rqzt.sql   # RQZT商品缓存表
│   ├── fix_duplicates_before_upsert.sql # UPSERT前置清理
│   ├── optimize_upsert_cache.sql       # 唯一约束DDL
│   └── ...（建表/索引/存储过程脚本）
├── 📂 vba/                    # VBA 脚本（Excel/Access用）
├── 📂 dist/                   # Electron 打包输出（本地生成，不入库）
├── 📂 .codebuddy/             # IDE 项目数据（不入库）
├── ⚙️package.json             # Node.js/Electron 配置（v3.19.0）
├── ⚙️preload.js               # Electron 预加载（IPC桥接）
├── ⚙️electron-main.js         # Electron 主进程（窗口/自动更新）
├── ⚙️manifest.json            # PWA 应用清单
├── ⚙️_headers                 # Cloudflare Pages 缓存策略
├── ⚙️_CHANGELOG.md            # 版本更新记录
├── ⚙️README.md                # 完整项目文档
└── ⚙️PROJECT_FILES_GUIDE.md   # 本文件
```

---

## 🔴 核心文件（日常开发必改）

| 文件 | 说明 | 改什么 |
|------|------|--------|
| `login.html` | 登录页 | 门店列表、版本号、登录逻辑 |
| `store.html` | 门店端页面 | 上报表单、历史记录表格、库存展示 |
| `store.js` | 门店端逻辑 | 搜索/上报/库存/缓存、Fuse.js |
| `admin.html` | 管理端页面 | 缺货汇总表、筛选器、已完成区 |
| `admin.js` | 管理端逻辑 | 筛选/状态更新/同步/渲染/导出 |
| `style.css` | 全局样式 | 布局/表格/徽章/主题/响应式 |
| `utils.js` | 公共工具 | 状态定义/设备ID/XSS防护/防抖 |
| `query-shortage-data/index.ts` | 核心Edge Function | 45个action：认证/商品/库存/同步/授权 |
| `scheduled-task/index.ts` | 定时任务 | 自动同步/RQZT缓存刷新 |
| `check-update/index.ts` | 更新检查 | 版本号/下载URL/更新日志 |
| `electron-main.js` | 桌面主进程 | 版本号/路由/窗口/自动更新 |
| `preload.js` | IPC桥接 | 安全API暴露给渲染进程 |

## 🟡 配置文件

| 文件 | 说明 |
|------|------|
| `package.json` | Electron 打包、依赖（v3.19.0） |
| `_headers` | HTML不缓存/静态资源强缓存 |
| `manifest.json` | PWA 配置 |
| `.gitignore` | 排除 dist/sync_data/历史对话/等 |

## 🔵 部署镜像目录

| 目录 | 说明 |
|------|------|
| `deploy/` | 与源文件同步的镜像目录，用于 Cloudflare Pages 部署时的备用引用 |

---

## 🗂️ SQL 脚本分类

| 类别 | 文件 |
|------|------|
| 建表 | `create_admin_users.sql`, `create_order_feedback_objects.sql`, `create_status_changelog.sql` |
| 存储过程修复 | `fix_auto_detect_arrival.sql`, `fix_sync_spfxb_result.sql` |
| 员工管理 | `batch_add_employees.sql`, `employee_pwa_upgrade.sql` |
| 性能优化 | `create_product_cache_rqzt.sql`, `fix_duplicates_before_upsert.sql`, `optimize_upsert_cache.sql`, `optimization_v3.18.6.sql` |
| 索引检查 | `check_spfxb_index.sql` |

## 📂 vba/ 目录

存放 Excel/Access 中使用的 VBA 宏，用于生成分析报表、回写订货数量等。不随前端一起部署。

---

## 📝 注意事项

- **static/** 目录 HTML/JS/CSS 上传到 Cloudflare Pages 展示
- **supabase/functions/** 通过 `npx supabase functions deploy` 单独部署
- **sql/** 和 **vba/** 在 SSMS/Excel 中手动执行，不上传云端
- **dist/** 是 Electron 打包输出（`npx electron-builder`），已入 `.gitignore`
- **deploy/** 是源文件镜像目录，与源文件保持一致
