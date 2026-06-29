-- ========================================
-- 采购对账记录功能 - SQL Server 数据表
-- 数据库: RQZT (现有业务库)
-- 版本: v3.19.0
-- ========================================

-- 采购记录主表
IF NOT EXISTS (SELECT * FROM sys.objects WHERE name = 'ProcurementRecords' AND type = 'U')
BEGIN
    CREATE TABLE ProcurementRecords (
        -- 与Excel字段1:1匹配的19个业务字段
        日期 DATE NULL,                          -- 采购日期
        供货商全名 NVARCHAR(255) NULL,            -- 供货商全名
        简称 NVARCHAR(100) NULL,                 -- 供货商简称
        订货方式 NVARCHAR(50) NULL,              -- 订货方式（待付款/已订购/配货中/已到货）
        付款方式 NVARCHAR(100) NULL,              -- 付款方式
        订货人 NVARCHAR(50) NULL,                -- 订货人
        订货金额 DECIMAL(18,2) NULL,             -- 订货金额
        入库日期 DATE NULL,                      -- 入库日期
        入库金额 DECIMAL(18,2) NULL,             -- 入库金额
        入库人 NVARCHAR(50) NULL,                -- 入库人
        付款人 NVARCHAR(50) NULL,                -- 付款人
        付款记录 NVARCHAR(50) NULL,              -- 付款记录（未付款/已付款/部分付款）
        付款日期 DATE NULL,                      -- 付款日期
        财务入库记账 NVARCHAR(100) NULL,          -- 财务入库记账状态
        财务付款记账 NVARCHAR(100) NULL,          -- 财务付款记账状态
        记账日期 DATE NULL,                      -- 记账日期
        备注 NVARCHAR(MAX) NULL,                 -- 备注
        千方系统 NVARCHAR(100) NULL,             -- 千方系统
        是否开具发票 NVARCHAR(50) NULL,           -- 是否开具发票（是/否/待开具）

        -- 审计字段
        对账状态 NVARCHAR(20) DEFAULT N'未对账',  -- 对账状态（未对账/已对账）
        对账人 NVARCHAR(50) NULL,                -- 最后对账人
        对账时间 DATETIME NULL,                  -- 最后对账时间
        操作人 NVARCHAR(50) NULL,                -- 创建/编辑人
        创建时间 DATETIME DEFAULT GETDATE(),     -- 创建时间
        更新时间 DATETIME DEFAULT GETDATE(),     -- 更新时间

        -- 系统字段
        Id INT IDENTITY(1,1) PRIMARY KEY         -- 自增主键
    );

    -- 索引：加速按日期查询
    CREATE INDEX IX_ProcurementRecords_日期 ON ProcurementRecords(日期 DESC);
    -- 索引：加速按供货商查询
    CREATE INDEX IX_ProcurementRecords_供货商 ON ProcurementRecords(供货商全名);
    -- 索引：加速按对账状态查询
    CREATE INDEX IX_ProcurementRecords_对账状态 ON ProcurementRecords(对账状态);
END;

-- 采购对账操作日志表
IF NOT EXISTS (SELECT * FROM sys.objects WHERE name = 'ProcurementAuditLog' AND type = 'U')
BEGIN
    CREATE TABLE ProcurementAuditLog (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        RecordId INT NULL,                        -- 关联的记录ID
        操作类型 NVARCHAR(50) NOT NULL,           -- 创建/编辑/删除/对账/导入/导出
        操作人 NVARCHAR(50) NOT NULL,             -- 操作人
        操作时间 DATETIME DEFAULT GETDATE(),      -- 操作时间
        修改前 NVARCHAR(MAX) NULL,                -- 修改前数据（JSON格式）
        修改后 NVARCHAR(MAX) NULL,                -- 修改后数据（JSON格式）
        备注 NVARCHAR(500) NULL                   -- 额外备注
    );

    CREATE INDEX IX_ProcurementAuditLog_时间 ON ProcurementAuditLog(操作时间 DESC);
    CREATE INDEX IX_ProcurementAuditLog_RecordId ON ProcurementAuditLog(RecordId);
END;

PRINT '采购对账记录表创建完成';
