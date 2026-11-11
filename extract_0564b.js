const raw = JSON.parse(require('fs').readFileSync(process.env.TEMP + '\\edge_summary3.json', 'utf8'));
const data = raw.data || raw;

// Find 0564 plan records (补货计划)
if (data.plan && data.plan.length > 0) {
  console.log('=== 0564 from plan ===');
  data.plan.forEach(row => {
    if (row['商品编码'] === '0564' || (row.product_code === '0564')) {
      console.log(JSON.stringify(row, null, 2));
    }
  });
}

// Check 0564 in completed_summary
if (data.completed_summary) {
  console.log('\n=== 0564 in completed_summary ===');
  const c0564 = data.completed_summary.filter(c => c.product_code === '0564');
  console.log(c0564);
}

// Show how many pending codes have positive effectivePurchase
if (data.effectivePurchaseMap) {
  console.log('\n=== Effective Purchase positive codes ===');
  const pos = Object.entries(data.effectivePurchaseMap).filter(([c, v]) => v > 0);
  pos.forEach(([c, v]) => console.log('  ' + c + ': ' + v));
}
