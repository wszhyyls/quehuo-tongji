// 验证 1100156 的采购入库判定：模拟 queryPurchaseQty 的查询条件
import sql from 'mssql';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('./config.json', 'utf-8'));
const c = {
  server: config.sqlServer.host, port: config.sqlServer.port || 1433,
  database: config.sqlServer.database || 'RQZT', user: config.sqlServer.user, password: config.sqlServer.password,
  connectionTimeout: 10000, requestTimeout: 30000,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
};

const pool = await sql.connect(c);
const code = '1100156';

// 1. 查该商品 9 月以来所有出入库明细（看 BillType / InKRec 实际值）
const r1 = await pool.request()
  .input('code', sql.NVarChar(50), code)
  .query(`
    SELECT vs.BillType, vs.InKRec, vs.BillDate, vs.Qty
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE v.usercode = @code AND vs.BillDate >= '2026-09-01'
    ORDER BY vs.BillDate
  `);
console.log('=== 1100156 九月以来出入库明细 ===');
r1.recordset.forEach(r => console.log(JSON.stringify(r)));

// 2. 模拟 queryPurchaseQty：锚点 = 迁移日（今天）
const r2 = await pool.request()
  .input('code', sql.NVarChar(50), code)
  .input('anchor', sql.VarChar(10), '2026-09-17')
  .query(`
    SELECT ISNULL(SUM(ABS(vs.Qty)), 0) as purchase_qty
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3' AND vs.BillDate > @anchor
  `);
console.log('=== 判定用采购入库累计（锚点=2026-09-17 迁移日）===');
console.log('purchase_qty =', r2.recordset[0].purchase_qty);

// 3. 锚点 = 最早上报日期（2026-08-11）
const r3 = await pool.request()
  .input('code', sql.NVarChar(50), code)
  .input('anchor', sql.VarChar(10), '2026-08-11')
  .query(`
    SELECT ISNULL(SUM(ABS(vs.Qty)), 0) as purchase_qty
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3' AND vs.BillDate > @anchor
  `);
console.log('=== 判定用采购入库累计（锚点=2026-08-11 最早上报）===');
console.log('purchase_qty =', r3.recordset[0].purchase_qty);

await pool.close();
