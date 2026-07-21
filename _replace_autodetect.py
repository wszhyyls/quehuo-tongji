import re

path = r"G:\Trae项目\缺货统计系统\supabase\functions\query-shortage-data\index.ts"

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

start_marker = "// ========== v5.5 精准自动检测：按门店匹配库存，按各门店上报数比对 =========="
end_marker = "// 允许的来源域名列表（安全增强）"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx == -1 or end_idx == -1:
    print(f"ERROR: markers not found: start={start_idx}, end={end_idx}")
    exit(1)

new_function = '''// ========== v5.6 RQZT 存储过程版：全部计算在 SQL Server 端完成 ==========
async function preciseAutoDetectStatus(
  pool: sql.ConnectionPool,
  supabaseClient: any
): Promise<{ detected: number; details: string[] }> {
  const details: string[] = [];

  try {
    // 1. 获取 SQL Server 待检测商品
    const feedbackResult = await pool.request().query(`
      SELECT 商品编码, 补货状态, ISNULL(实际订货数量, 0) as 订货数量
      FROM dbo.Shortage_OrderFeedback WITH (NOLOCK)
      WHERE 补货状态 IN ('待处理', '已订购', '已到货', '待付款', '配货中', '厂家断货')
      ORDER BY CASE 补货状态
        WHEN '已订购' THEN 0 WHEN '已到货' THEN 1 WHEN '待付款' THEN 2
        WHEN '配货中' THEN 3 WHEN '待处理' THEN 4 WHEN '厂家断货' THEN 5
      END, 订货时间 DESC
    `);
    const sqlItems: any[] = feedbackResult.recordset || [];
    if (sqlItems.length === 0) return { detected: 0, details: ['没有待检测的商品'] };
    const sqlCodes: string[] = sqlItems.map((r: any) => r.商品编码);
    details.push(`SQL Server: ${sqlItems.length}个商品待检测`);

    // 2. 从 Supabase reports 获取门店需求（每个商品可能多门店上报）
    const { data: supabaseOrdered, error: supabaseErr } = await supabaseClient
      .from("reports")
      .select("product_code, store_name, demand_quantity")
      .in("replenish_status", ["待处理", "已订购", "已到货", "待付款", "配货中", "厂家断货"])
      .not("product_code", "is", null)
      .order("created_at", { ascending: false })
      .limit(1200);

    const productStoreDemands: Record<string, Array<{ store: string; demand: number }>> = {};
    if (!supabaseErr && supabaseOrdered) {
      for (const r of supabaseOrdered) {
        if (!r.product_code || !r.store_name) continue;
        if (!productStoreDemands[r.product_code]) productStoreDemands[r.product_code] = [];
        const exists = productStoreDemands[r.product_code].find(s => s.store === r.store_name);
        if (!exists) {
          productStoreDemands[r.product_code].push({ store: r.store_name, demand: r.demand_quantity || 0 });
        }
      }
    }

    // 补充 SQL Server 中没有的商品
    let missingCount = 0;
    for (const code of Object.keys(productStoreDemands)) {
      if (!sqlCodes.includes(code)) {
        const demandTotal = productStoreDemands[code].reduce((sum, s) => sum + s.demand, 0);
        sqlItems.push({ 商品编码: code, 补货状态: '已订购', 订货数量: demandTotal });
        missingCount++;
      }
    }
    if (missingCount > 0) details.push(`Supabase补充: ${missingCount}个商品`);

    // 3. 构建需求 JSON
    const demands: { product_code: string; store_name: string; demand_qty: number; total_qty: number }[] = [];
    for (const item of sqlItems) {
      const code = item.商品编码;
      const totalQty = item.订货数量 || 0;
      const stores = productStoreDemands[code];
      if (stores && stores.length > 0) {
        for (const s of stores) {
          demands.push({ product_code: code, store_name: s.store, demand_qty: s.demand || 0, total_qty: totalQty });
        }
      }
    }
    if (demands.length === 0) {
      details.push('无门店关联，无法检测');
      return { detected: 0, details };
    }
    details.push(`门店检测项: ${demands.length}条`);

    const jsonText = JSON.stringify(demands).replace(/'/g, "''");

    // 4. 确保存储过程存在（首次运行时自动创建）
    const spCheck = await pool.request().query(`
      SELECT 1 FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_SCHEMA = 'dbo' AND ROUTINE_NAME = 'usp_AutoCompleteOrders' AND ROUTINE_TYPE = 'PROCEDURE'
    `);
    if (!(spCheck.recordset?.length > 0)) {
      details.push('创建 RQZT 存储过程 usp_AutoCompleteOrders...');
      await pool.request().query(`
CREATE OR ALTER PROCEDURE dbo.usp_AutoCompleteOrders
    @OrderDemandsJson NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;

    -- 解析 JSON 需求
    SELECT product_code, store_name, demand_qty, total_qty
    INTO #OrderDemand
    FROM OPENJSON(@OrderDemandsJson)
    WITH (
        product_code NVARCHAR(50) '$.product_code',
        store_name   NVARCHAR(50) '$.store_name',
        demand_qty   INT         '$.demand_qty',
        total_qty    INT         '$.total_qty'
    );
    CREATE INDEX IX_OrderDemand_Code ON #OrderDemand(product_code);
    CREATE INDEX IX_OrderDemand_Store ON #OrderDemand(store_name);

    -- 门店映射
    CREATE TABLE #StoreMap (store_name NVARCHAR(50), krec NVARCHAR(10));
    INSERT INTO #StoreMap VALUES
    ('02第二药店','5'), ('03第三药店','6'), ('04第四药店','7'),
    ('06常口店','9'), ('08第八药店','66'), ('09第九药店','11'),
    ('14第十四药店','36'), ('16凤凰山药店','50'), ('17益丰店','13'), ('21富源店','63');

    -- 仓库库存（配送中心 krec=3）
    SELECT v.usercode AS product_code, ISNULL(SUM(gs.qty), 0) AS wh_stock
    INTO #WarehouseStock
    FROM ZHYYLS.dbo.Vptype v WITH (NOLOCK)
    JOIN ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK) ON gs.prec = v.rec
    JOIN #OrderDemand d ON v.usercode = d.product_code
    WHERE gs.krec = '3'
    GROUP BY v.usercode;
    CREATE INDEX IX_WH_Code ON #WarehouseStock(product_code);

    -- 门店库存
    SELECT d.product_code, d.store_name, ISNULL(SUM(gs.qty), 0) AS store_stock
    INTO #StoreStock
    FROM ZHYYLS.dbo.Vptype v WITH (NOLOCK)
    JOIN ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK) ON gs.prec = v.rec
    JOIN #OrderDemand d ON v.usercode = d.product_code
    JOIN #StoreMap m ON d.store_name = m.store_name AND gs.krec = m.krec
    GROUP BY d.product_code, d.store_name;
    CREATE INDEX IX_StoreStock ON #StoreStock(product_code, store_name);

    -- 在途（Gp_SendDoing）
    DECLARE @TransitRaw TABLE (PRec INT, posid NVARCHAR(20), Qty NUMERIC(18,2));
    BEGIN TRY
        INSERT INTO @TransitRaw
        EXEC ZHYYLS.dbo.Gp_SendDoing 0,'','',0,0,0,
            CONVERT(VARCHAR(10), DATEADD(DAY, -30, GETDATE()), 120),
            CONVERT(VARCHAR(10), GETDATE(), 120), 0,0,0,2;
    END TRY
    BEGIN CATCH
        -- 在途查询失败时继续，以库存为主
    END CATCH

    SELECT t.posid AS krec, vp.usercode AS product_code, SUM(t.Qty) AS transit_qty
    INTO #Transit
    FROM @TransitRaw t
    JOIN ZHYYLS.dbo.vPtype vp WITH (NOLOCK) ON t.PRec = vp.rec
    JOIN #OrderDemand d ON vp.usercode = d.product_code
    GROUP BY t.posid, vp.usercode;
    CREATE INDEX IX_Transit ON #Transit(krec, product_code);

    -- 仓库满足的商品
    SELECT DISTINCT d.product_code
    INTO #ToComplete
    FROM #OrderDemand d
    JOIN #WarehouseStock w ON d.product_code = w.product_code
    WHERE d.total_qty > 0 AND w.wh_stock > d.total_qty;

    -- 门店全部满足的商品
    INSERT INTO #ToComplete
    SELECT d.product_code
    FROM #OrderDemand d
    JOIN #StoreMap m ON d.store_name = m.store_name
    LEFT JOIN #StoreStock s ON d.product_code = s.product_code AND d.store_name = s.store_name
    LEFT JOIN #Transit t ON d.product_code = t.product_code AND m.krec = t.krec
    GROUP BY d.product_code
    HAVING COUNT(*) = SUM(
        CASE
            WHEN d.demand_qty > 0 AND (ISNULL(s.store_stock, 0) > d.demand_qty OR ISNULL(t.transit_qty, 0) > d.demand_qty) THEN 1
            ELSE 0
        END
    );

    CREATE INDEX IX_ToComplete ON #ToComplete(product_code);

    -- 输出将要完成的商品编码
    SELECT DISTINCT product_code FROM #ToComplete;

    -- 执行更新
    UPDATE f
    SET 补货状态 = '已完成', 到货确认时间 = GETDATE(),
        备注 = ISNULL(备注, '') + ' | 自动完成(RQZT存储过程) ' + CONVERT(VARCHAR, GETDATE(), 120)
    FROM dbo.Shortage_OrderFeedback f
    JOIN #ToComplete c ON f.商品编码 = c.product_code
    WHERE f.补货状态 NOT IN ('已完成', '厂家断货');

    SELECT @@ROWCOUNT AS updated_count;
END
      `);
      details.push('存储过程创建完成');
    }

    // 5. 调用存储过程
    const spResult = await pool.request()
      .input("OrderDemandsJson", sql.NVarChar(sql.MAX), jsonText)
      .query("EXEC dbo.usp_AutoCompleteOrders @OrderDemandsJson");

    // 解析结果集：第一个 SELECT 是商品编码列表，第二个 SELECT 是 updated_count
    const resultSets: any[] = (spResult as any).recordsets || [];
    let completedCodes: string[] = [];
    let actualUpdated = 0;
    if (resultSets.length >= 1) {
      completedCodes = (resultSets[0] || []).map((r: any) => r.product_code).filter(Boolean);
    }
    if (resultSets.length >= 2) {
      actualUpdated = resultSets[1][0]?.updated_count || 0;
    }
    details.push(`RQZT存储过程判定完成: ${completedCodes.length}个商品`);
    details.push(`SQL批量更新: ${actualUpdated}个`);

    // 6. 同步回 Supabase reports
    if (completedCodes.length > 0) {
      try {
        const { error: rptErr } = await supabaseClient
          .from("reports")
          .update({ replenish_status: '已完成' })
          .in("product_code", completedCodes);
        if (rptErr) {
          details.push(`⚠ Supabase reports同步失败: ${rptErr.message}`);
        } else {
          details.push(`Supabase reports同步完成: ${completedCodes.length}个`);
        }
      } catch (supaErr) {
        details.push(`⚠ Supabase reports同步异常: ${String(supaErr)}`);
      }
    }

    return { detected: actualUpdated, details };

  } catch (err) {
    console.error('[preciseAutoDetect] 错误:', err);
    return { detected: 0, details: [String(err)] };
  }
}

'''

new_content = content[:start_idx] + new_function + content[end_idx:]
with open(path, "w", encoding="utf-8") as f:
    f.write(new_content)

print("Replaced preciseAutoDetectStatus with RQZT SP version.")
