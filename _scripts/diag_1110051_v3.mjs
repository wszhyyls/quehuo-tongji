// 终极验证：从 batch_purchase_check 里找"近期有采购但 reports 里没上报过"的商品
// 看它们能不能 get_product_detail 成功 → 能提交
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
  // 从 product_cache 随机抽 10 个商品（排除已知 pending 商品）
  const sum = await post('get_summary', {});
  const pendingCodes = new Set((sum.data?.reports || []).map(r => r.product_code));
  console.log('pending 商品数:', pendingCodes.size);
  
  // 查 product_cache 全量，过滤掉 pending 的
  const { createClient } = await import('@supabase/supabase-js');
  const c = createClient('https://qswpgnnedqvuegwfbprd.supabase.co', 
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI');
  
  const allProducts = await c.from('product_cache').select('product_code,product_name').limit(500);
  const freshCodes = (allProducts.data || [])
    .map(p => p.product_code)
    .filter(code => !pendingCodes.has(code) && code !== '1110051')
    .slice(0, 20);
  console.log(`\n从 product_cache 随机抽 20 个非 pending 商品:`, freshCodes.join(', '));
  
  // 查这 20 个的采购历史
  const pc = await post('batch_purchase_check', { codes: freshCodes });
  const rows = pc.data?.purchaseByCode || {};
  
  // 按最后 BillDate 分桶
  const buckets = { fresh_90d: [], fresh_180d: [], old_365d: [], ancient: [] };
  for (const code of freshCodes) {
    const purchases = rows[code] || [];
    if (purchases.length === 0) { buckets.ancient.push(code); continue; }
    const dates = purchases.map(p => p.date).sort();
    const lastDate = new Date(dates[dates.length-1] + 'T00:00:00Z');
    const days = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
    const info = { code, lastDate: dates[dates.length-1], days, total: purchases.reduce((s,p)=>s+Number(p.qty||0),0) };
    if (days <= 90) buckets.fresh_90d.push(info);
    else if (days <= 180) buckets.fresh_180d.push(info);
    else if (days <= 365) buckets.old_365d.push(info);
    else buckets.ancient.push(info);
  }
  
  console.log('\n=== 按最后采购日期分桶 ===');
  console.log(`🟢 90天内: ${buckets.fresh_90d.length} 个`, buckets.fresh_90d.map(x=>`${x.code}(${x.days}天)`).join(', '));
  console.log(`🟡 180天内: ${buckets.fresh_180d.length} 个`, buckets.fresh_180d.map(x=>`${x.code}(${x.days}天)`).join(', '));
  console.log(`🟠 365天内: ${buckets.old_365d.length} 个`, buckets.old_365d.map(x=>`${x.code}(${x.days}天)`).join(', '));
  console.log(`🔴 超过365天: ${buckets.ancient.length} 个`, buckets.ancient.map(x=>typeof x==='string'?x:`${x.code}(${x.days}天)`).join(', '));
  
  // 选 2 个新鲜的 + 2 个古老的，都去 get_product_detail
  const testSet = [
    ...buckets.fresh_90d.slice(0, 2).map(x => x.code),
    ...buckets.fresh_180d.slice(0, 1).map(x => x.code),
    ...buckets.old_365d.slice(0, 1).map(x => x.code),
    ...buckets.ancient.slice(0, 1).map(x => typeof x === 'string' ? x : x.code),
    '1110051'
  ].filter(Boolean);
  
  console.log('\n=== get_product_detail 实测 ===');
  for (const code of testSet) {
    const r = await post('get_product_detail', { product_code: code, store_name: '16凤凰山药店' });
    const rows2 = r.data?.[0] || [];
    const status = rows2.length > 0 ? '✅ 能查库存 → 能上报' : '❌ 查不到 → 弹"商品未找到"';
    const info = rows[code] || [];
    let daysStr = '无采购';
    if (info.length > 0) {
      const dates = info.map(p => p.date).sort();
      const lastDate = new Date(dates[dates.length-1] + 'T00:00:00Z');
      daysStr = Math.floor((Date.now() - lastDate.getTime()) / 86400000) + '天前';
    }
    console.log(`  ${code} (采购=${daysStr}): ${rows2.length} 条门店记录 → ${status}`);
  }
}
main().catch(e => console.error('ERR:', e));
