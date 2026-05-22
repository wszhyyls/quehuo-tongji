-- =====================================================
-- 修复：usp_AutoDetectOrderStatus_Feedback 改用 SPFXB_Result
-- 原因：原来查 Shortage_StoreStockCache（基本不更新），
--       必须查 SPFXB_Result（门店刷新后实时更新）
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

    -- 方案：配送中心有库存 OR 任一门店库存 >= 标准库存 → 标记已订购商品已到货
    UPDATE f
    SET f.补货状态 = '已到货',
        f.到货确认时间 = GETDATE(),
        f.备注 = ISNULL(f.备注, '') + ' | 自动检测到货 ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
    FROM dbo.Shortage_OrderFeedback f
    INNER JOIN (
        -- 每个商品汇总所有门店的库存
        SELECT 
            商品编码,
            MAX(ISNULL(配送中心库存数量, 0)) AS 配送中心库存,
            SUM(ISNULL(库存数量, 0)) AS 总库存,
            MAX(ISNULL(标准库存数量, 0)) AS 标准库存
        FROM dbo.SPFXB_Result WITH (NOLOCK)
        GROUP BY 商品编码
    ) r ON f.商品编码 = r.商品编码
    WHERE f.补货状态 = '已订购'
      AND (
          -- 配送中心已经收到货
          r.配送中心库存 > 0
          OR
          -- 门店库存已经达到标准库存水平（说明已配送到店）
          (r.总库存 >= r.标准库存 AND r.标准库存 > 0)
      );

    SELECT 处理数量 = @@ROWCOUNT, 操作 = '自动检测到货完成（基于SPFXB_Result）';
END
GO

PRINT '>>> usp_AutoDetectOrderStatus_Feedback 已修复，现在从 SPFXB_Result 检测到货';
GO
