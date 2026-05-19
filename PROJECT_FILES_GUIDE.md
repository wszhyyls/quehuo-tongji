# 缺货统计系统 - 项目文件说明

## 📁 项目结构总览

```
缺货统计系统/
├── 📄 HTML 页面文件
├── 📂 static/                 # 静态资源目录
├── 📂 supabase/              # Supabase 云函数
├── 📂 sql/                   # SQL 脚本
├── 📂 vba/                   # VBA 脚本（业务系统用）
├── 📂 dist/                  # Electron 打包输出
├── 📂 backups/               # 备份文件
├── ⚙️ package.json           # Node.js 项目配置
├── 📝 manifest.json          # PWA 应用清单
└── 🔧 其他配置文件
```

---

## 📄 HTML 页面文件

### 1. **index.html** - 项目入口页面
- **作用**：项目的根页面，通常重定向到 login.html
- **说明**：访问域名时的默认入口文件

### 2. **login.html** - 统一登录页面
- **作用**：用户登录入口，支持多种登录方式
- **功能**：
  - 员工登录（手机号+设备码）
  - 门店账号登录（用户名+密码）
  - 管理员登录（用户名+密码）

### 3. **store.html** - 门店端页面
- **作用**：门店员工使用的主界面
- **功能**：
  - 商品搜索和缺货上报
  - 查看库存、销售、在途数据
  - 订单管理和状态跟踪

### 4. **admin.html** - 管理端页面
- **作用**：管理员/总部使用的主界面
- **功能**：
  - 数据同步管理
  - 订货状态管理
  - 员工账号管理
  - 门店管理
  - 数据统计和导出

---

## 📂 static/ - 静态资源目录

### 📂 static/css/
- **style.css** - 全局样式文件
  - 包含所有页面的样式定义
  - 响应式布局
  - 移动端适配

### 📂 static/js/
- **store.js** - 门店端业务逻辑
  - 商品搜索功能
  - 缺货上报
  - 库存查询
  - 本地数据缓存

- **admin.js** - 管理端业务逻辑
  - 数据同步功能
  - 员工管理
  - 订货状态管理
  - 数据导出功能

- **utils.js** - 通用工具函数
  - 设备ID生成
  - 数据格式化
  - 网络请求封装
  - localStorage 工具

- **supabase-init.js** - Supabase 客户端初始化
  - 初始化 Supabase 连接
  - 配置认证信息

- **fuse.min.js** - 轻量级模糊搜索库
  - 用于商品搜索的模糊匹配

### 📂 static/images/
- **logo.jpg** - 公司 Logo
- **icon-192.png** - PWA 图标（小）
- **icon-512.png** - PWA 图标（大）

### 📄 static/sw.js - Service Worker
- **作用**：PWA 离线支持
- **功能**：
  - 缓存静态资源
  - 支持离线访问
  - 后台数据同步

---

## 📂 supabase/ - Supabase 云函数

### 📂 supabase/functions/
Supabase Edge Functions，用于处理后端逻辑

#### query-shortage-data/
- **index.ts** - 核心业务逻辑
  - 用户登录认证
  - 商品数据查询
  - 库存数据查询
  - 订货状态管理
  - SQL Server 数据库连接

#### order-management/
- **index.ts** - 订单管理功能
  - 订单创建
  - 订单查询
  - 订单状态更新

#### scheduled-task/
- **index.ts** - 定时任务
  - 数据自动同步
  - 定时清理缓存

#### check-update/
- **index.ts** - 更新检查（Electron用）
  - 检查应用更新
  - 返回版本信息

### 📂 supabase/.temp/
- **cli-latest** - Supabase CLI 版本信息
- **linked-project.json** - 项目链接配置

---

## 📂 sql/ - SQL 脚本目录

存放用于业务数据库的 SQL 脚本

### create_admin_users.sql
- **作用**：创建管理员表结构
- **说明**：用于创建 store_employees 和 admin_users 表

### create_order_feedback_objects.sql
- **作用**：创建订货反馈相关表
- **说明**：用于订单状态跟踪和反馈

### employee_pwa_upgrade.sql
- **作用**：员工表升级脚本
- **说明**：为员工表添加 PWA 相关字段

### fix_admin_users_fk.sql
- **作用**：修复外键关系
- **说明**：修复 admin_users 表的外键约束

---

## 📂 vba/ - VBA 脚本目录

存放在业务系统（Access/Excel）中使用的 VBA 代码

### 上传订货_ODBC.bas
- **作用**：通过 ODBC 将订货数据上传到业务系统
- **说明**：门店端使用 VBA 脚本上传订货数据

