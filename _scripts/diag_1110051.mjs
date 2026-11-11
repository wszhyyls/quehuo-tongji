// 诊断商品 1110051 为什么门店侧查不到
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
  console.log('=== 商品 1110051 诊断 ===\n');

  // 1. 查 product_cache（商品缓存表）
  console.log('① 查 product_cache：');
  try {
    const pcResp = await post('get_summary', {});
    const allReports = pcResp.data?.reports || [];
    // product_cache 不在 get_summary 里，用 debug_check_product_codes
    // 直接用 batch_purchase_check 查 ERP 采购
    const pcResp2 = await post('batch_purchase_check', { codes: ['1110051', '01110051', '110051'] });
    console.log('  采购数据（3个编码变体）:');
    for (const [code, rows] of Object.entries(pcResp2.data?.purchaseByCode || {})) {
      console.log(`    ${code}: ${rows.length} 条采购`);
      if (rows.length > 0) {
        const dates = rows.map(r => r.date).sort();
        console.log(`      最早: ${dates[0]}, 最新: ${dates[dates.length-1]}`);
        console.log(`      总量: ${rows.reduce((s,r)=>s+Number(r.qty||0),0)}`);
      }
    }
  } catch(e) { console.log('  ❌ 错误:', e.message); }

  // 2. 搜 reports 里有没有相关编码（含前导零变体）
  console.log('\n② reports 表搜索（多个编码变体）:');
  const variants = ['1110051', '01110051', '001110051', '110051'];
  for (const v of variants) {
    const sum = await post('get_summary', {});
    const found = (sum.data?.reports || []).filter(r => String(r.product_code) === v || String(r.product_code).padStart(8,'0') === v.padStart(8,'0'));
    if (found.length > 0) {
      console.log(`  ✅ ${v}: ${found.length} 条 report`);
      found.forEach(r => console.log(`    id=${r.id} store=${r.store_name} status=${r.replenish_status}`));
    }
  }
  console.log('  （无匹配 = 该商品从未上报过缺货）');

  // 3. 查 ERP 原始商品表（vBuySendSumDetail 或商品字典）
  console.log('\n③ 查 ERP 商品字典（debug_check_code 等 action）:');
  for (const action of ['batch_purchase_check']) {
    try {
      const r = await post(action, { codes: ['1110051'] });
      if (r.data?.purchaseByCode && r.data.purchaseByCode['1110051']) {
        console.log(`  ✅ ERP 有采购记录`);
      } else {
        console.log(`  ❌ ERP 查不到编码 1110051`);
      }
    } catch(e) { console.log(`  ${action} 失败: ${e.message}`); }
  }

  // 4. 检查 leveal 过滤（product_cache 是否有 leveal 字段被过滤）
  console.log('\n④ 查商品缓存（需直接查 Supabase product_cache 表）:');
  console.log('  需要 Supabase SQL Editor 执行：');
  console.log("  SELECT * FROM product_cache WHERE product_code LIKE '%1110051%';");
  console.log('  （可能 leveal 过滤了某些商品层级）');

  console.log('\n⑤ 查 leveal 过滤逻辑：');
  const fs = await fetch(EDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-task-secret': SECRET },
    body: JSON.stringify({ action: 'debug_check_code', params: { code: '1110051' } })
  });
  // 这个 action 可能不存在，忽略错误
}
main().catch(e => console.error('ERR:', e.message));
