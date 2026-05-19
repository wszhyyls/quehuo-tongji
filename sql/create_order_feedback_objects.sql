-- =====================================================
-- RQZT 数据库 - 订货反馈体系完整创建脚本
-- 作用：支持 VBA 回写实际订货数量，跟踪订货状态
-- 执行前请确认已在 RQZT 数据库中
-- =====================================================

USE RQZT;
GO

-- =====================================================
-- 0. 清理旧对象（如果存在）
-- =====================================================
IF OBJECT_ID('dbo.usp_AutoDetectOrderStatus_Feedback', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_AutoDetectOrderStatus_Feedback;
GO

IF OBJECT_ID('dbo.usp_GetPurchasePlanWithFeedback', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_GetPurchasePlanWithFeedback;
GO

IF OBJECT_ID('dbo.usp_ConfirmArrival', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_ConfirmArrival;
GO

IF OBJECT_ID('dbo.usp_UpdateActualOrderStatus', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_UpdateActualOrderStatus;
GO

IF OBJECT_ID('dbo.usp_UpdateActualOrder', 'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_UpdateActualOrder;
GO

IF OBJECT_ID('dbo.Shortage_OrderFeedback', 'U') IS NOT NULL
    DROP TABLE dbo.Shortage_OrderFeedback;
GO

-- =====================================================
-- 1. 创建订货反馈表 Shortage_OrderFeedback
-- 作用：存放 VBA 回写的实际订货数量及状态
-- =====================================================
CREATE TABLE dbo.Shortage_OrderFeedback (
    序号                INT IDENTITY(1,1),
    商品编码            NVARCHAR(50) NOT NULL,
    实际订货数量        INT DEFAULT 0,
    补货状态            NVARCHAR(20) DEFAULT '待处理',  -- 待处理 / 已订购 / 已到货
    订货时间            DATETIME DEFAULT GETDATE(),
    到货确认时间        DATETIME NULL,
    操作人              NVARCHAR(50) DEFAULT 'VBA',
    备注                NVARCHAR(200) NULL,
    同步标记            BIT DEFAULT 0,
    最后同步时间        DATETIME NULL,
    CONSTRAINT PK_OrderFeedback PRIMARY KEY (商品编码)
);
GO

CREATE INDEX IX_OrderFeedback_Status ON dbo.Shortage_OrderFeedback(补货状态);
CREATE INDEX IX_OrderFeedback_Time ON dbo.Shortage_OrderFeedback(订货时间 DESC);
GO

PRINT '>>> Shortage_OrderFeedback 表创建完成';
GO

-- =====================================================
-- 2. 存储过程：usp_UpdateActualOrder
-- 作用：VBA 写入实际订货数量，自动改为"已订购"状态
-- =====================================================
CREATE PROCEDURE [dbo].[usp_UpdateActualOrder]
    @商品编码           NVARCHAR(50),
    @实际订货数量       INT = 0,
    @操作人             NVARCHAR(50) = 'VBA'
AS
BEGIN
    SET NOCOUNT ON;

    IF @实际订货数量 <= 0
    BEGIN
        -- 数量为0则删除记录（相当于取消订货）
        DELETE FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码;
        SELECT 商品编码 = @商品编码, 结果 = '已取消订货', 补货状态 = '待处理';
        RETURN;
    END

    -- 检查是否已有记录
    IF EXISTS (SELECT 1 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码)
    BEGIN
        UPDATE dbo.Shortage_OrderFeedback
        SET 实际订货数量 = @实际订货数量,
            补货状态 = '已订购',
            订货时间 = GETDATE(),
            操作人 = @操作人,
            到货确认时间 = NULL,
            备注 = ISNULL(备注, '') + ' | 更新订货:' + CAST(@实际订货数量 AS NVARCHAR) + ' ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
        WHERE 商品编码 = @商品编码;
    END
    ELSE
    BEGIN
        INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 操作人)
        VALUES (@商品编码, @实际订货数量, '已订购', GETDATE(), @操作人);
    END

    SELECT 商品编码 = @商品编码, 结果 = '订货成功', 补货状态 = '已订购', 实际订货数量 = @实际订货数量;
END
GO

PRINT '>>> usp_UpdateActualOrder 创建完成';
GO

-- =====================================================
-- 3. 存储过程：usp_ConfirmArrival
-- 作用：手动标记商品已到货（VBA 或后台调用）
-- =====================================================
CREATE PROCEDURE [dbo].[usp_ConfirmArrival]
    @商品编码   NVARCHAR(50),
    @操作人     NVARCHAR(50) = '管理员'
AS
BEGIN
    SET NOCOUNT ON;

    IF NOT EXISTS (SELECT 1 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码)
    BEGIN
        SELECT 商品编码 = @商品编码, 结果 = '未找到订货记录';
        RETURN;
    END

    UPDATE dbo.Shortage_OrderFeedback
    SET 补货状态 = '已到货',
        到货确认时间 = GETDATE(),
        操作人 = @操作人,
        备注 = ISNULL(备注, '') + ' | 确认到货 ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
    WHERE 商品编码 = @商品编码;

    SELECT 商品编码 = @商品编码, 结果 = '已确认到货', 补货状态 = '已到货';
END
GO

PRINT '>>> usp_ConfirmArrival 创建完成';
GO

-- =====================================================
-- 4. 存储过程：usp_UpdateActualOrderStatus
-- 作用：手工强制修改补货状态（后台管理员调用）
-- =====================================================
CREATE PROCEDURE [dbo].[usp_UpdateActualOrderStatus]
    @商品编码   NVARCHAR(50),
    @目标状态   NVARCHAR(20),  -- '待处理' / '已订购' / '已到货'
    @操作人     NVARCHAR(50) = '管理员',
    @备注       NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @有效状态 NVARCHAR(20);
    SET @目标状态 = LTRIM(RTRIM(@目标状态));
    
    IF @目标状态 NOT IN ('待处理', '已订购', '已到货')
    BEGIN
        SELECT 商品编码 = @商品编码, 结果 = '无效状态，必须是：待处理/已订购/已到货';
        RETURN;
    END

    IF NOT EXISTS (SELECT 1 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码)
    BEGIN
        INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 操作人, 备注)
        VALUES (@商品编码, 0, @目标状态, GETDATE(), @操作人, ISNULL(@备注, '手工创建'));
    END
    ELSE
    BEGIN
        UPDATE dbo.Shortage_OrderFeedback
        SET 补货状态 = @目标状态,
            操作人 = @操作人,
            备注 = ISNULL(备注, '') + ' | 状态变更:' + @目标状态 + ' ' + CONVERT(NVARCHAR(16), GETDATE(), 120) + ISNULL(' ' + @备注, '')
        WHERE 商品编码 = @商品编码;
    END

    SELECT 商品编码 = @商品编码, 结果 = '状态已更新', 补货状态 = @目标状态;
END
GO

PRINT '>>> usp_UpdateActualOrderStatus 创建完成';
GO

-- =====================================================
-- 5. 存储过程：usp_AutoDetectOrderStatus_Feedback
-- 作用：自动检测库存变化，将已订货商品标记为已到货
-- =====================================================
CREATE PROCEDURE [dbo].[usp_AutoDetectOrderStatus_Feedback]
AS
BEGIN
    SET NOCOUNT ON;

    -- 找出已订购且门店库存 >= 标准库存的商品，标记为已到货
    UPDATE f
    SET f.补货状态 = '已到货',
        f.到货确认时间 = GETDATE(),
        f.备注 = ISNULL(f.备注, '') + ' | 自动检测到货 ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
    FROM dbo.Shortage_OrderFeedback f
    INNER JOIN dbo.Shortage_StoreStockCache s ON f.商品编码 = s.商品编码
    WHERE f.补货状态 = '已订购'
      AND s.库存数量 >= ISNULL(s.标准库存数量, 0)
      AND s.标准库存数量 > 0;

    SELECT 处理数量 = @@ROWCOUNT, 操作 = '自动检测到货完成';
END
GO

PRINT '>>> usp_AutoDetectOrderStatus_Feedback 创建完成';
GO

-- =====================================================
-- 6. 存储过程：usp_GetPurchasePlanWithFeedback
-- 作用：查询采购计划（含订货状态反馈）
-- 参数：@关键字=商品编码/名称匹配, @状态筛选=待处理/已订购/已到货, @仅缺货=1只显示缺货, @Top=返回条数
-- =====================================================
CREATE PROCEDURE [dbo].[usp_GetPurchasePlanWithFeedback]
    @关键字       NVARCHAR(50) = NULL,
    @状态筛选     NVARCHAR(20) = NULL,
    @仅缺货       BIT = 1,
    @Top          INT = 500
AS
BEGIN
    SET NOCOUNT ON;

    SELECT TOP (@Top)
        p.商品编码,
        p.商品名称,
        p.规格,
        p.生产企业,
        p.仓库库存数量,
        p.标准库存汇总,
        p.门店库存汇总,
        p.在途汇总,
        p.可调拨数量,
        p.建议订货数量,
        ISNULL(f.实际订货数量, 0) AS 实际订货数量,
        ISNULL(f.补货状态, '待处理') AS 补货状态,
        f.订货时间,
        f.到货确认时间,
        f.操作人,
        CASE
            WHEN f.补货状态 = '已到货' THEN '已到货'
            WHEN f.补货状态 = '已订购' THEN '已订购'
            WHEN p.建议订货数量 > 0 THEN '待处理'
            ELSE '库存充足'
        END AS 状态显示
    FROM dbo.Shortage_PurchasePlanCache p WITH (NOLOCK)
    LEFT JOIN dbo.Shortage_OrderFeedback f WITH (NOLOCK) ON p.商品编码 = f.商品编码
    WHERE (@关键字 IS NULL OR p.商品编码 LIKE '%' + @关键字 + '%' OR p.商品名称 LIKE '%' + @关键字 + '%')
      AND (@状态筛选 IS NULL OR ISNULL(f.补货状态, '待处理') = @状态筛选)
      AND (@仅缺货 = 0 OR p.建议订货数量 > 0 OR f.补货状态 IN ('已订购', '已到货'))
    ORDER BY p.建议订货数量 DESC, p.商品编码;
END
GO

PRINT '>>> usp_GetPurchasePlanWithFeedback 创建完成';
GO

-- =====================================================
-- 7. 完成提示
-- =====================================================
PRINT '';
PRINT '========================================';
PRINT '=== RQZT 订货反馈体系创建完成 ===';
PRINT '========================================';
PRINT '';
PRINT '已创建对象：';
PRINT '  1. 表: Shortage_OrderFeedback';
PRINT '  2. 存储过程: usp_UpdateActualOrder (VBA写入订货数量)';
PRINT '  3. 存储过程: usp_ConfirmArrival (手动确认到货)';
PRINT '  4. 存储过程: usp_UpdateActualOrderStatus (手工改状态)';
PRINT '  5. 存储过程: usp_AutoDetectOrderStatus_Feedback (自动检测到货)';
PRINT '  6. 存储过程: usp_GetPurchasePlanWithFeedback (查询采购计划含状态)';
PRINT '';
PRINT 'VBA 使用示例：';
PRINT '  EXEC usp_UpdateActualOrder @商品编码=''123456'', @实际订货数量=100, @操作人=''管理员''';
PRINT '';
GO
