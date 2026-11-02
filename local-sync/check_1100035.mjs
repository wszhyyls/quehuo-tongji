// 诊断 1100035：上报记录 + 完成记录 + 采购入库判定
import sql from 'mssql';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const config = JSON.parse(readFileSync('./config.json', 'utf-8'));
const sb = createClient(config.supabase.url, config.supabase.serviceKey);
const code = process.argv[2] || '1100035';

// 1. Supabase 上报记录
const { data: reports } = await sb.from('reports')
  .select('id, store_name, demand_quantity, replenish_status, created_at, settled_at, status_changed_at, status_changed_by')
  .eq('product_code', code)
  .eq('order_type', '缺货订购')
  .order('created_at', { ascending: false })
  .limit(10);
console.log('=== 上报记录 ===');
(reports || []).forEach(r => console.log(JSON.stringify(r)));

// 2. 完成周期记录
const { data: comp } = await sb.from('product_completion')
  .select('*').eq('product_code', code).maybeSingle();
console.log('=== 完成周期记录 ===');
console.log(JSON.stringify(comp));

// 3. 模拟修复后判定：锚点 = 完成锚点 || 最早上报日；需求 = 未完成上报合计
const active = (reports || []).filter(r => r.replenish_status !== '已完成');
const earliest = active.length ? active.map(r => r.created_at).sort()[0].slice(0, 10) : null;
const anchor = (comp && comp.last_completed_at ? comp.last_completed_at.slice(0, 10) : earliest) || '2026-09-17';
const demand = active.reduce((s, r) => s + (Number(r.demand_quantity) || 0), 0);
console.log(`=== 修复后判定参数 ===\nanchor=${anchor}（${comp && comp.last_completed_at ? '完成锚点' : '最早上报日'}） demand=${demand}`);

// 4. SQL 采购入库累计
const c = {
  server: config.sqlServer.host, port: config.sqlServer.port || 1433,
  database: config.sqlServer.database || 'RQZT', user: config.sqlServer.user, password: config.sqlServer.password,
  connectionTimeout: 10000, requestTimeout: 30000,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
};
const pool = await sql.connect(c);
const r1 = await pool.request()
  .input('code', sql.NVarChar(50), code)
  .input('anchor', sql.VarChar(10), anchor)
  .query(`
    SELECT ISNULL(SUM(ABS(vs.Qty)), 0) as purchase_qty
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3' AND vs.BillDate > @anchor
  `);
const purchase = Number(r1.recordset[0].purchase_qty);
console.log(`purchase_qty=${purchase}`);
console.log(`=== 判定结果: ${demand > 0 && purchase >= demand ? '✅ 已到齐 → 自动标记已完成（门店可重新上报）' : '⏳ 未到齐，继续等待采购'} ===`);

// 5. 入库明细参考
const r2 = await pool.request()
  .input('code', sql.NVarChar(50), code)
  .input('anchor', sql.VarChar(10), anchor)
  .query(`
    SELECT vs.BillDate, vs.Qty
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3' AND vs.BillDate > @anchor
    ORDER BY vs.BillDate
  `);
console.log('=== 锚点后采购入库明细 ===');
r2.recordset.forEach(r => console.log(JSON.stringify(r)));
await pool.close();
