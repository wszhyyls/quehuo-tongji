import { readFileSync } from 'fs';
import mssql from 'mssql';

const config = JSON.parse(readFileSync('./config.json', 'utf8'));

async function main() {
  const pool = await mssql.connect({
    server: config.sqlServer.host,
    port: config.sqlServer.port,
    database: 'RQZT',
    user: config.sqlServer.user,
    password: config.sqlServer.password,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 30000,
    requestTimeout: 60000,
  });

  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  try {
    const r = await pool.request()
      .input('sd', mssql.VarChar(10), thirtyDaysAgo)
      .input('ed', mssql.VarChar(10), today)
      .query(`EXEC ZHYYLS.dbo.Gp_SendDoing 0,'','',0,0,0,@sd,@ed,0,0,0,2`);
    console.log('Columns:', Object.keys(r.recordset?.[0] || {}));
    console.log('Total rows:', r.recordset?.length || 0);
    // 过滤 1100147 和 02店相关
    const filtered = (r.recordset || []).filter(row => {
      const summary = String(row.摘要 || row.summary || '');
      return JSON.stringify(row).includes('1100147') || summary.includes('第二药店');
    });
    console.log('Filtered rows:', filtered.length);
    console.log(JSON.stringify(filtered.slice(0, 10), null, 2));
  } catch (e) {
    console.error('Gp_SendDoing error:', e.message);
  }

  await pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
