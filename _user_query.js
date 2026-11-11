// === 缺货汇总 6 行需求 0 查证 ===
const https = require('https');
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

function edgePost(action, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, params });
    const url = new URL('https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data');
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function toBjDate(utc) {
  if (!utc) return '';
  const d = new Date(utc);
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 8 * 3600000).toISOString().substring(0, 10);
}

(async () => {
  const targetCodes = ['010196', '1020448', '4633', '1020548', '020158', '15803'];
  
  const resp = await edgePost('get_summary', { active_only: false });
  const d = resp.data;
  const allReports = d.reports || [];
  const epMap = d.effectivePurchaseMap || {};
  const prMap = d.poolRemainingMap || {};
  const whMap = d.warehouseStockMap || {};
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`【6 个商品完整数据】北京时间 ${new Date(Date.now()+8*3600000).toISOString().substring(0,10)}`);
  console.log(`${'='.repeat(70)}`);
  
  for (const code of targetCodes) {
    const reports = allReports.filter(r => (r.product_code || '').trim() === code);
    if (reports.length === 0) { console.log(`\n${code}: 无任何 report`); continue; }
    
    const name = reports[0].product_name;
    const spec = reports[0].specification;
    const mfr = reports[0].manufacturer;
    
    const ep = Number(epMap[code]) || 0;
    const pr = Number(prMap[code]) || 0;
    const wh = Number(whMap[code]) || 0;
    
    // 按 replenish_status 分类 pending
    const pendingReports = reports.filter(r => !['已完成','已配送','已关闭','厂家断货'].includes(r.replenish_status));
    const pendingDemand = pendingReports.reduce((s, r) => s + (Number(r.demand_quantity) || 0), 0);
    const anchorDate = pendingReports.length > 0 
      ? pendingReports.map(r => r.created_at).sort()[0] 
      : null;
    
    const effectiveAvail = Math.max(ep, wh);
    const gap = Math.max(0, pendingDemand - effectiveAvail);
    const gapSrc = ep > wh ? `effectivePurchase(${ep}) 撑住` 
                  : wh > ep ? `warehouseStock(${wh}) 撑住` 
                  : ep === wh ? `两者相等(${ep})` 
                  : '无（gap=0 但 pendingDemand=0）';
    
    console.log(`\n📦 ${code} ${name} (${spec})`);
    console.log(`  pending reports: ${pendingReports.length} 条, pendingDemand: ${pendingDemand}`);
    console.log(`  reports 明细:`);
    reports.forEach((r, i) => {
      const bj = toBjDate(r.created_at);
      console.log(`    [${i+1}] ${bj} ${r.store_name} 需${r.demand_quantity} → status=${r.replenish_status} (order_type=${r.order_type})`);
    });
    console.log(`  Edge Function 返回:`);
    console.log(`    effectivePurchaseMap = ${ep}  有效入库总量`);
    console.log(`    poolRemainingMap     = ${pr}  FIFO扣减后剩余`);
    console.log(`    warehouseStockMap    = ${wh}  仓库当前库存`);
    console.log(`  缺口计算:`);
    console.log(`    effectiveAvail = max(${ep}, ${wh}) = ${effectiveAvail}`);
    console.log(`    gap = max(0, ${pendingDemand} - ${effectiveAvail}) = ${gap}`);
    console.log(`    gap=0 靠: ${gapSrc}`);
    if (anchorDate) console.log(`    FIFO 锚点日期(最早pending report): ${toBjDate(anchorDate)}`);
  }

  // === 020158 特别追踪 ===
  console.log(`\n${'='.repeat(70)}`);
  console.log(`【重点: 020158 待付款 + 需求0 查证】`);
  console.log(`${'='.repeat(70)}`);
  const r158 = allReports.filter(r => (r.product_code || '').trim() === '020158');
  console.log(`  全部 reports (${r158.length} 条):`);
  r158.forEach((r, i) => {
    console.log(`    [${i+1}] ${toBjDate(r.created_at)} ${r.store_name} 需${r.demand_quantity} → ${r.replenish_status} supplier=${r.supplier_id || '?'}`);
  });
  console.log(`  gap=0 来源: max(ep=${epMap['020158']||0}, wh=${whMap['020158']||0}) = ${Math.max(Number(epMap['020158'])||0, Number(whMap['020158'])||0)}`);
  console.log(`  → 待付款订单本身算不算入 effectivePurchaseMap？答：不算。`);
  console.log(`    effectivePurchaseMap 只查 BillType=34 (采购入库) + InKRec=3 (入库)`);
  console.log(`    待付款是 BillType=14 (采购订单)，不会进 effectivePurchaseMap`);
  console.log(`  → gap=0 实际是靠 warehouseStockMap=${whMap['020158']||0} 兜住的`);
  
})().catch(e => console.error(e));
