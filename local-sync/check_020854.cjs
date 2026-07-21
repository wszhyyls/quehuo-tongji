const mssql = require('mssql');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function main() {
  const pool = await mssql.connect({
    server: cfg.sqlServer.host, port: cfg.sqlServer.port, database: 'RQZT',
    user: cfg.sqlServer.user, password: cfg.sqlServer.password,
    options: { encrypt: false, trustServerCertificate: true }, requestTimeout: 30000
  });

  console.log('=== 020854 自 2026-06-19 之后的采购入库 (BillType=34, InKRec=3) ===');
  let r = await pool.request().query(`
    SELECT TOP 10 PRec, InKRec, OutKRec, BillDate, Qty, BillType, Comment
    FROM ZHYYLS.dbo.vBuySendSumDetail
    WHERE PRec IN (SELECT rec FROM ZHYYLS.dbo.Vptype WHERE usercode = '020854')
      AND BillType = 34 AND InKRec = '3' AND BillDate >= '2026-06-19'
    ORDER BY BillDate DESC
  `);
  console.log('Count:', r.recordset.length);
  console.log(JSON.stringify(r.recordset, null, 2));

  console.log('\n=== 020854 自 2026-06-19 之后仓库→02店 配送 (InKRec=5, OutKRec=3) ===');
  r = await pool.request().query(`
    SELECT TOP 10 PRec, InKRec, OutKRec, BillDate, Qty, BillType, Comment
    FROM ZHYYLS.dbo.vBuySendSumDetail
    WHERE PRec IN (SELECT rec FROM ZHYYLS.dbo.Vptype WHERE usercode = '020854')
      AND InKRec = '5' AND OutKRec = '3' AND BillDate >= '2026-06-19'
      AND (Comment IS NULL OR Comment NOT LIKE '%调货出库单%')
    ORDER BY BillDate DESC
  `);
  console.log(JSON.stringify(r.recordset, null, 2));

  console.log('\n=== 020854 GoodsStocks ===');
  r = await pool.request().query(`
    SELECT v.usercode, v.rec,
      (SELECT ISNULL(SUM(qty),0) FROM ZHYYLS.dbo.GoodsStocks WHERE prec=v.rec AND krec='3') wh,
      (SELECT ISNULL(SUM(qty),0) FROM ZHYYLS.dbo.GoodsStocks WHERE prec=v.rec AND krec='5') store_02
    FROM ZHYYLS.dbo.Vptype v WHERE v.usercode = '020854'
  `);
  console.log(JSON.stringify(r.recordset, null, 2));

  await pool.close();
}
main().catch(e => { console.error(e); process.exit(1); });
