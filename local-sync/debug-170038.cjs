const { createClient } = require('@supabase/supabase-js');
const sql = require('mssql');

const supabase = createClient(
  'https://qswpgnnedqvuegwfbprd.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE || (() => {
    const f = require('fs');
    const envFile = 'G:/Trae项目/缺货统计系统/.env.local';
    if (f.existsSync(envFile)) {
      for (const line of f.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^SUPABASE_SERVICE_ROLE=(.+)/);
        if (m) return m[1];
      }
    }
    return null;
  })()
);

(async () => {
  // 1. 查 Supabase reports 表里 170038 的所有记录
  const { data: reports, error } = await supabase
    .from('reports')
    .select('id, report_date, replenish_status, status_remark, status_changed_at, store_name, demand_qty, is_closed')
    .eq('product_code', '170038')
    .order('report_date', { ascending: false });

  console.log('=== Supabase reports for 170038 ===');
  if (error) console.log('ERROR:', error.message);
  else {
    for (const r of reports) {
      console.log(`  id=${r.id} date=${r.report_date} status=${r.replenish_status} demand=${r.demand_qty} changed_at=${r.status_changed_at} remark=${r.status_remark} store=${r.store_name}`);
    }
  }

  // 2. 查 product_completion
  const { data: pc, error: pcErr } = await supabase
    .from('product_completion')
    .select('*')
    .eq('product_code', '170038');
  console.log('\n=== product_completion ===');
  if (pcErr) console.log('ERROR:', pcErr.message);
  else console.log(JSON.stringify(pc, null, 2));

  // 3. 查状态变更日志（如果有）
  const { data: logs, error: logErr } = await supabase
    .from('reports')
    .select('*')
    .eq('product_code', '170038')
    .order('report_date', { ascending: false })
    .limit(5);

  // 4. 查 SQL Server 采购
  const config = {
    server: '221.6.168.13', port: 1311,
    user: 'zhyy03', password: 'wszh@123_wszh',
    database: 'RQZT', connectionTimeout: 15000,
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
  };
  const pool = await sql.connect(config);

  // 从最早未完成上报日（2026-10-30）起查采购
  const res = await pool.request()
    .input('code', sql.NVarChar(50), '170038')
    .input('anchor', sql.VarChar(10), '2026-10-30')
    .query(`
      SELECT ISNULL(SUM(ABS(vs.Qty)), 0) as qty,
             MIN(CONVERT(DATE, vs.BillDate)) as earliest,
             MAX(CONVERT(DATE, vs.BillDate)) as latest,
             COUNT(*) as rows
      FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
      JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
      WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3' AND vs.BillDate >= @anchor
    `);
  console.log('\n=== SQL Server 采购 (anchor=2026-10-30) ===');
  console.log(JSON.stringify(res.recordset[0], null, 2));

  // 查历史全部采购
  const res2 = await pool.request()
    .input('code', sql.NVarChar(50), '170038')
    .query(`
      SELECT CONVERT(DATE, vs.BillDate) as date, ABS(vs.Qty) as qty, vs.BillNo
      FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
      JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
      WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3'
      ORDER BY vs.BillDate DESC
    `);
  console.log('\n=== SQL Server 全部采购历史 ===');
  for (const r of res2.recordset) {
    console.log(`  ${r.date} qty=${r.qty} BillNo=${r.BillNo}`);
  }

  // 查待付款相关采购单（可能是已订购但未入库的）
  const res3 = await pool.request()
    .input('code', sql.NVarChar(50), '170038')
    .query(`
      SELECT TOP 10 CONVERT(DATE, p.BillDate) as date, p.BillNo, p.BillType, p.Qty, p.Status, p.VerifyCode
      FROM ZHYYLS.dbo.vBuyPlanDetail p WITH(NOLOCK)
      JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = p.PRec
      WHERE v.usercode = @code
      ORDER BY p.BillDate DESC
    `);
  console.log('\n=== 采购计划单（待付款/已订购可能来源于此）===');
  for (const r of res3.recordset) {
    console.log(`  ${r.date} BillNo=${r.BillNo} Type=${r.BillType} Qty=${r.Qty} Status=${r.Status} Verify=${r.VerifyCode}`);
  }

  await pool.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
