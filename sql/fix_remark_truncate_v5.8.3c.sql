-- ============================================
-- v5.8.3 修复: 备注超长导致订货失败
-- 策略: DROP + CREATE 重写 SP,每次只保留最新备注
-- ============================================

-- 清理超长备注
UPDATE dbo.Shortage_OrderFeedback
SET 备注 = LEFT(ISNULL(备注, ''), 200)
WHERE LEN(ISNULL(备注, '')) > 200;
GO

-- 先删除旧 SP
IF OBJECT_ID(N'dbo.usp_UpdateActualOrder', N'P') IS NOT NULL
    DROP PROCEDURE dbo.usp_UpdateActualOrder;
GO

-- 重建 SP（每次只保留最新备注,不再追加历史）
CREATE PROCEDURE [dbo].[usp_UpdateActualOrder]
    @商品编码           NVARCHAR(50),
    @实际订货数量       INT = 0,
    @操作人             NVARCHAR(50) = 'VBA'
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @当前状态 NVARCHAR(20);
    SELECT @当前状态 = 补货状态 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码;

    IF @实际订货数量 <= 0
    BEGIN
        DELETE FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码;
        SELECT 商品编码 = @商品编码, 结果 = N'已取消订货', 补货状态 = N'待处理';
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码)
    BEGIN
        IF @当前状态 IN (N'已完成', N'已到货')
        BEGIN
            UPDATE dbo.Shortage_OrderFeedback
            SET 实际订货数量 = @实际订货数量,
                操作人 = @操作人,
                备注 = N'更新订货(已完成):' + CAST(@实际订货数量 AS NVARCHAR(20)) + N' ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
            WHERE 商品编码 = @商品编码;
            SELECT 商品编码 = @商品编码, 结果 = N'订货更新(已完成)', 补货状态 = N'已完成', 实际订货数量 = @实际订货数量;
        END
        ELSE
        BEGIN
            UPDATE dbo.Shortage_OrderFeedback
            SET 实际订货数量 = @实际订货数量,
                补货状态 = N'已订购',
                订货时间 = GETDATE(),
                操作人 = @操作人,
                到货确认时间 = NULL,
                备注 = N'更新订货:' + CAST(@实际订货数量 AS NVARCHAR(20)) + N' ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
            WHERE 商品编码 = @商品编码;
            SELECT 商品编码 = @商品编码, 结果 = N'订货成功', 补货状态 = N'已订购', 实际订货数量 = @实际订货数量;
        END
    END
    ELSE
    BEGIN
        INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 操作人)
        VALUES (@商品编码, @实际订货数量, N'已订购', GETDATE(), @操作人);
        SELECT 商品编码 = @商品编码, 结果 = N'订货成功', 补货状态 = N'已订购', 实际订货数量 = @实际订货数量;
    END
END
GO

PRINT '>>> usp_UpdateActualOrder 修复完成 (v5.8.3)';
