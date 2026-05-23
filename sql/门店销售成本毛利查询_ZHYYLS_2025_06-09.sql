-- ============================================================
-- 缺货统计系统 - 2025年6-9月各门店销售金额、成本金额、毛利查询
-- 基于 ZHYYLS.dbo 实时业务数据库查询
-- 按门店、按月统计
-- ============================================================

-- ============================================================
-- 方案一：使用 Vsalebill 销售明细表 + Vptype 商品表
-- ============================================================
SELECT 
    sb.门店编码,
    sb.门店名称,
    DATEPART(YEAR, sb.单据日期) AS 年份,
    DATEPART(MONTH, sb.单据日期) AS 月份,
    ISNULL(SUM(sb.零售金额), 0) AS 销售金额,
    ISNULL(SUM(sb.成本金额), 0) AS 成本金额,
    ISNULL(SUM(sb.零售金额 - sb.成本金额), 0) AS 毛利,
    ISNULL(SUM(sb.数量), 0) AS 销售数量
FROM ZHYYLS.dbo.Vsalebill sb
WHERE 
    sb.单据日期 BETWEEN '2025-06-01' AND '2025-09-30'
    AND sb.门店名称 IS NOT NULL
GROUP BY 
    sb.门店编码,
    sb.门店名称,
    DATEPART(YEAR, sb.单据日期),
    DATEPART(MONTH, sb.单据日期)
ORDER BY 
    sb.门店编码,
    年份,
    月份;

-- ============================================================
-- 方案二：带商品分类的详细统计
-- ============================================================
SELECT 
    sb.门店编码,
    sb.门店名称,
    DATEPART(YEAR, sb.单据日期) AS 年份,
    DATEPART(MONTH, sb.单据日期) AS 月份,
    p.商品分类,
    ISNULL(SUM(sb.零售金额), 0) AS 销售金额,
    ISNULL(SUM(sb.成本金额), 0) AS 成本金额,
    ISNULL(SUM(sb.零售金额 - sb.成本金额), 0) AS 毛利,
    ISNULL(SUM(sb.数量), 0) AS 销售数量
FROM ZHYYLS.dbo.Vsalebill sb
LEFT JOIN ZHYYLS.dbo.Vptype p ON sb.商品编码 = p.商品编码
WHERE 
    sb.单据日期 BETWEEN '2025-06-01' AND '2025-09-30'
    AND sb.门店名称 IS NOT NULL
GROUP BY 
    sb.门店编码,
    sb.门店名称,
    DATEPART(YEAR, sb.单据日期),
    DATEPART(MONTH, sb.单据日期),
    p.商品分类
ORDER BY 
    sb.门店编码,
    年份,
    月份,
    p.商品分类;

-- ============================================================
-- 方案三：汇总总计（按整个时间范围统计）
-- ============================================================
SELECT 
    sb.门店编码,
    sb.门店名称,
    MIN(DATEPART(YEAR, sb.单据日期)) AS 起始年份,
    MAX(DATEPART(YEAR, sb.单据日期)) AS 结束年份,
    ISNULL(SUM(sb.零售金额), 0) AS 销售金额_总计,
    ISNULL(SUM(sb.成本金额), 0) AS 成本金额_总计,
    ISNULL(SUM(sb.零售金额 - sb.成本金额), 0) AS 毛利_总计,
    ISNULL(SUM(sb.数量), 0) AS 销售数量_总计,
    COUNT(DISTINCT DATEPART(MONTH, sb.单据日期)) AS 统计月份数
FROM ZHYYLS.dbo.Vsalebill sb
WHERE 
    sb.单据日期 BETWEEN '2025-06-01' AND '2025-09-30'
    AND sb.门店名称 IS NOT NULL
GROUP BY 
    sb.门店编码,
    sb.门店名称
ORDER BY 
    sb.门店编码;

-- ============================================================
-- 方案四：按日明细查询（可导出做Excel分析）
-- ============================================================
SELECT 
    sb.门店编码,
    sb.门店名称,
    sb.单据日期,
    sb.商品编码,
    p.商品名称,
    p.规格,
    p.生产企业,
    p.商品分类,
    sb.数量 AS 销售数量,
    sb.零售金额 AS 销售金额,
    sb.成本金额,
    (sb.零售金额 - sb.成本金额) AS 毛利
FROM ZHYYLS.dbo.Vsalebill sb
LEFT JOIN ZHYYLS.dbo.Vptype p ON sb.商品编码 = p.商品编码
WHERE 
    sb.单据日期 BETWEEN '2025-06-01' AND '2025-09-30'
    AND sb.门店名称 IS NOT NULL
ORDER BY 
    sb.门店编码,
    sb.单据日期,
    sb.商品编码;

-- ============================================================
-- 方案五：按周统计
-- ============================================================
SELECT 
    sb.门店编码,
    sb.门店名称,
    DATEPART(YEAR, sb.单据日期) AS 年份,
    DATEPART(MONTH, sb.单据日期) AS 月份,
    DATEPART(WEEK, sb.单据日期) AS 周次,
    ISNULL(SUM(sb.零售金额), 0) AS 销售金额,
    ISNULL(SUM(sb.成本金额), 0) AS 成本金额,
    ISNULL(SUM(sb.零售金额 - sb.成本金额), 0) AS 毛利,
    ISNULL(SUM(sb.数量), 0) AS 销售数量
FROM ZHYYLS.dbo.Vsalebill sb
WHERE 
    sb.单据日期 BETWEEN '2025-06-01' AND '2025-09-30'
    AND sb.门店名称 IS NOT NULL
GROUP BY 
    sb.门店编码,
    sb.门店名称,
    DATEPART(YEAR, sb.单据日期),
    DATEPART(MONTH, sb.单据日期),
    DATEPART(WEEK, sb.单据日期)
ORDER BY 
    sb.门店编码,
    年份,
    月份,
    周次;

-- ============================================================
-- 辅助查询：查看 Vsalebill 表结构
-- ============================================================
/*
SELECT 
    COLUMN_NAME,
    DATA_TYPE,
    IS_NULLABLE,
    CHARACTER_MAXIMUM_LENGTH
FROM ZHYYLS.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'Vsalebill'
ORDER BY ORDINAL_POSITION;
*/

-- ============================================================
-- 辅助查询：查看 Vptype 表结构
-- ============================================================
/*
SELECT 
    COLUMN_NAME,
    DATA_TYPE,
    IS_NULLABLE,
    CHARACTER_MAXIMUM_LENGTH
FROM ZHYYLS.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'Vptype'
ORDER BY ORDINAL_POSITION;
*/

-- ============================================================
-- 辅助查询：查看 ZHYYLS 中的其他表
-- ============================================================
/*
SELECT 
    TABLE_SCHEMA,
    TABLE_NAME,
    TABLE_TYPE
FROM ZHYYLS.INFORMATION_SCHEMA.TABLES
WHERE 
    TABLE_TYPE = 'BASE TABLE'
    AND (TABLE_NAME LIKE '%sale%' OR TABLE_NAME LIKE '%销售%' OR TABLE_NAME LIKE '%门店%' OR TABLE_NAME LIKE '%stock%' OR TABLE_NAME LIKE '%库存%')
ORDER BY TABLE_SCHEMA, TABLE_NAME;
*/
