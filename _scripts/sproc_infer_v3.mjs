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
  // 先查 shortage_storestock_cache 有多少条
  const { createClient } = await import('@supabase/supabase-js');
  const c = createClient('https://qswpgnnedqvuegwfbprd.supabase.co', 
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI');
  const cnt = await c.from('shortage_storestock_cache').select('*', { count: 'exact', head: true });
  console.log('shortage_storestock_cache 总行数:', cnt.count);
  
  // get_product_detail 缓存路径
  console.log('\n===== get_product_detail 缓存路径 vs 直查 =====');
  const codes = ['6010168', '2040186', '1110051', '2040162'];
  for (const code of codes) {
    const [cached, directNoSync] = await Promise.all([
      post('get_product_detail', { product_code: code, store_name: null, force_refresh: false }),
      post('get_product_detail', { product_code: code, store_name: null, force_refresh: true, sync_first: false })
    ]);
    const cr = cached.data?.[0] || [];
    const dr = directNoSync.data?.[0] || [];
    const csrc = cr[0]?._source || '空';
    const dsrc = dr[0]?._source || '空';
    console.log(`${code}: cache=${cr.length}(src=${csrc}), direct_no_sync=${dr.length}(src=${dsrc})`);
  }
  
  // 跑 EXEC SPFXB 再直查
  console.log('\n===== 跑 EXEC SPFXB 后再直查 =====');
  const codes2 = ['6010168', '2040186'];
  for (const code of codes2) {
    const start = Date.now();
    const r = await post('get_product_detail', { product_code: code, store_name: null, force_refresh: true, sync_first: true });
    const dr = r.data?.[0] || [];
    console.log(`${code} (sync_first+force): ${Date.now()-start}ms, ${dr.length} 条`);
  }
}
main().catch(e => console.error('ERR:', e));
