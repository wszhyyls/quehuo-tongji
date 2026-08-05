USE [RQZT]
GO
/****** Object:  StoredProcedure [dbo].[sp_RQZT_AutoComplete] ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

ALTER PROC [dbo].[sp_RQZT_AutoComplete]
  @StartDate VARCHAR(10) = NULL,
  @EndDate VARCHAR(10) = NULL
AS
BEGIN
  SET NOCOUNT ON;

  CREATE TABLE #SM (store_name NVARCHAR(50) PRIMARY KEY, krec NVARCHAR(10));
  INSERT #SM VALUES
  ('02第二药店','5'),('03第三药店','6'),('04第四药店','7'),
  ('06常口店','9'),('08第八药店','66'),('09第九药店','11'),
  ('14第十四药店','36'),('16凤凰山药店','50'),('17益丰店','13'),('21富源店','63');

  -- staging: demand = MIN
  SELECT d.product_code, d.store_name, MIN(d.demand_qty) demand_qty,
         MAX(d.total_qty) total_qty, MIN(d.report_date) since, MAX(v.rec) prec
  INTO #OD FROM dbo.RQZT_AutoDetect_Demand d
  JOIN ZHYYLS.dbo.Vptype v ON v.usercode = d.product_code
  GROUP BY d.product_code, d.store_name;

  SELECT product_code, MIN(since) min_since INTO #ProdMinDate FROM #OD GROUP BY product_code;
  SELECT product_code, SUM(demand_qty) total_all INTO #TotalDemand FROM #OD GROUP BY product_code;

  -- 配送总量
  CREATE TABLE #Transit (product_code NVARCHAR(50), store_name NVARCHAR(50), transit_qty INT);
  INSERT INTO #Transit
  SELECT d.product_code, d.store_name, ISNULL(SUM(ABS(vs.Qty)), 0)
  FROM #OD d
  JOIN #SM m ON m.store_name = d.store_name
  JOIN ZHYYLS.dbo.vBuySendSumDetail vs WITH (NOLOCK)
    ON vs.PRec = d.prec AND vs.InKRec = m.krec AND vs.OutKRec = '3'
    AND vs.BillDate >= d.since
    AND (vs.Comment IS NULL OR vs.Comment NOT LIKE '%调货出库单%')
  GROUP BY d.product_code, d.store_name;

  -- C3：配送 >= 需求 → 已完成
  SELECT d.product_code, d.store_name, '已完成' as stat INTO #C3
  FROM #OD d
  LEFT JOIN #Transit t ON d.product_code = t.product_code AND d.store_name = t.store_name
  WHERE d.demand_qty > 0
    AND ISNULL(t.transit_qty, 0) >= d.demand_qty;

  -- 剩余门店的剩余总需求
  SELECT product_code, SUM(demand_qty) remain_all INTO #RemainTotal FROM #OD
  WHERE NOT EXISTS (SELECT 1 FROM #C3 c WHERE c.product_code = #OD.product_code AND c.store_name = #OD.store_name)
  GROUP BY product_code;

  -- C1C2 (per-store)
  SELECT DISTINCT d.product_code, d.store_name, '已到货' as stat INTO #C1C2
  FROM #OD d
  WHERE NOT EXISTS (SELECT 1 FROM #C3 c WHERE c.product_code = d.product_code AND c.store_name = d.store_name)
    AND EXISTS (
      SELECT 1 FROM ZHYYLS.dbo.vBuySendSumDetail WITH(NOLOCK)
      WHERE PRec = d.prec AND BillType = 34 AND InKRec = '3' AND BillDate >= d.since
    );

  -- 合并结果
  SELECT product_code, store_name, stat FROM #C3
  UNION ALL
  SELECT product_code, store_name, stat FROM #C1C2;

  -- 更新 Shortage_OrderFeedback 的"已完成"
  -- 修复：用 LEFT() 截断防止 备注 字段溢出
  UPDATE f SET 补货状态='已完成', 到货确认时间=GETDATE(),
    备注 = LEFT(ISNULL(备注,'') + ' | 自动完成 ' + CONVERT(VARCHAR(8), GETDATE(), 112), 200)
  FROM dbo.Shortage_OrderFeedback f
  WHERE 商品编码 IN (SELECT DISTINCT product_code FROM #C3)
    AND f.补货状态 NOT IN ('已完成', '厂家断货');

  SELECT @@ROWCOUNT AS updated;

  DROP TABLE #OD, #SM, #Transit, #C3, #C1C2, #TotalDemand, #ProdMinDate, #RemainTotal;
END
GO
