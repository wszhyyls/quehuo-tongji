-- =====================================================
-- 修复：usp_AutoDetectOrderStatus_Feedback
-- 1. 改用 SPFXB_Result（实时数据）
-- 2. 支持状态闭环：已订购 → 配货中 → 已完成
-- =====================================================
-- 执行方式：SSMS → RQZT 库 → 粘贴执行
-- =====================================================

USE RQZT;
GO

-- 覆盖原有存储过程
ALTER PROCEDURE [dbo].[usp_AutoDetectOrderStatus_Feedback]
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @配货中Count INT = 0, @已完成Count INT = 0;

    -- ===== 步骤1：已订购 / 配货中 → 已完成（门店库存达标）=====
    UPDATE f
    SET f.补货状态 = '已完成',
        f.到货确认时间 = GETDATE(),
        f.备注 = ISNULL(f.备注, '') + ' | 自动检测完成 ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
    FROM dbo.Shortage_OrderFeedback f
    INNER JOIN (
        SELECT 商品编码, SUM(ISNULL(库存数量, 0)) AS 总库存, MAX(ISNULL(标准库存数量, 0)) AS 标准库存
        FROM dbo.SPFXB_Result WITH (NOLOCK)
        GROUP BY 商品编码
    ) r ON f.商品编码 = r.商品编码
    WHERE f.补货状态 IN ('已订购', '配货中')
      AND r.总库存 >= r.标准库存 AND r.标准库存 > 0;

    SET @已完成Count = @@ROWCOUNT;

    -- ===== 步骤2：已订购 → 配货中（有在途数据）=====
    UPDATE f
    SET f.补货状态 = '配货中',
        f.备注 = ISNULL(f.备注, '') + ' | 自动检测配货 ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
    FROM dbo.Shortage_OrderFeedback f
    INNER JOIN (
        SELECT 商品编码, SUM(ISNULL(在途数量, 0)) AS 总在途
        FROM dbo.SPFXB_Result WITH (NOLOCK)
        GROUP BY 商品编码
    ) r ON f.商品编码 = r.商品编码
    WHERE f.补货状态 = '已订购'
      AND r.总在途 > 0;

    SET @配货中Count = @@ROWCOUNT;

    SELECT 已完成 = @已完成Count, 配货中 = @配货中Count, 操作 = '自动检测状态完成（基于SPFXB_Result）';
END
GO

PRINT '>>> usp_AutoDetectOrderStatus_Feedback 已修复';
PRINT '>>> 状态流：待处理 → 已订购 → 配货中（在途>0）→ 已完成（库存达标）';
GO