### 商品分析表SPFXB_ODBC版.bas
- **作用**：生成缺货分析报表（ODBC版）
- **说明**：通过 ODBC 连接从业务系统获取数据

### 商品分析表SPFXB_完整版.bas
- **作用**：完整版商品分析报表
- **说明**：包含所有功能的完整版 VBA 脚本

### 回写实际订货.bas
- **作用**：回写实际订货数量
- **说明**：将实际订货数据写回业务系统

### 回写订货数量.bas
- **作用**：批量回写订货数量
- **说明**：批量处理订货数据回写

### ProgressBarForm.frm
- **作用**：进度条窗体
- **说明**：VBA 中的进度条 UI 组件

### README.md
- **作用**：VBA 脚本使用说明
- **说明**：详细的使用指南和注意事项

---

## 📂 dist/ - 打包输出目录

Electron 打包工具的输出目录

### 📂 dist/win-unpacked/
- **作用**：未打包的 Windows 便携版
- **包含**：
  - WSZH-ShortageStore.exe - 主程序
  - 所有依赖的 DLL 文件
  - Chrome 运行时文件
  - static/ - 应用资源

### *.nsis.7z 文件
- **作用**：NSIS 安装包压缩包
- **说明**：用于分发的安装包

### builder-*.yml
- **作用**：electron-builder 配置文件
- **说明**：打包过程的配置文件

---

## 📂 backups/ - 备份目录

### 📂 backups/v3.11_20260517_before_optimization/
- **作用**：v3.11 版本备份
- **包含**：优化前的代码版本

### 📂 backups/v3.13_20260518_P0_P1_optimization/
- **作用**：v3.13 版本备份
- **包含**：P0/P1 优化后的代码版本

---

## ⚙️ 配置文件

### package.json
- **作用**：Node.js 项目配置
- **包含**：
  - 项目依赖
  - 打包配置
  - Electron-builder 配置
  - 脚本命令

### package-lock.json
- **作用**：npm 依赖锁定文件
- **说明**：确保依赖版本一致

### package-store.json
- **作用**：Windows Store 配置（可选）

### manifest.json
- **作用**：PWA 应用清单
- **包含**：
  - 应用名称
  - 图标
  - 主题颜色
  - 启动URL

### _headers
- **作用**：Cloudflare Pages HTTP 头配置
- **说明**：配置 CORS、安全头等

### .npmrc
- **作用**：npm 配置文件
- **说明**：配置 npm 镜像加速

### electron-main.js
- **作用**：Electron 主进程入口
- **说明**：桌面应用的入口文件

### preload.js
- **作用**：Electron 预加载脚本
- **说明**：安全地暴露 Node.js API 给渲染进程

### sync_data.py
- **作用**：Python 数据同步脚本
- **说明**：用于定时同步数据到云端

---

## 🔧 辅助工具

### create_ppt.js
- **作用**：生成 PowerPoint 报表
- **说明**：自动生成数据分析 PPT

### 打包门店端.bat
- **作用**：Windows 批处理脚本
- **说明**：一键打包 Electron 应用

### 自动更新部署指南.md
- **作用**：自动更新配置指南
- **说明**：详细说明如何配置自动更新

### 打包完成说明.md
- **作用**：打包说明文档
- **说明**：打包工具的使用说明

---

## 📊 文件重要性分类

### 🔴 核心文件（必须保留）
```
index.html
login.html
store.html
admin.html
static/
manifest.json
package.json
```

### 🟡 重要文件（建议保留）
```
supabase/functions/
sql/
_headers
package-lock.json
```

### 🟢 可选文件（可删除）
```
vba/              # 如不使用 VBA 功能
backups/          # 旧版本备份
dist/             # 打包输出（可重新生成）
```

### ⚪ 其他文件
```
项目总结报告.md    # 项目文档
完整历史分析报告.md
修改完成说明.md
```

---

## 🚀 快速清理建议

如果需要精简项目，可以删除以下文件：

```bash
# 删除备份和打包输出
rd /s /q backups
rd /s /q dist
rd /s /q supabase\.temp

# 删除 VBA（如果不使用）
rd /s /q vba

# 删除文档（可选）
del *总结*.md
del *说明*.md
```

---

## 📝 备注

- **static/** 目录必须完整上传到 Cloudflare Pages
- **supabase/** 目录的代码通过 Supabase CLI 单独部署
- **vba/** 和 **sql/** 用于业务系统，不需要上传到云端
- **dist/** 是打包输出，门店安装时使用，不需要上传到 Cloudflare Pages
