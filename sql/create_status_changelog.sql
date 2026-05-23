-- ==========================================
-- 状态变更日志表（记录每次状态变更的历史轨迹）
-- 创建时间：2026-05-23
-- ==========================================

IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = 'StatusChangeLog' AND type = 'U')
BEGIN
    CREATE TABLE dbo.StatusChangeLog (
        id INT IDENTITY(1,1) PRIMARY KEY,
        商品编码 NVARCHAR(50) NOT NULL,
        原状态 NVARCHAR(20),
        新状态 NVARCHAR(20) NOT NULL,
        操作人 NVARCHAR(50),
        备注 NVARCHAR(200),
        变更时间 DATETIME NOT NULL DEFAULT GETDATE(),
        INDEX IX_StatusChangeLog_商品编码 (商品编码),
        INDEX IX_StatusChangeLog_变更时间 (变更时间 DESC)
    );
    
    PRINT '✅ StatusChangeLog 表创建成功';
END
ELSE
BEGIN
    PRINT '⚠️  StatusChangeLog 表已存在，跳过创建';
END
