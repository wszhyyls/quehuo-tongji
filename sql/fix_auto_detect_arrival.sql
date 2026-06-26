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

    DECLARE @仓库完成Count INT = 0, @库存完成Count INT = 0;

    -- ===== 步骤1（优先）：仓库库存>0 → 已完成 =====
    -- 排除手工标记：待付款、厂家断货 不自动覆盖
    UPDATE f
    SET f.补货状态 = '已完成',
        f.到货确认时间 = GETDATE(),
        f.备注 = ISNULL(f.备注, '') + ' | 自动完成(仓库有货) ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
    FROM dbo.Shortage_OrderFeedback f
    INNER JOIN (
        SELECT 商品编码, SUM(ISNULL(配送中心库存数量, 0)) AS 仓库库存
        FROM dbo.SPFXB_Result WITH (NOLOCK)
        GROUP BY 商品编码
    ) r ON f.商品编码 = r.商品编码
    WHERE f.补货状态 NOT IN ('已完成', '待付款', '厂家断货')
      AND r.仓库库存 > 0;

    SET @仓库完成Count = @@ROWCOUNT;

    -- ===== 步骤2：门店库存≥实际订货数量 OR 在途≥实际订货数量 → 已完成 =====
    -- 排除在步骤1已完成的和手工标记状态
    UPDATE f
    SET f.补货状态 = '已完成',
        f.到货确认时间 = GETDATE(),
        f.备注 = ISNULL(f.备注, '') + ' | 自动完成(库存/在途满足) ' + CONVERT(NVARCHAR(16), GETDATE(), 120)
    FROM dbo.Shortage_OrderFeedback f
    INNER JOIN (
        SELECT 
            商品编码, 
            SUM(ISNULL(库存数量, 0)) AS 总库存, 
            SUM(ISNULL(在途数量, 0)) AS 总在途
        FROM dbo.SPFXB_Result WITH (NOLOCK)
        GROUP BY 商品编码
    ) r ON f.商品编码 = r.商品编码
    WHERE f.补货状态 NOT IN ('已完成', '待付款', '厂家断货')
      AND f.实际订货数量 > 0
      AND (r.总库存 >= f.实际订货数量 OR r.总在途 >= f.实际订货数量);

    SET @库存完成Count = @@ROWCOUNT;

    SELECT 仓库完成 = @仓库完成Count, 库存完成 = @库存完成Count, 操作 = '自动检测状态完成(v4.0)';
END
GO

PRINT '>>> usp_AutoDetectOrderStatus_Feedback 已修复(v4.0)';
PRINT '>>> 状态流：待处理 → 已订购（VBA上传订货）→ 已完成（仓库有货 OR 库存/在途满足）';
PRINT '>>> 已移除 配货中、已到货 状态';
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
