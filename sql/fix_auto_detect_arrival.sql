-- =====================================================
-- 修复：usp_AutoDetectOrderStatus_Feedback
-- 1. 改用 SPFXB_Result（实时数据）
-- 2. 支持状态闭环：已订购 → 配货中 → 已完成
-- 3. 【关键】已到货状态也能自动修正
-- =====================================================
-- 执行方式：SSMS → RQZT 库 → 粘贴执行
-- =====================================================

USE RQZT;
GO

-- 覆盖原有存储过程（v4.0 简化状态流：待处理 → 已订购 → 已完成）
ALTER PROCEDURE [dbo].[usp_AutoDetectOrderStatus_Feedback]
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @已完成Count INT = 0, @已到货Count INT = 0;

    -- ===== 步骤1（优先）：已在配送中(在途>0)或门店有库存 → 已完成 =====
    -- 仅厂家断货不自动覆盖
    UPDATE f
    SET f.补货状态 = '已完成',
        f.到货确认时间 = GETDATE(),
        f.备注 = ISNULL(f.备注, '') + ' | 自动完成(已在途或门店有货) ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
    FROM dbo.Shortage_OrderFeedback f
    INNER JOIN (
        SELECT 
            商品编码, 
            SUM(ISNULL(库存数量, 0)) AS 总库存, 
            SUM(ISNULL(在途数量, 0)) AS 总在途
        FROM dbo.SPFXB_Result WITH (NOLOCK)
        GROUP BY 商品编码
    ) r ON f.商品编码 = r.商品编码
    WHERE f.补货状态 NOT IN ('已完成', '已到货', '厂家断货')
      AND (r.总在途 > 0 OR r.总库存 > 0);
    SET @已完成Count = @@ROWCOUNT;

    -- ===== 步骤2：仓库有货但未配送 → 已到货 =====
    -- 提醒采购员：货到了仓库，需要安排配送到门店
    UPDATE f
    SET f.补货状态 = '已到货',
        f.到货确认时间 = GETDATE(),
        f.备注 = ISNULL(f.备注, '') + ' | 自动到货(仓库有货待配送) ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
    FROM dbo.Shortage_OrderFeedback f
    INNER JOIN (
        SELECT 商品编码, SUM(ISNULL(配送中心库存数量, 0)) AS 仓库库存
        FROM dbo.SPFXB_Result WITH (NOLOCK)
        GROUP BY 商品编码
    ) r ON f.商品编码 = r.商品编码
    WHERE f.补货状态 NOT IN ('已完成', '已到货', '厂家断货')
      AND r.仓库库存 > 0;
    SET @已到货Count = @@ROWCOUNT;

    SELECT 已完成 = @已完成Count, 已到货 = @已到货Count, 操作 = '自动检测状态完成(v4.2)';
END
GO

PRINT '>>> usp_AutoDetectOrderStatus_Feedback 已修复(v4.2)';
PRINT '>>> 状态流：待处理 → 已订购 → 已到货(仓库有货待配送) → 已完成(在途/门店有货)';
PRINT '>>> 仅保留厂家断货为人工保护状态';
GO

-- =====================================================
-- 诊断查询：检查问题商品在 SPFXB_Result 中的数据
-- =====================================================
PRINT '---';
PRINT '>>> 诊断：检查 SPFXB_Result 中指定商品的数据';
GO

SELECT 商品编码, 门店名称, 库存数量, 在途数量, 标准库存数量
FROM dbo.SPFXB_Result WITH (NOLOCK)
WHERE 商品编码 IN ('1090071', '2030191')
ORDER BY 商品编码, 门店名称;
GO

-- =====================================================
-- 诊断查询：检查 Feedback 表当前状态
-- =====================================================
PRINT '---';
PRINT '>>> 诊断：检查 Shortage_OrderFeedback 中指定商品的状态';
GO

SELECT 商品编码, 补货状态, 实际订货数量, 订货时间, 备注
FROM dbo.Shortage_OrderFeedback WITH (NOLOCK)
WHERE 商品编码 IN ('1090071', '2030191')
ORDER BY 商品编码;
GO

-- =====================================================
-- 手动执行一次状态检测（立即看结果）
-- =====================================================
PRINT '---';
PRINT '>>> 手动执行一次自动检测，立即看效果';
GO

EXEC dbo.usp_AutoDetectOrderStatus_Feedback;
GO

-- =====================================================
-- 再次检查状态
-- =====================================================
PRINT '---';
PRINT '>>> 检测后状态：';
GO

SELECT 商品编码, 补货状态, 实际订货数量, 订货时间, 备注
FROM dbo.Shortage_OrderFeedback WITH (NOLOCK)
WHERE 商品编码 IN ('1090071', '2030191')
ORDER BY 商品编码;
GO

PRINT '---';
PRINT '>>> 检测完成！';
PRINT '>>> 新规则：仓库库存>0 → 已完成；库存/在途≥订货量 → 已完成';
PRINT '>>> 请在管理后台点「同步采购计划」按钮刷新页面。';
GO
