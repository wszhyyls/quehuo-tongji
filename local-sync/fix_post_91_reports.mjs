// 一次性修正：9/1 之后的上报，若该商品 9/1 之后无采购入库，则改为「待处理」
// 用法：cd local-sync && node fix_post_91_reports.mjs
import { createClient } from '@supabase/supabase-js';
import sql from 'mssql';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('./config.json', 'utf-8'));
const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

const sqlc = {
  server: config.sqlServer.host, port: config.sqlServer.port || 1433,
  database: config.sqlServer.database || 'RQZT', user: config.sqlServer.user, password: config.sqlServer.password,
  connectionTimeout: 10000, requestTimeout: 60000,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
};

// 中国时区 2026-09-01 00:00 = UTC 2026-08-31 16:00
const POST_91_UTC = '2026-08-31T16:00:00Z';

// 1. 查 9/1 之后的上报
const { data: reports, error } = await supabase
  .from('reports')
  .select('id, product_code, store_id, created_at, replenish_status')
  .eq('order_type', '缺货订购')
  .gte('created_at', POST_91_UTC);

if (error) { console.error('Supabase 查询失败:', error); process.exit(1); }

console.log('=== 9/1 之后上报记录数:', reports.length, '===');
const byCode = {};
for (const r of reports) (byCode[r.product_code] = byCode[r.product_code] || []).push(r);
const codes = Object.keys(byCode);
console.log('涉及商品数:', codes.length);

// 2. 查这些商品 9/1 之后的采购入库累计
const pool = await sql.connect(sqlc);
const purchaseMap = {};
for (let i = 0; i < codes.length; i += 100) {
  const batch = codes.slice(i, i + 100);
  const req = pool.request();
  const ph = batch.map((c, idx) => { req.input(`c${idx}`, sql.NVarChar(50), c); return `@c${idx}`; }).join(',');
  const res = await req.query(`
    SELECT v.usercode, ISNULL(SUM(ABS(vs.Qty)), 0) as qty
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE vs.BillType = 34 AND vs.InKRec = '3' AND vs.BillDate >= '2026-09-01'
      AND v.usercode IN (${ph})
    GROUP BY v.usercode
  `);
  (res.recordset || []).forEach(r => { purchaseMap[r.usercode] = Number(r.qty); });
}
await pool.close();

// 3. 找出 9/1 后无采购的商品，及其需要修正的上报
const noPurchaseCodes = codes.filter(c => (purchaseMap[c] || 0) === 0);
console.log('=== 9/1 之后无采购入库的商品数:', noPurchaseCodes.length, '===');

const fixedIds = [];
const detail = [];
for (const code of noPurchaseCodes) {
  const toFix = byCode[code].filter(r => r.replenish_status !== '待处理');
  if (toFix.length > 0) {
    detail.push(`${code}（当前状态: ${toFix[0].replenish_status}，${toFix.length}条）`);
    toFix.forEach(r => fixedIds.push(r.id));
  }
}
console.log('需要改为「待处理」的上报条数:', fixedIds.length);
detail.forEach(d => console.log('  -', d));

// 4. 执行更新
let fixed = 0;
for (let i = 0; i < fixedIds.length; i += 200) {
  const batch = fixedIds.slice(i, i + 200);
  const { error: ue } = await supabase
    .from('reports')
    .update({ replenish_status: '待处理', settled_at: null, status_remark: '手动修正(9/1后无采购)' })
    .in('id', batch);
  if (ue) { console.error('更新失败:', ue.message); } else { fixed += batch.length; }
}
console.log('=== 实际修正条数:', fixed, '===');
