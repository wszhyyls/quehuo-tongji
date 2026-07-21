// 检查指定商品的详细状态
// 用法: node check_product_status.mjs 1376

const productCode = process.argv[2];
if (!productCode) {
    console.error('请指定商品编码: node check_product_status.mjs 1376');
    process.exit(1);
}

const FN_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data';
const KB = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

async function check() {
    console.log(`查询商品 ${productCode} 的状态...\n`);
    
    // 1. 查询 Supabase reports
    console.log('[1] Supabase reports 中的记录:');
    const summaryResp = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KB}` },
        body: JSON.stringify({ action: 'get_summary', params: {} }),
        signal: AbortSignal.timeout(60000)
    });
    const summary = await summaryResp.json();
    const reports = summary.data?.reports || [];
    const productReports = reports.filter(r => r.product_code === productCode || r.product_code?.replace(/^0+/, '') === productCode);
    
    if (productReports.length === 0) {
        console.log('   ❌ 未找到上报记录');
    } else {
        productReports.forEach(r => {
            console.log(`   - 门店: ${r.store_id}, 需求: ${r.demand_quantity}, 状态: ${r.replenish_status}, 时间: ${r.created_at}`);
        });
    }
    
    // 2. 查询采购计划
    console.log('\n[2] SQL Server 采购计划:');
    const planResp = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KB}` },
        body: JSON.stringify({ action: 'get_purchase_plan', params: { plan_product_code: productCode } }),
        signal: AbortSignal.timeout(60000)
    });
    const plan = await planResp.json();
    if (plan.success && plan.data) {
        const planData = plan.data.plan?.[0] || plan.data;
        console.log('   计划数据:', JSON.stringify(planData, null, 2).substring(0, 500));
    } else {
        console.log('   无计划数据');
    }
    
    // 3. 查询库存详情
    console.log('\n[3] 库存详情:');
    const detailResp = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KB}` },
        body: JSON.stringify({ action: 'get_product_detail', params: { product_code: productCode } }),
        signal: AbortSignal.timeout(60000)
    });
    const detail = await detailResp.json();
    if (detail.success && detail.data) {
        console.log('   库存数据:', JSON.stringify(detail.data, null, 2).substring(0, 800));
    } else {
        console.log('   无库存数据');
    }
}

check().catch(e => console.error('查询失败:', e));
