-- ============================================
-- v5.8.3 修复: 备注字段超长导致设置订货数量失败
-- 问题: SP 每次更新都追加备注,累计超过 NVARCHAR(200) 时报错
-- 修复: SP 中用 LEFT 截断到 200 字符
-- 同时清理现有超长的备注数据
-- ============================================

-- 清理超长备注
UPDATE dbo.Shortage_OrderFeedback
SET 备注 = LEFT(ISNULL(备注, ''), 200)
WHERE LEN(ISNULL(备注, '')) > 200;

-- 重建 SP（用 LEFT 截断）
ALTER PROCEDURE [dbo].[usp_UpdateActualOrder]
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
        SELECT 商品编码 = @商品编码, 结果 = '已取消订货', 补货状态 = '待处理';
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码)
    BEGIN
        IF @当前状态 IN ('已完成', '已到货')
        BEGIN
            UPDATE dbo.Shortage_OrderFeedback
            SET 实际订货数量 = @实际订货数量,
                操作人 = @操作人,
                备注 = LEFT(ISNULL(备注, '') + ' | 更新订货(已完成):' + CAST(@实际订货数量 AS NVARCHAR) + ' ' + CONVERT(NVARCHAR(16), GETDATE(), 120), 200)
            WHERE 商品编码 = @商品编码;
            SELECT 商品编码 = @商品编码, 结果 = '订货更新(已完成)', 补货状态 = '已完成', 实际订货数量 = @实际订货数量;
        END
        ELSE
        BEGIN
            UPDATE dbo.Shortage_OrderFeedback
            SET 实际订货数量 = @实际订货数量,
                补货状态 = '已订购',
                订货时间 = GETDATE(),
                操作人 = @操作人,
                到货确认时间 = NULL,
                备注 = LEFT(ISNULL(备注, '') + ' | 更新订货:' + CAST(@实际订货数量 AS NVARCHAR) + ' ' + CONVERT(NVARCHAR(16), GETDATE(), 120), 200)
            WHERE 商品编码 = @商品编码;
            SELECT 商品编码 = @商品编码, 结果 = '订货成功', 补货状态 = '已订购', 实际订货数量 = @实际订货数量;
        END
    END
    ELSE
    BEGIN
        INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 操作人)
        VALUES (@商品编码, @实际订货数量, '已订购', GETDATE(), @操作人);
        SELECT 商品编码 = @商品编码, 结果 = '订货成功', 补货状态 = '已订购', 实际订货数量 = @实际订货数量;
    END
END
GO

PRINT '>>> usp_UpdateActualOrder 修复完成 (v5.8.3 LEFT 截断备注)';
