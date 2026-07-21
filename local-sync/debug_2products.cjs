const mssql = require('mssql');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function main() {
  const pool = await mssql.connect({
    server: cfg.sqlServer.host, port: cfg.sqlServer.port, database: 'RQZT',
    user: cfg.sqlServer.user, password: cfg.sqlServer.password,
    options: { encrypt: false, trustServerCertificate: true }, requestTimeout: 30000
  });

  for (const code of ['160102', '060070']) {
    console.log(`\n=== ${code} ===`);

    // GoodsStocks
    let r = await pool.request().query(`
      SELECT v.usercode, v.rec,
        (SELECT ISNULL(SUM(qty),0) FROM ZHYYLS.dbo.GoodsStocks WHERE prec=v.rec AND krec='3') wh,
        (SELECT ISNULL(SUM(qty),0) FROM ZHYYLS.dbo.GoodsStocks WHERE prec=v.rec AND krec='50') store_16
      FROM ZHYYLS.dbo.Vptype v WHERE v.usercode = '${code}'
    `);
    console.log('GoodsStocks:', JSON.stringify(r.recordset, null, 2));

    // 16店 配送
    r = await pool.request().query(`
      SELECT TOP 5 PRec, InKRec, OutKRec, BillDate, Qty, BillType, Comment
      FROM ZHYYLS.dbo.vBuySendSumDetail
      WHERE PRec IN (SELECT rec FROM ZHYYLS.dbo.Vptype WHERE usercode = '${code}')
        AND InKRec = '50' AND OutKRec = '3'
        AND BillDate >= '2026-06-01'
        AND (Comment IS NULL OR Comment NOT LIKE '%调货出库单%')
      ORDER BY BillDate DESC
    `);
    console.log('16店配送 since 6/1:', JSON.stringify(r.recordset, null, 2));

    // 仓库采购入库
    r = await pool.request().query(`
      SELECT TOP 5 PRec, InKRec, OutKRec, BillDate, Qty, BillType, Comment
      FROM ZHYYLS.dbo.vBuySendSumDetail
      WHERE PRec IN (SELECT rec FROM ZHYYLS.dbo.Vptype WHERE usercode = '${code}')
        AND BillType = 34 AND InKRec = '3' AND BillDate >= '2026-06-01'
      ORDER BY BillDate DESC
    `);
    console.log('仓库采购入库 since 6/1:', JSON.stringify(r.recordset, null, 2));
  }

  await pool.close();
}
main().catch(e => { console.error(e); process.exit(1); });
