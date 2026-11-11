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
  // 缓存路径（不 force_refresh）：走 Supabase shortage_storestock_cache
  console.log('===== 缓存路径 vs SQL 直查 =====');
  const stores = ['16凤凰山药店', '04第四药店', '03第三药店', '016'];
  for (const s of stores) {
    const [cached, direct] = await Promise.all([
      post('get_store_inventory', { store_name: s, force_refresh: false }),
      post('get_store_inventory', { store_name: s, force_refresh: true, sync_first: false })
    ]);
    const cacheRows = cached.data?.[0]?.length || 0;
    const directRows = direct.data?.[0]?.length || 0;
    const cacheSrc = cached.data?.[0]?.[0]?._source || '空';
    const directSrc = direct.data?.[0]?.[0]?._source || '空';
    console.log(`${s}: cache=${cacheRows}(_source=${cacheSrc}), direct=${directRows}(_source=${directSrc})`);
  }
  // 再调 syncPurchasePlan 的存储过程 usp_Sync_AllShortageCache（定时任务的存储过程）
  // 定时任务不会被手动触发，但 sync_inventory_incremental action 会 SELECT FROM SPFXB_Result → 我试试 get_product_detail force_refresh
  console.log('\n===== usp_Sync_AllShortageCache 耗时（定时任务调的）=====');
  const start = Date.now();
  const r = await post('get_store_inventory', { store_name: '16凤凰山药店', force_refresh: true, sync_first: true });
  console.log(`sync_first + force_refresh 总耗时: ${Date.now() - start}ms`);
  
  // 关键对比：跑 SPFXB 之前 vs 之后，同一个门店的直查结果变没变
  // 缓存路径肯定有数据（shortage_storestock_cache 是定时同步的）
  // 直查路径如果还是 0 → 说明 SPFXB 存储过程重建后结果就是空的，或者 SQL 有问题
}
main().catch(e => console.error('ERR:', e));
