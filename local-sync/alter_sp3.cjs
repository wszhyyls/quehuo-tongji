const mssql = require('mssql');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function main() {
  const pool = await mssql.connect({
    server: cfg.sqlServer.host, port: cfg.sqlServer.port, database: 'RQZT',
    user: cfg.sqlServer.user, password: cfg.sqlServer.password,
    options: { encrypt: false, trustServerCertificate: true }, requestTimeout: 60000
  });

  // 修改 #OD：demand_qty 用 MIN（多份上报时取最少需求，更准确反映单次配送完成情况）
  const newSP = `
CREATE PROC dbo.sp_RQZT_AutoComplete
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

  -- 改用 MIN(demand_qty)：多份重复上报时取最少需求（单次配送即可满足）
  SELECT d.product_code, d.store_name, MIN(d.demand_qty) demand_qty,
         MAX(d.total_qty) total_qty, MIN(d.report_date) since, MAX(v.rec) prec
  INTO #OD FROM dbo.RQZT_AutoDetect_Demand d
  JOIN ZHYYLS.dbo.Vptype v ON v.usercode = d.product_code
  GROUP BY d.product_code, d.store_name;

  SELECT product_code, SUM(total_qty) total_all INTO #TotalDemand FROM #OD GROUP BY product_code;
  SELECT product_code, MIN(since) min_since INTO #ProdMinDate FROM #OD GROUP BY product_code;

  SELECT d.product_code, d.store_name, ISNULL(SUM(gs.qty),0) st_qty
  INTO #SS FROM #OD d
  JOIN #SM m ON m.store_name = d.store_name
  JOIN ZHYYLS.dbo.Vptype v ON v.usercode = d.product_code
  JOIN ZHYYLS.dbo.GoodsStocks gs ON gs.prec = v.rec AND gs.krec = m.krec
  GROUP BY d.product_code, d.store_name;

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

  -- C3：配送量 >= 最小需求 → 已完成
  SELECT d.product_code, d.store_name, '已完成' as stat INTO #C3
  FROM #OD d
  LEFT JOIN #Transit t ON d.product_code = t.product_code AND d.store_name = t.store_name
  WHERE d.demand_qty > 0
    AND ISNULL(t.transit_qty, 0) >= d.demand_qty;

  SELECT product_code, SUM(demand_qty) remain_all INTO #RemainTotal FROM #OD
  WHERE NOT EXISTS (SELECT 1 FROM #C3 c WHERE c.product_code = #OD.product_code AND c.store_name = #OD.store_name)
  GROUP BY product_code;

  SELECT r.product_code INTO #C1
  FROM #RemainTotal r
  JOIN #ProdMinDate pm ON pm.product_code = r.product_code
  JOIN ZHYYLS.dbo.Vptype v ON v.usercode = r.product_code
  JOIN ZHYYLS.dbo.GoodsStocks gs ON gs.prec = v.rec AND gs.krec = '3'
  WHERE r.remain_all > 0
    AND EXISTS (
      SELECT 1 FROM ZHYYLS.dbo.vBuySendSumDetail WITH(NOLOCK)
      WHERE PRec = v.rec AND BillType = 34 AND InKRec = '3' AND BillDate >= pm.min_since
    )
  GROUP BY r.product_code
  HAVING SUM(ISNULL(gs.qty,0)) >= MAX(r.remain_all);

  CREATE TABLE #Proc (product_code NVARCHAR(50), proc_total INT, prec INT, min_since VARCHAR(10));
  INSERT #Proc SELECT pm.product_code, 0, od.prec, pm.min_since FROM #ProdMinDate pm
    JOIN (SELECT product_code, MAX(prec) prec FROM #OD GROUP BY product_code) od ON pm.product_code = od.product_code
    WHERE EXISTS (SELECT 1 FROM #RemainTotal r WHERE r.product_code = pm.product_code);
  DECLARE @pc NVARCHAR(50), @prec INT, @md VARCHAR(10);
  DECLARE cur CURSOR FOR SELECT product_code, prec, min_since FROM #Proc;
  OPEN cur; FETCH NEXT FROM cur INTO @pc, @prec, @md;
  WHILE @@FETCH_STATUS = 0
  BEGIN
    IF @prec IS NOT NULL
      UPDATE #Proc SET proc_total = ISNULL((SELECT SUM(ABS(Qty)) FROM ZHYYLS.dbo.vBuySendSumDetail WITH(NOLOCK) WHERE PRec=@prec AND BillType=34 AND BillDate>=@md AND InKRec='3'),0) WHERE product_code=@pc;
    FETCH NEXT FROM cur INTO @pc, @prec, @md;
  END
  CLOSE cur; DEALLOCATE cur;
  SELECT pc.product_code INTO #C2 FROM #Proc pc JOIN #RemainTotal td ON pc.product_code = td.product_code WHERE pc.proc_total >= td.remain_all;

  SELECT DISTINCT d.product_code, d.store_name, '已到货' as stat INTO #C1C2
  FROM #OD d WHERE d.product_code IN (SELECT product_code FROM #C1 UNION SELECT product_code FROM #C2)
    AND NOT EXISTS (SELECT 1 FROM #C3 c WHERE c.product_code = d.product_code AND c.store_name = d.store_name);

  SELECT product_code, store_name, stat FROM #C3
  UNION ALL
  SELECT product_code, store_name, stat FROM #C1C2;

  UPDATE f SET 补货状态='已完成', 到货确认时间=GETDATE(),
    备注 = ISNULL(备注,'') + ' | 自动完成(RQZT) ' + CONVERT(VARCHAR, GETDATE(), 120)
  FROM dbo.Shortage_OrderFeedback f
  WHERE 商品编码 IN (SELECT DISTINCT product_code FROM #C3)
    AND f.补货状态 NOT IN ('已完成', '厂家断货');

  SELECT @@ROWCOUNT AS updated;

  DROP TABLE #OD, #SM, #C1, #C2, #C1C2, #C3, #TotalDemand, #Transit, #Proc, #ProdMinDate, #RemainTotal;
END
`;

  console.log('Dropping old SP...');
  await pool.request().query('DROP PROC dbo.sp_RQZT_AutoComplete');
  console.log('Creating new SP...');
  await pool.request().query(newSP);
  console.log('Done!');

  const r = await pool.request().query(`SELECT OBJECT_ID('dbo.sp_RQZT_AutoComplete') AS id`);
  console.log('SP exists:', !!r.recordset[0]?.id);

  await pool.close();
}
main().catch(e => { console.error(e); process.exit(1); });
