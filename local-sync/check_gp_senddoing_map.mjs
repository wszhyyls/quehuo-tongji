// 验证 Gp_SendDoing 的 posid/PosName 映射 + 在途语义
import mssql from 'mssql';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('./config.json', 'utf8'));

async function main() {
  const pool = await mssql.connect({
    server: config.sqlServer.host, port: config.sqlServer.port,
    database: 'RQZT', user: config.sqlServer.user, password: config.sqlServer.password,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 30000, requestTimeout: 60000,
  });

  const today = new Date().toISOString().slice(0, 10);
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const r = await pool.request()
    .input('sd', mssql.VarChar(10), d30)
    .input('ed', mssql.VarChar(10), today)
    .query(`EXEC ZHYYLS.dbo.Gp_SendDoing 0,'','',0,0,0,@sd,@ed,0,0,0,2`);

  const rows = r.recordset || [];
  console.log('总行数:', rows.length);

  // distinct posid + PosName
  const map = {};
  rows.forEach(rr => { map[rr.posid] = rr.PosName; });
  console.log('=== posid → PosName 映射 ===');
  Object.entries(map).forEach(([k, v]) => console.log(`  posid=${k} → PosName=${v}`));

  // 举例前 5 行看字段
  console.log('=== 前 5 行示例 ===');
  rows.slice(0, 5).forEach(rr => console.log(JSON.stringify({ posid: rr.posid, PosName: rr.PosName, KRec: rr.KRec, PRec: rr.PRec, Qty: rr.Qty, BillDate: rr.BillDate })));

  await pool.close();
}
main().catch(e => { console.error(e); process.exit(1); });
