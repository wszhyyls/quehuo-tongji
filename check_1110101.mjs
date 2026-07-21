// 查询商品 1110101 的所有上报记录
const FN_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data';
const KB = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

const resp = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KB}` },
    body: JSON.stringify({ action: 'get_summary', params: {} }),
    signal: AbortSignal.timeout(60000)
});
const result = await resp.json();
const reports = result.data?.reports || [];
const productReports = reports.filter(r => 
    r.product_code === '1110101' || 
    r.product_code?.replace(/^0+/, '') === '1110101'
);

console.log(`商品 1110101 的所有上报记录 (${productReports.length} 条):\n`);
productReports.forEach(r => {
    console.log(`门店: ${r.store_id || r.store_name}`);
    console.log(`  时间: ${r.created_at}`);
    console.log(`  需求: ${r.demand_quantity}`);
    console.log(`  状态: ${r.replenish_status}`);
    console.log(`  库存: ${r.current_stock}, 在途: ${r.in_transit}`);
    console.log(`  上报人: ${r.reporter_name || r.reporter_phone || '-'}`);
    console.log('---');
});
