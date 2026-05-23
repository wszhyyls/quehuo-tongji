-- ============================================================
-- 缺货统计系统 - 2025年6-9月各门店销售金额、成本金额、毛利查询
-- 与ERP系统数据匹配版本
-- 按门店、按月统计
-- ============================================================

-- ============================================================
-- 查询1：按门店汇总（与ERP系统展示一致）
-- ============================================================
SELECT 
    vs.Rec AS 门店编号,
    vs.FullName AS 门店名称,
    ROUND(ABS(SUM(vsd.total)), 2) AS 价税合计,
    ROUND(ABS(SUM(vsd.costtotal)), 2) AS 销售成本合计,
    ROUND(ABS(SUM(vsd.total - vsd.costtotal)), 2) AS 利润额,
    CAST(ABS(SUM(vsd.qty)) AS INT) AS 销售数量
FROM ZHYYLS.dbo.vSaleSumDetail vsd
INNER JOIN ZHYYLS.dbo.Vstock vs ON vsd.KRec = vs.Rec
WHERE 
    vsd.BillDate BETWEEN '2025-06-01' AND '2025-09-30'
    AND vs.Rec IN ('3','4','5','6','7','8','9','10','11','13','36','50','63','66')
GROUP BY 
    vs.Rec,
    vs.FullName
ORDER BY 
    vs.Rec;

-- ============================================================
-- 查询2：按月+门店汇总
-- ============================================================
SELECT 
    DATEPART(YEAR, vsd.BillDate) AS 年份,
    DATEPART(MONTH, vsd.BillDate) AS 月份,
    vs.Rec AS 门店编号,
    vs.FullName AS 门店名称,
    ROUND(ABS(SUM(vsd.total)), 2) AS 价税合计,
    ROUND(ABS(SUM(vsd.costtotal)), 2) AS 销售成本合计,
    ROUND(ABS(SUM(vsd.total - vsd.costtotal)), 2) AS 利润额,
    CAST(ABS(SUM(vsd.qty)) AS INT) AS 销售数量
FROM ZHYYLS.dbo.vSaleSumDetail vsd
INNER JOIN ZHYYLS.dbo.Vstock vs ON vsd.KRec = vs.Rec
WHERE 
    vsd.BillDate BETWEEN '2025-06-01' AND '2025-09-30'
    AND vs.Rec IN ('3','4','5','6','7','8','9','10','11','13','36','50','63','66')
GROUP BY 
    DATEPART(YEAR, vsd.BillDate),
    DATEPART(MONTH, vsd.BillDate),
    vs.Rec,
    vs.FullName
ORDER BY 
    年份,
    月份,
    vs.Rec;

-- ============================================================
-- 查询3：按门店+职员汇总
-- ============================================================
SELECT 
    vs.Rec AS 门店编号,
    vs.FullName AS 门店名称,
    ve.Rec AS 职员编号,
    ve.FullName AS 职员姓名,
    ROUND(ABS(SUM(vsd.total)), 2) AS 价税合计,
    ROUND(ABS(SUM(vsd.costtotal)), 2) AS 销售成本合计,
    ROUND(ABS(SUM(vsd.total - vsd.costtotal)), 2) AS 利润额,
    CAST(ABS(SUM(vsd.qty)) AS INT) AS 销售数量
FROM ZHYYLS.dbo.vSaleSumDetail vsd
INNER JOIN ZHYYLS.dbo.Vstock vs ON vsd.KRec = vs.Rec
LEFT JOIN ZHYYLS.dbo.vBEmployee ve ON vsd.ERec = ve.Rec
WHERE 
    vsd.BillDate BETWEEN '2025-06-01' AND '2025-09-30'
    AND vs.Rec IN ('3','4','5','6','7','8','9','10','11','13','36','50','63','66')
GROUP BY 
    vs.Rec,
    vs.FullName,
    ve.Rec,
    ve.FullName
ORDER BY 
    vs.Rec,
    ve.Rec;

-- ============================================================
-- 查询4：按月+门店+职员汇总
-- ============================================================
SELECT 
    DATEPART(YEAR, vsd.BillDate) AS 年份,
    DATEPART(MONTH, vsd.BillDate) AS 月份,
    vs.Rec AS 门店编号,
    vs.FullName AS 门店名称,
    ve.Rec AS 职员编号,
    ve.FullName AS 职员姓名,
    ROUND(ABS(SUM(vsd.total)), 2) AS 价税合计,
    ROUND(ABS(SUM(vsd.costtotal)), 2) AS 销售成本合计,
    ROUND(ABS(SUM(vsd.total - vsd.costtotal)), 2) AS 利润额,
    CAST(ABS(SUM(vsd.qty)) AS INT) AS 销售数量
FROM ZHYYLS.dbo.vSaleSumDetail vsd
INNER JOIN ZHYYLS.dbo.Vstock vs ON vsd.KRec = vs.Rec
LEFT JOIN ZHYYLS.dbo.vBEmployee ve ON vsd.ERec = ve.Rec
WHERE 
    vsd.BillDate BETWEEN '2025-06-01' AND '2025-09-30'
    AND vs.Rec IN ('3','4','5','6','7','8','9','10','11','13','36','50','63','66')
GROUP BY 
    DATEPART(YEAR, vsd.BillDate),
    DATEPART(MONTH, vsd.BillDate),
    vs.Rec,
    vs.FullName,
    ve.Rec,
    ve.FullName
ORDER BY 
    年份,
    月份,
    vs.Rec,
    ve.Rec;

-- ============================================================
-- 说明：
-- 1. 使用 vSaleSumDetail 视图（销售汇总明细）
-- 2. 与 Vstock 表关联获取门店信息
-- 3. 使用 ABS() 函数处理退货数据（负数）
-- 4. 金额字段保留2位小数，数量字段取整
-- 5. 门店映射关系：
--    3 → 0001一第一药店
--    4 → 0002一第二药店
--    5 → 0003一第三药店
--    6 → 0004一第四药店
--    7 → 0005一四季青店
--    8 → 0006一常口店
--    9 → 0007一新河店
--    10 → 0009一第九药店
--    11 → 0017一福丰店
--    13 → 0014一十四药店
--    36 → 0016一凤凰山药店
--    50 → 0021一富源店
--    63 → 0008一第八药店
-- ============================================================
