const mssql = require('mssql');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function main() {
  const pool = await mssql.connect({
    server: cfg.sqlServer.host, port: cfg.sqlServer.port, database: 'RQZT',
    user: cfg.sqlServer.user, password: cfg.sqlServer.password,
    options: { encrypt: false, trustServerCertificate: true }, requestTimeout: 30000
  });

  console.log('=== Staging table contents ===');
  let r = await pool.request().query(`
    SELECT product_code, store_name, demand_qty, total_qty, report_date
    FROM dbo.RQZT_AutoDetect_Demand
    WHERE product_code IN ('160102', '060070', '020854')
    ORDER BY product_code, store_name, report_date
  `);
  console.log(JSON.stringify(r.recordset, null, 2));

  console.log('\n=== Shortage_OrderFeedback ===');
  r = await pool.request().query(`
    SELECT TOP 5 商品编码, 补货状态, 实际订货数量, 到货确认时间, 备注
    FROM dbo.Shortage_OrderFeedback
    WHERE 商品编码 IN ('160102', '060070', '020854')
    ORDER BY 序号 DESC
  `);
  console.log(JSON.stringify(r.recordset, null, 2));

  await pool.close();
}
main().catch(e => { console.error(e); process.exit(1); });
