const raw = JSON.parse(require('fs').readFileSync(process.env.TEMP + '\\edge_summary3.json', 'utf8'));
const data = raw.data || raw;
console.log('Top keys:', Object.keys(raw).join(', '));
console.log('Data keys:', Object.keys(data).join(', '));

if (data.effectivePurchaseMap) {
  console.log('\n=== effectivePurchaseMap ===');
  const entries = Object.entries(data.effectivePurchaseMap).sort((a,b) => Number(b[1]) - Number(a[1]));
  entries.forEach(([code, val]) => console.log('  ' + code + ': ' + val));
  console.log('\n0564 effectivePurchaseMap:', data.effectivePurchaseMap['0564']);
}
if (data.poolRemainingMap) {
  console.log('\n=== poolRemainingMap ===');
  console.log('0564:', data.poolRemainingMap['0564']);
}
if (data.warehouseStockMap) {
  console.log('\n=== warehouseStockMap ===');
  console.log('0564:', data.warehouseStockMap['0564']);
}
if (data.reports) {
  const r0564 = data.reports.filter(r => r.product_code === '0564');
  console.log('\n=== 0564 reports from API ===');
  console.log('Count:', r0564.length);
  r0564.forEach(r => console.log('  id=' + r.id + ' store=' + r.store_id + ' demand=' + r.demand_quantity + ' status=' + r.replenish_status + ' type=' + r.order_type + ' created=' + r.created_at));
}
