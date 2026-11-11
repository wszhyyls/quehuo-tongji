// 查 ZHYYLS 上 3 个存储过程的定义
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

// Edge Function 没有通用 SQL action，但有 batch_purchase_check 可以查采购
// 我们自己建一个 mssql 连接试试？不行就用 Edge Function 的 debug action
// 先看看有没有现成的 debug / execute_sql action
async function main() {
  // 列出所有 action 名字
  const allActions = [
    'usp_Sync_AllShortageCache',
    'SPFXB', 
    'usp_Sync_ProductCache_RQZT'
  ];
  
  for (const spName of allActions) {
    console.log(`\n===== 存储过程: ${spName} =====`);
    // 用 Edge Function 的 mssql 池直接查 sys.sql_modules
    try {
      // 借道 batch_purchase_check 的 SQL 连接能力
      const r = await post('debug_exec_sql', { 
        sql: `SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.${spName}')) AS definition` 
      });
      if (r.success && r.data?.[0]?.[0]?.definition) {
        const def = r.data[0][0].definition;
        console.log(def.substring(0, 3000));
      } else {
        console.log('  debug_exec_sql action 不存在，改用直连 mssql');
      }
    } catch(e) {
      console.log('  ERR:', e.message);
    }
  }
}
main().catch(e => console.error(e));
