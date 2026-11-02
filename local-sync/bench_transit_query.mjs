// 计时：Gp_SendDoing 在途查询 + vBuySendSumDetail 已配送查询
import mssql from 'mssql';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('./config.json', 'utf8'));

async function main() {
  const pool = await mssql.connect({
    server: config.sqlServer.host, port: config.sqlServer.port,
    database: 'RQZT', user: config.sqlServer.user, password: config.sqlServer.password,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 30000, requestTimeout: 180000,
  });

  const today = new Date().toISOString().slice(0, 10);
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // 1. Gp_SendDoing 计时
  let t0 = Date.now();
  const g = await pool.request()
    .input('sd', mssql.VarChar(10), d30)
    .input('ed', mssql.VarChar(10), today)
    .query(`EXEC ZHYYLS.dbo.Gp_SendDoing 0,'','',0,0,0,@sd,@ed,0,0,0,2`);
  console.log('1. Gp_SendDoing 耗时:', Date.now() - t0, 'ms, 行数:', g.recordset.length);

  // 2. PRec 反查计时
  t0 = Date.now();
  const precList = [...new Set(g.recordset.map(r => r.PRec).filter(Boolean))];
  const vp = await pool.request().query(`SELECT rec, usercode FROM ZHYYLS.dbo.Vptype WITH(NOLOCK) WHERE rec IN (${precList.map((_, i) => `@p${i}`).join(',') || `''`})`);
  console.log('2. Vptype 反查耗时:', Date.now() - t0, 'ms, PRec数:', precList.length);

  // 3. 已配送量查询计时（模拟一个 pair：随便取 3 个商品门店组合）
  t0 = Date.now();
  const sample = g.recordset.slice(0, 3).map(r => {
    const vpRow = vp.recordset.find(v => v.rec === r.PRec);
    return { prec: r.PRec, krec: String(r.posid), since: '2026-08-01', code: vpRow ? vpRow.usercode : '' };
  }).filter(s => s.code);
  if (sample.length > 0) {
    const vals = sample.map((s, j) => `('${s.prec}','${s.krec}','${s.since}')`).join(',');
    const d = await pool.request().query(`
      SELECT z.prec, z.krec, ISNULL(SUM(ABS(v.Qty)), 0) as delivered_qty
      FROM (VALUES ${vals}) z(prec, krec, since)
      JOIN ZHYYLS.dbo.vBuySendSumDetail v WITH(NOLOCK)
        ON v.PRec = z.prec AND v.InKRec = z.krec AND v.OutKRec = '3'
        AND v.BillDate >= z.since
        AND (v.Comment IS NULL OR v.Comment NOT LIKE '%调货出库单%')
      GROUP BY z.prec, z.krec;
    `);
    console.log('3. 已配送查询耗时(3个pair):', Date.now() - t0, 'ms, 结果:', d.recordset.length);
  }

  // 4. 仓库+门店库存计时（get_delivery_todo 通常涉及 ~40 商品）
  t0 = Date.now();
  await pool.request().query(`
    SELECT v.usercode, ISNULL(SUM(gs.qty), 0) as wh_qty
    FROM ZHYYLS.dbo.Vptype v WITH(NOLOCK)
    LEFT JOIN ZHYYLS.dbo.GoodsStocks gs WITH(NOLOCK) ON gs.prec = v.rec AND gs.krec = '3'
    WHERE v.usercode IN ('1100156','1020270','030153')
    GROUP BY v.usercode
  `);
  console.log('4. 仓库库存查询耗时:', Date.now() - t0, 'ms');

  await pool.close();
}
main().catch(e => { console.error(e); process.exit(1); });
