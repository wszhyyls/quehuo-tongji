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

  const r = await pool.request().query(`
    SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.sp_RQZT_AutoComplete')) AS def
  `);
  console.log(r.recordset[0]?.def || 'SP 不存在');

  await pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
