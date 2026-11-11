// 【A】验证线上文件
const fetch = global.fetch;
const ED = 'https://wszhyy.pages.dev';
const ts = Date.now();

async function main() {
  console.log('===== A1. 线上 admin.html 验证 =====');
  const h = await fetch(`${ED}/admin.html?t=${ts}`).then(r => r.text());
  console.log('  含「已入库」:', (h.match(/已入库/g)||[]).length, '次');
  console.log('  含「已完成」:', (h.match(/已完成/g)||[]).length, '次');
  const opts = [...h.matchAll(/<option value="已完成">([^<]+)<\/option>/g)];
  console.log('  option label 全量:', opts.map(m=>m[1]).join(', '));
  const cardLabel = h.match(/stat-label">(.*?)<\/span>/g);
  console.log('  stat-card label:', cardLabel?.join(', ') || '(无)');
  const helpTab = h.includes('📖 操作说明') ? '✅ 有' : '❌ 无';
  console.log('  操作说明TAB:', helpTab);

  console.log('\n===== A2. 线上 admin.js 验证 =====');
  const j = await fetch(`${ED}/static/js/admin.js?t=${ts}`).then(r => r.text());
  console.log('  含「已入库」:', (j.match(/已入库/g)||[]).length, '次');
  console.log('  含「已完成」:', (j.match(/已完成/g)||[]).length, '次');

  // 找出所有"已完成"出现位置，区分显示 vs 逻辑
  const jsLines = j.split('\n');
  console.log('\n  === admin.js 内所有「已完成」位置 ===');
  jsLines.forEach((l, i) => {
    if (l.includes('已完成')) {
      const trimmed = l.trim();
      let cat = '逻辑';
      if (trimmed.includes('innerHTML') || trimmed.includes('showToast') || trimmed.includes('title=') || 
          trimmed.includes('desc') || trimmed.includes('label') || trimmed.includes('状态')) cat = '⚠️ 显示';
      console.log(`    L${i+1} [${cat}] ${trimmed.slice(0,140)}`);
    }
  });

  console.log('\n===== A3. 本地文件 vs 线上文件 diff =====');
  const fs = await import('fs');
  const localH = fs.readFileSync('G:/Trae项目/缺货统计系统/deploy/admin.html','utf8');
  const localJ = fs.readFileSync('G:/Trae项目/缺货统计系统/deploy/static/js/admin.js','utf8');
  console.log('  本地 admin.html 含「已入库」:', (localH.match(/已入库/g)||[]).length);
  console.log('  本地 admin.js 含「已入库」:', (localJ.match(/已入库/g)||[]).length);
  console.log('  线上 admin.html 含「已入库」:', (h.match(/已入库/g)||[]).length);
  console.log('  线上 admin.js 含「已入库」:', (j.match(/已入库/g)||[]).length);
  console.log('  本地和线上 HTML 一致?', localH === h ? '✅ 一致' : '❌ 不同（线上被 SW 缓存或部署副本）');
  console.log('  本地和线上 JS 一致?', localJ === j ? '✅ 一致' : '❌ 不同');
}
main().catch(e => console.error('ERR:', e));
