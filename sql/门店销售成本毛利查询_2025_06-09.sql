-- ============================================================
-- 缺货统计系统 - 2025年6-9月各门店销售金额、成本金额、毛利查询
-- 按门店、按月统计
-- ============================================================

-- 方案一：如果 Vsalebill 销售明细表存在，使用此查询
SELECT 
    s.门店名称,
    DATEPART(YEAR, sb.单据日期) AS 年份,
    DATEPART(MONTH, sb.单据日期) AS 月份,
    ISNULL(SUM(sb.零售金额), 0) AS 销售金额,
    ISNULL(SUM(sb.成本金额), 0) AS 成本金额,
    ISNULL(SUM(sb.零售金额 - sb.成本金额), 0) AS 毛利
FROM ZHYYLS.dbo.Vsalebill sb
INNER JOIN dbo.SPFXB_Result s ON sb.商品编码 = s.商品编码
WHERE 
    sb.单据日期 BETWEEN '2025-06-01' AND '2025-09-30'
    AND s.门店名称 IS NOT NULL
GROUP BY 
    s.门店名称,
    DATEPART(YEAR, sb.单据日期),
    DATEPART(MONTH, sb.单据日期)
ORDER BY 
    s.门店名称,
    年份,
    月份;

-- ============================================================

-- 方案二：如果 SPFXB_Result 表中有销售金额字段，使用此查询
SELECT 
    门店名称,
    2025 AS 年份,
    6 AS 月份,
    SUM(前30天销售金额) AS 销售金额_6月,
    0 AS 成本金额,
    0 AS 毛利
FROM dbo.SPFXB_Result
GROUP BY 门店名称
ORDER BY 门店名称;

-- ============================================================

-- 方案三：完整方案，带商品分类统计
SELECT 
    s.门店名称,
    DATEPART(YEAR, sb.单据日期) AS 年份,
    DATEPART(MONTH, sb.单据日期) AS 月份,
    p.商品分类,
    ISNULL(SUM(sb.零售金额), 0) AS 销售金额,
    ISNULL(SUM(sb.成本金额), 0) AS 成本金额,
    ISNULL(SUM(sb.零售金额 - sb.成本金额), 0) AS 毛利,
    ISNULL(SUM(sb.数量), 0) AS 销售数量
FROM ZHYYLS.dbo.Vsalebill sb
INNER JOIN dbo.SPFXB_Result s ON sb.商品编码 = s.商品编码
LEFT JOIN ZHYYLS.dbo.Vptype p ON sb.商品编码 = p.商品编码
WHERE 
    sb.单据日期 BETWEEN '2025-06-01' AND '2025-09-30'
    AND s.门店名称 IS NOT NULL
GROUP BY 
    s.门店名称,
    DATEPART(YEAR, sb.单据日期),
    DATEPART(MONTH, sb.单据日期),
    p.商品分类
ORDER BY 
    s.门店名称,
    年份,
    月份,
    p.商品分类;

-- ============================================================

-- 方案四：如果使用的是 Shortage 开头的表
/*
SELECT 
    门店名称,
    DATEPART(YEAR, 日期) AS 年份,
    DATEPART(MONTH, 日期) AS 月份,
    SUM(销售金额) AS 销售金额,
    SUM(成本金额) AS 成本金额,
    SUM(销售金额 - 成本金额) AS 毛利
FROM dbo.Shortage_Sales
WHERE 
    日期 BETWEEN '2025-06-01' AND '2025-09-30'
GROUP BY 
    门店名称,
    DATEPART(YEAR, 日期),
    DATEPART(MONTH, 日期)
ORDER BY 
    门店名称,
    年份,
    月份;
*/

-- ============================================================
-- 辅助查询：查看所有可用表
/*
SELECT 
    TABLE_NAME
FROM ZHYYLS.INFORMATION_SCHEMA.TABLES
WHERE 
    TABLE_TYPE = 'BASE TABLE'
    AND (TABLE_NAME LIKE '%sale%' OR TABLE_NAME LIKE '%销售%' OR TABLE_NAME LIKE '%Vptype%' OR TABLE_NAME LIKE '%Vsale%')
ORDER BY TABLE_NAME;
*/

-- ============================================================
-- 辅助查询：查看 Vsalebill 表的字段
/*
SELECT 
    COLUMN_NAME
FROM ZHYYLS.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'Vsalebill'
ORDER BY ORDINAL_POSITION;
*/

-- ============================================================
-- 辅助查询：查看 SPFXB_Result 表的字段
/*
SELECT 
    COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'SPFXB_Result'
ORDER BY ORDINAL_POSITION;
*/
