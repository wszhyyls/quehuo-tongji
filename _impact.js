// === 影响预估：gap 只认 effectivePurchase vs 现状 ===
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

(async () => {
  const resp = await edgePost('get_summary', { active_only: true });
  const d = resp.data;
  const reports = d.reports || [];
  const epMap = d.effectivePurchaseMap || {};
  const prMap = d.poolRemainingMap || {};
  const whMap = d.warehouseStockMap || {};
  
  const terminalStatuses = ['已完成', '已配送', '已关闭', '厂家断货'];
  const productAgg = {};
  for (const r of reports) {
    const code = (r.product_code || '').trim();
    if (!code || terminalStatuses.includes(r.replenish_status || '')) continue;
    if (!productAgg[code]) productAgg[code] = { code, name: r.product_name || '', statuses: new Set(), pendingDemand: 0 };
    productAgg[code].pendingDemand += Number(r.demand_quantity) || 0;
    productAgg[code].statuses.add(r.replenish_status);
  }
  
  const products = Object.values(productAgg);
  
  let curZero = 0, curGt0 = 0;   // 现状 max(ep,wh)
  let newZero = 0, newGt0 = 0;   // 只认 ep
  let newZeroOnlyWh = 0;         // 现状 gap=0 但只认 ep 后 gap>0（靠库存兜住的假 0）
  const newZeroOnlyWhList = [];
  
  for (const p of products) {
    const ep = Number(epMap[p.code]) || 0;
    const wh = Number(whMap[p.code]) || 0;
    const demand = p.pendingDemand;
    
    const gapCur = Math.max(0, demand - Math.max(ep, wh));
    const gapNew = Math.max(0, demand - ep);
    
    if (gapCur === 0) curZero++; else curGt0++;
    if (gapNew === 0) newZero++; else newGt0++;
    
    if (gapCur === 0 && gapNew > 0) {
      newZeroOnlyWh++;
      newZeroOnlyWhList.push({
        code: p.code, name: p.name, demand, ep, wh,
        curGap: 0, newGap: gapNew,
        statuses: [...p.statuses].join('/'),
        zeroSource: ep >= wh ? 'both(ep>=wh)' : 'wh_only'
      });
    }
  }
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`【影响预估：汇总表 ${products.length} 个 pending 商品】`);
  console.log(`${'='.repeat(70)}`);
  console.log(`\n口径对比：`);
  console.log(`  A. 现状（v5.15.9 max(ep,wh)）: gap=0 → ${curZero}, gap>0 → ${curGt0}`);
  console.log(`  B. 只认 ep（统一判定层）: gap=0 → ${newZero}, gap>0 → ${newGt0}`);
  console.log(`  变化：gap=0 减少 ${curZero - newZero} → gap>0 增加 ${newGt0 - curGt0}`);
  console.log(`\n核心发现：${newZeroOnlyWh} 个商品"现状 gap=0 但只认 ep 后 gap>0"`);
  console.log(`  → 这些是靠 warehouseStock 兜出来的假 0，判定层不认 → 状态不动 → 永远留在汇总表`);
  
  newZeroOnlyWhList.sort((a,b) => b.newGap - a.newGap);
  console.log(`\n📋 假 0 清单（靠库存兜住、判定层不认）：`);
  console.log(`  ${'代码'.padEnd(12)}${'品名'.padEnd(16)}${'需求'.padStart(5)}${'ep'.padStart(5)}${'wh'.padStart(5)}${'新缺口'.padStart(5)}${'状态'.padEnd(12)}来源`);
  newZeroOnlyWhList.forEach(x => {
    console.log(`  ${x.code.padEnd(12)}${x.name.padEnd(14).slice(0,14)}${String(x.demand).padStart(5)}${String(x.ep).padStart(5)}${String(x.wh).padStart(5)}${String(x.newGap).padStart(5)}${x.statuses.padEnd(12)}${x.zeroSource}`);
  });
  
  // 四行实证
  console.log(`\n${'='.repeat(70)}`);
  console.log(`【四行实证：用户截图那四个 gap=0 的商品】`);
  console.log(`${'='.repeat(70)}`);
  const fourCodes = ['1020448', '4633', '020158', '15803'];
  for (const code of fourCodes) {
    const p = productAgg[code];
    if (!p) { console.log(`\n${code}: 无 pending`); continue; }
    const ep = Number(epMap[code]) || 0;
    const wh = Number(whMap[code]) || 0;
    const demand = p.pendingDemand;
    const gapCur = Math.max(0, demand - Math.max(ep, wh));
    const gapEp = Math.max(0, demand - ep);
    const gapWh = Math.max(0, demand - wh);
    
    console.log(`\n📦 ${code} ${p.name}`);
    console.log(`  需求=${demand}, effectivePurchase=${ep}, warehouseStock=${wh}`);
    console.log(`  max(ep,wh)=${Math.max(ep,wh)} → 现状gap=${gapCur} (v5.15.9显示)`);
    console.log(`  只认 ep=${ep} → 新gap=${gapEp}`);
    console.log(`  只认 wh=${wh} → 纯库存gap=${gapWh}`);
    console.log(`  当前状态: ${[...p.statuses].join(',')}`);
    console.log(`  gap=0 来源: ${ep >= wh ? `ep(${ep}) 够需求` : `wh(${wh}) 够需求但 ep=${ep} 不够 → 判定层不认!`}`);
  }
  
})().catch(e => console.error(e));
