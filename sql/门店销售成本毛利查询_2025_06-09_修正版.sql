-- ============================================================
-- 2025年6-9月各门店销售金额、成本金额、毛利查询（最终修正版）
-- 使用 vSaleSumDetail 视图，处理负数问题
-- ============================================================

-- 方案一：取绝对值（推荐）
SELECT 
    vs.FullName AS 门店名称,
    DATEPART(YEAR, vsd.BillDate) AS 年份,
    DATEPART(MONTH, vsd.BillDate) AS 月份,
    ISNULL(SUM(ABS(vsd.total)), 0) AS 销售金额,
    ISNULL(SUM(ABS(vsd.costtotal)), 0) AS 成本金额,
    ISNULL(SUM(ABS(vsd.total) - ABS(vsd.costtotal)), 0) AS 毛利,
    ISNULL(SUM(ABS(vsd.qty)), 0) AS 销售数量
FROM ZHYYLS.dbo.vSaleSumDetail vsd
INNER JOIN ZHYYLS.dbo.Vstock vs ON vsd.KRec = vs.Rec
WHERE 
    vsd.BillDate BETWEEN '2025-06-01' AND '2025-09-30'
    AND vs.Rec IN ('3','4','5','6','7','8','9','10','11','13','36','50','63','66')
GROUP BY 
    vs.FullName,
    DATEPART(YEAR, vsd.BillDate),
    DATEPART(MONTH, vsd.BillDate)
ORDER BY 
    vs.FullName,
    年份,
    月份;

-- ============================================================
-- 方案二：乘以 -1 反转（如果确认是反向记录）
-- ============================================================
/*
SELECT 
    vs.FullName AS 门店名称,
    DATEPART(YEAR, vsd.BillDate) AS 年份,
    DATEPART(MONTH, vsd.BillDate) AS 月份,
    ISNULL(SUM(vsd.total * -1), 0) AS 销售金额,
    ISNULL(SUM(vsd.costtotal * -1), 0) AS 成本金额,
    ISNULL(SUM((vsd.total - vsd.costtotal) * -1), 0) AS 毛利,
    ISNULL(SUM(vsd.qty * -1), 0) AS 销售数量
FROM ZHYYLS.dbo.vSaleSumDetail vsd
INNER JOIN ZHYYLS.dbo.Vstock vs ON vsd.KRec = vs.Rec
WHERE 
    vsd.BillDate BETWEEN '2025-06-01' AND '2025-09-30'
    AND vs.Rec IN ('3','4','5','6','7','8','9','10','11','13','36','50','63','66')
GROUP BY 
    vs.FullName,
    DATEPART(YEAR, vsd.BillDate),
    DATEPART(MONTH, vsd.BillDate)
ORDER BY 
    vs.FullName,
    年份,
    月份;
*/
