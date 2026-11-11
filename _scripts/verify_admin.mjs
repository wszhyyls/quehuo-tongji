// 并行验证：admin.js 漏改的渲染路径 + RQZT vs ZHYYLS 两个库的 SPFXB_Result
const ED = 'https://wszhyy.pages.dev';
const EDGE = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data';
const SECRET = 'wszh_auto_sync_2026';
const fetch = global.fetch;

async function main() {
  const ts = Date.now();
  
  // ====== 【1】拉线上 admin.js 全文，逐一列出所有"已完成"出现点 ======
  console.log('========== 【1】线上 admin.js 全量 "已完成" 位置 ==========');
  const j = await fetch(`${ED}/static/js/admin.js?t=${ts}`).then(r => r.text());
  const jLines = j.split('\n');
  console.log(`总行数: ${jLines.length}, "已完成" 出现 ${(j.match(/已完成/g)||[]).length} 次, "已入库" ${(j.match(/已入库/g)||[]).length} 次`);
  
  let renderPoints = [];
  jLines.forEach((l, i) => {
    if (l.includes('已完成')) {
      const trimmed = l.trim();
      // 分类：显示 vs 逻辑 vs 注释
      let cat = '❓待查';
      if (trimmed.includes('//')) cat = '📝注释';
      else if (trimmed.includes("'已完成'") || trimmed.includes('"已完成"')) {
        if (trimmed.includes('innerHTML') || trimmed.includes('textContent') || trimmed.includes('showToast') ||
            trimmed.includes('label') || trimmed.includes('desc') || trimmed.includes('title') ||
            trimmed.includes('render') || trimmed.includes('状态') || trimmed.includes('tag') ||
            trimmed.includes('option') || trimmed.includes('card') || trimmed.includes('折叠')) {
          cat = '⚠️ 可能是显示文本';
        } else {
          cat = '🔧逻辑值/比较';
        }
      }
      renderPoints.push({ line: i+1, cat, text: trimmed.slice(0, 160) });
    }
  });
  console.log('\n所有 "已完成" 出现点:');
  renderPoints.forEach(p => console.log(`  L${p.line} [${p.cat}] ${p.text}`));
  
  // ====== 【3】试直接从 Edge Function 查 RQZT 库的 SPFXB_Result ======
  console.log('\n========== 【3】查 RQZT vs ZHYYLS 两个库 ==========');
  
  // Edge Function 的 SQL 连接串 initialCatalog 是什么？
  // 先试试直接在 SQL 里指定跨库查询
  async function post(action, params) {
    const r = await fetch(EDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-task-secret': SECRET },
      body: JSON.stringify({ action, params })
    });
    return r.json();
  }
  
  // 用 get_store_inventory 但强行指定 SQL 查询不同的库
  // 先确认 Edge Function 默认 initialCatalog
  const pg = await post('ping', {});
  console.log('ping:', JSON.stringify(pg));
  
  // sync_inventory_incremental 会 SELECT FROM dbo.SPFXB_Result —— 查不到是因为库不对
  // 但 get_store_inventory 的 SQL 是写死 FROM dbo.SPFXB_Result
  // 我得改 SQL 为 RQZT.dbo.SPFXB_Result... 但那要改 Edge Function
  
  // 临时方案：我先用本地 sqlcmd 试试能不能跨库
}
main().catch(e => console.error('ERR:', e));
