// 【反推法】测 usp_Sync_AllShortageCache 和 SPFXB 对 SPFXB_Result 的影响
// 思路：先查 SPFXB_Result 当前行数 → 调存储过程 → 再查行数 + 数据内容变化
// 用 sync_inventory_incremental action（它会 SELECT * FROM dbo.SPFXB_Result）
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
  // sync_inventory_incremental action 会查 SPFXB_Result → Supabase
  // 我先调它一次，拿到 SPFXB_Result 的原始行数和一些样本
  console.log('===== 步骤 1: 基线 — 直接拉 SPFXB_Result 样本 =====');
  const base = await post('sync_inventory_incremental', { since: null });
  // 这个 action 主要是 upsert 到 Supabase，但 result 里应该有 synced 条数
  console.log('sync_inventory_incremental 返回:', JSON.stringify(base).substring(0, 500));
  
  // 用 batch_purchase_check 是查 vBuySendSumDetail 的，不走 SPFXB_Result
  // 但 get_product_detail / get_store_inventory 会走 SPFXB_Result
  // 我用 get_store_inventory force_refresh=true（直接查 SPFXB_Result，不走缓存）
  console.log('\n===== 步骤 2: 直接查 SPFXB_Result（get_store_inventory force_refresh）=====');
  const now = Date.now();
  const storeQ = await post('get_store_inventory', { 
    store_name: '04第四药店', 
    force_refresh: true,  // 跳过缓存，直接查 SPFXB_Result
    sync_first: false      // 不先跑存储过程！
  });
  const elapsed1 = Date.now() - now;
  console.log(`get_store_inventory(force,no-sync): ${elapsed1}ms`);
  const rows1 = storeQ.data?.[0]?.length || 0;
  console.log(`04第四药店 门店记录数: ${rows1}`);
  
  // 关键：force_refresh=true 且 sync_first=true 时，会先跑 EXEC SPFXB 再查
  console.log('\n===== 步骤 3: 先跑 EXEC SPFXB 再查 =====');
  const now2 = Date.now();
  const storeSync = await post('get_store_inventory', { 
    store_name: '04第四药店', 
    force_refresh: true, 
    sync_first: true       // 先跑 EXEC SPFXB！
  });
  const elapsed2 = Date.now() - now2;
  console.log(`get_store_inventory(force,sync-first): ${elapsed2}ms`);
  const rows2 = storeSync.data?.[0]?.length || 0;
  console.log(`04第四药店 门店记录数: ${rows2}`);
  console.log(`SPFXB 存储过程耗时大约: ${elapsed2 - elapsed1}ms（两个分支时间差）`);
  
  // 最后对比：有没有 TRUNCATE 的痕迹？行数变没变？
  console.log('\n===== 结论 =====');
  console.log(`SPFXB_Result 行数变化: ${rows1} → ${rows2}`);
  if (rows1 !== rows2) {
    console.log('  ⚠️ 行数变化 → EXEC SPFXB 很可能在重建 TRUNCATE+INSERT');
  } else {
    console.log('  ✅ 行数不变 → EXEC SPFXB 可能是增量更新（或没影响该门店）');
  }
}
main().catch(e => console.error('ERR:', e));
