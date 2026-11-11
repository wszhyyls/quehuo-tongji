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
  // 直接 get_product_detail——这个之前是正常的
  console.log('===== get_product_detail 完整 JSON =====');
  const r = await post('get_product_detail', { product_code: '6010168', force_refresh: false });
  console.log('缓存路径:', JSON.stringify(r).substring(0, 400));
  
  const r2 = await post('get_product_detail', { product_code: '6010168', force_refresh: true });
  console.log('force_refresh:', JSON.stringify(r2).substring(0, 400));
  
  // 再查 1110051
  const r3 = await post('get_product_detail', { product_code: '1110051', force_refresh: false });
  console.log('1110051 缓存:', JSON.stringify(r3).substring(0, 400));
  
  // 查 sync_inventory_incremental 的错误
  const r4 = await post('sync_inventory_incremental', { since: null });
  console.log('sync_inventory_incremental:', JSON.stringify(r4).substring(0, 500));
}
main().catch(e => console.error('ERR:', e));
