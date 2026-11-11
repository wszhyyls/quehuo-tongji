// 【C】SPFXB_Result 差异诊断
// 直接查 Edge Function 绕过，用 Edge Function 的 get_product_detail 和 batch_purchase_check
const EDGE = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data';
const SECRET = 'wszh_auto_sync_2026';

async function post(action, params) {
  const r = await fetch(EDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-task-secret': SECRET },
    body: JSON.stringify({ action, params })
  });
  return r.json();
}

async function main() {
  console.log('===== C1. 1110051 vs 随机"能上报"商品对比 =====');
  
  // 先拿一个当前 pending report 里的商品（肯定能上报）
  const sum = await post('get_summary', {});
  const pendingCodes = [...new Set((sum.data?.reports || [])
    .filter(r => !['已完成','厂家断货','已关闭'].includes(r.replenish_status))
    .map(r => r.product_code))].slice(0, 5);
  console.log('  选作对比的 pending 商品:', pendingCodes.join(', '));
  
  const targetCode = '1110051';
  
  // ① get_product_detail：1110051 vs 一个能上报的
  console.log('\n① get_product_detail（不强制刷新，走缓存）:');
  for (const code of [targetCode, ...pendingCodes.slice(0,2)]) {
    const r = await post('get_product_detail', { product_code: code, store_name: '16凤凰山药店' });
    const rows = r.data?.[0] || [];
    console.log(`   ${code}: ${rows.length} 条门店记录`);
  }
  
  // ② batch_purchase_check：采购历史 + 最后 BillDate
  console.log('\n② 采购入库历史对比（最后 BillDate / 总量 / 条数）:');
  const pc = await post('batch_purchase_check', { codes: [targetCode, ...pendingCodes.slice(0,3)] });
  for (const [code, rows] of Object.entries(pc.data?.purchaseByCode || {})) {
    if (!rows || rows.length === 0) { console.log(`   ${code}: 0 条采购`); continue; }
    const dates = rows.map(r => r.date).sort();
    const total = rows.reduce((s,r) => s + Number(r.qty || 0), 0);
    console.log(`   ${code}: ${rows.length} 条, 总量=${total}, 最早=${dates[0]}, 最新=${dates[dates.length-1]}, 距今天数=${Math.floor((Date.now() - new Date(dates[dates.length-1]+'T00:00:00Z').getTime())/86400000)}天`);
  }
  
  // ③ get_product_detail 强制刷新（跳过缓存直接查 SQL Server SPFXB_Result）
  console.log('\n③ get_product_detail 强制刷新（force_refresh=true, 直接查 SQL Server SPFXB_Result）:');
  for (const code of [targetCode, ...pendingCodes.slice(0,1)]) {
    const r = await post('get_product_detail', { product_code: code, store_name: '16凤凰山药店', force_refresh: true });
    const rows = r.data?.[0] || [];
    const src = rows[0]?._source || '空';
    console.log(`   ${code}: ${rows.length} 条门店记录, _source=${src}`);
    if (rows.length > 0) {
      rows.slice(0,2).forEach(row => console.log(`     ${row.门店名称}: 库存=${row.库存数量} 在途=${row.在途数量}`));
    }
  }
  
  console.log('\n===== C2. 诊断结论 =====');
  console.log('如果 1110051 强制刷新也返回 0 条 → 确认 SPFXB_Result 视图不含此商品');
  console.log('如果 1110051 强制刷新有数据 → 问题在 shortage_storestock_cache 缓存缺失');
}
main().catch(e => console.error('ERR:', e));
