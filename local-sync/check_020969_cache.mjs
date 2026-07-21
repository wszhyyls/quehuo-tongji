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
const r = await pool.request().query(`SELECT product_code, product_name, spec FROM dbo.ProductCache_RQZT WHERE product_code = '020969'`);
console.log('缓存表中 020969:', r.recordset);
const r2 = await pool.request().query(`SELECT USERCODE, FullName, leveal, area FROM ZHYYLS.dbo.Vptype WHERE USERCODE = '020969'`);
console.log('Vptype 020969:', r2.recordset);
await pool.close();
