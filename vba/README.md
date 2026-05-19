# VBA 回写实际订货 - 使用说明

## 功能

在采购计划 Excel 表中填写实际订货数量后，点击 VBA 按钮将数据写入 SQL Server 数据库。

## 文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `回写实际订货.bas` | 标准模块 | 主程序，包含所有 VBA 宏 |
| `ProgressBarForm.frm` | 用户窗体 | 进度条窗体 |
| `README.md` | 说明文档 | 本文件 |

## 安装步骤

### 1. 修改连接参数

在 VBA 编辑器中打开 `回写实际订货.bas`，修改以下常量：

```vba
Private Const SERVER_NAME As String = "121.229.175.49,1290"
Private Const DATABASE_NAME As String = "RQZT"
Private Const DB_USER As String = "zhyy02"
Private Const DB_PASSWORD As String = "你的密码"   ' <-- 修改为实际密码
```

### 2. 导入模块

1. 打开 Excel 采购计划表
2. 按 `Alt + F11` 打开 VBA 编辑器
3. 在 `模块` 上右键 → 导入文件 → 选择 `回写实际订货.bas`

### 3. 创建进度条窗体

1. 在 VBA 编辑器中，`插入 → 用户窗体`
2. 将窗体 `Name` 改为 `ProgressBarForm`
3. 添加控件：
   - `Label1` - 显示进度文字
   - `Frame1` - 外框（可选）
4. 将 `ProgressBarForm.frm` 的代码复制到窗体的代码窗口

### 4. 创建按钮

1. 在 Excel 工作表中，`开发工具 → 插入 → 按钮`
2. 指定宏为 `回写实际订货`
3. 可以再创建一个 `查看订货状态` 按钮

如果没有"开发工具"选项卡：
- `文件 → 选项 → 自定义功能区 → 勾选"开发工具"`

## 使用方法

### 回写实际订货

1. 打开采购计划 Excel 表
2. 在 X 列（或你指定的列）填写各商品的**实际订货数量**
3. 点击 `回写实际订货` 按钮
4. 弹出窗口询问列号（默认 X），确认即可
5. 等待写入完成，成功行显示**绿色**，失败行显示**红色**

### 查看订货状态

点击 `查看订货状态` 按钮，会在当前工作簿中创建一个新工作表，显示所有已回写的订货记录及状态。

## 数据流

```
Excel 采购计划表
    ↓ 填写实际订货数量
    ↓ 点击 VBA 按钮
ADO 连接 → SQL Server
    ↓
EXEC dbo.usp_UpdateActualOrder
    ↓
写入 dbo.Shortage_OrderFeedback 表
    ↓ 状态自动更新
前端查询 → usp_GetPurchasePlanWithFeedback
    ↓
显示采购计划（含实时订货状态）
```

## 前提条件

1. **SQL Server 对象已创建**：需要先执行 `create_order_feedback_objects.sql`
2. **网络连通**：运行 Excel 的电脑需要能访问 `121.229.175.49,1290`
3. **ADODB 支持**：Excel 默认支持，如提示"无法创建对象"，尝试：
   - `工具 → 引用 → 勾选 Microsoft ActiveX Data Objects 6.x Library`

## 常见问题

### Q: 提示"数据库连接失败"
- 检查 SERVER_NAME、DB_USER、DB_PASSWORD 是否正确
- 检查网络是否通畅

### Q: 提示"无法创建对象"
- 在 VBA 编辑器中，`工具 → 引用 → 勾选 Microsoft ActiveX Data Objects 6.x Library`

### Q: 列号不对
- VBA 会弹出窗口让你输入实际订货数量所在列
- 也可以直接在代码中修改 `colQty = "X"` 为你的实际列

### Q: 如何修改商品编码列？
- 在代码中找到 `colCode = "A"`，修改为你的实际列

## 安全提示

- 密码明文保存在 VBA 代码中，有泄露风险
- 生产环境建议使用 Windows 身份验证或加密存储
- 建议创建一个只允许写入该表的数据库用户
