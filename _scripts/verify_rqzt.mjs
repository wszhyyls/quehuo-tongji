// 用 get_store_inventory 的 SQL 直接加 SELECT DB_NAME() 来确认 Edge Function 连的是哪个库
// 但 action 参数没法自定义 SQL。换个思路：
// get_store_inventory 默认从 shortage_storestock_cache 查，不会查 SQL Server
// 但 force_refresh=true sync_first=false 会直查 SQL Server 的 dbo.SPFXB_Result
// 如果返回 0 行，说明要么库不对要么表空——用户截图证明库是 RQZT

// 让我试试改 Edge Function 的 SQL 查询——在本地改好 SQL 加跨库 RQZT.dbo.SPFXB_Result
// 但这涉及生产部署。先试试最简单的：
// 写一个本地 Node.js 脚本，用已知的 SQL Server 连接参数（从 Edge Function 环境变量里找）直接查 RQZT

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
  // 策略：get_store_inventory force_refresh=true 会跑 SQL 查询 dbo.SPFXB_Result
  // 如果 Edge Function 连的是 RQZT 库，应该有数据；如果是 ZHYYLS 则 0 行
  // 先看 ping 能不能告诉我实际连接情况
  const p = await post('ping', {});
  console.log('ping:', JSON.stringify(p));
  
  // 试试用 get_product_detail 先跑 EXEC SPFXB 再直查
  // 但 get_product_detail 没有 sync_first 参数...
  // 换 get_store_inventory，门店名用通配符
  const stores = await post('get_store_inventory', { store_name: '02第二药店', force_refresh: true, sync_first: false });
  const rows = stores.data?.[0] || [];
  console.log(`\nget_store_inventory(02第二药店, force=true, no-sync): ${rows.length} 行`);
  console.log(`_source: ${rows[0]?._source || '空'}`);
  if (rows.length > 0) {
    console.log('样本:', JSON.stringify(rows[0]).substring(0, 200));
  }
  
  // 关键：跑 EXEC SPFXB 再查
  const start = Date.now();
  const stores2 = await post('get_store_inventory', { store_name: '02第二药店', force_refresh: true, sync_first: true });
  const rows2 = stores2.data?.[0] || [];
  console.log(`\nget_store_inventory(02第二药店, force=true, sync_first=true): ${rows2.length} 行, 耗时 ${Date.now()-start}ms`);
  if (rows2.length > 0) {
    console.log('样本:', JSON.stringify(rows2[0]).substring(0, 200));
  }
  
  // 对比：缓存路径（不走 SQL Server）
  const storesCache = await post('get_store_inventory', { store_name: '02第二药店', force_refresh: false });
  const rows3 = storesCache.data?.[0] || [];
  console.log(`\nget_store_inventory(02第二药店, 缓存路径): ${rows3.length} 行`);
  console.log(`_source: ${rows3[0]?._source || '空'}`);
  
  console.log('\n===== 判断 =====');
  if (rows3.length > 0 && rows.length === 0) {
    console.log('✅ 缓存有数据，但 SQL Server 直查 0 行');
    console.log('   → Edge Function 连的库中 dbo.SPFXB_Result 是空的');
    console.log('   → 但 shortage_storestock_cache（Supabase）有数据（定时同步或手动同步写入）');
    console.log('   → 这说明 Edge Function 连的库与 SPFXB_Result 实际所在库不同！');
  }
}
main().catch(e => console.error('ERR:', e));
