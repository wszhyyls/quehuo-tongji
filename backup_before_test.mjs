// 备份缺货汇总 + 已完成订单 + Feedback 数据
// 用法: node backup_before_test.mjs

const SUPABASE_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co';
const FN_URL = `${SUPABASE_URL}/functions/v1/query-shortage-data`;
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

async function callAPI(action, params = {}, timeout = 120000) {
    const resp = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` },
        body: JSON.stringify({ action, params }),
        signal: AbortSignal.timeout(timeout)
    });
    return resp.json();
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const outputFile = `backup_${ts}.json`;

async function main() {
    console.log('══════════════════════════════════════');
    console.log('  缺货统计系统 - 数据备份');
    console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log('══════════════════════════════════════\n');

    // 1. 备份缺货汇总(包含 reports + plan)
    console.log('[1/2] 备份缺货汇总 + 订购计划...');
    const summary = await callAPI('get_summary', {});
    if (!summary.success) {
        console.error('❌ 获取缺货汇总失败:', summary.error);
        process.exit(1);
    }
    
    const reports = summary.data?.reports || [];
    const planRows = summary.data?.plan?.[0] || [];
    
    // 统计各状态数量
    const statusCount = {};
    const workingStatuses = ['待处理', '已订购', '已到货', '待付款', '配货中'];
    const completedStatuses = ['已完成', '厂家断货'];
    
    const planStatusCount = {};
    planRows.forEach(p => {
        const s = p.补货状态 || '未知';
        planStatusCount[s] = (planStatusCount[s] || 0) + 1;
    });
    
    console.log(`   Reports: ${reports.length} 条`);
    console.log(`   Plan (Shortage_OrderFeedback): ${planRows.length} 条`);
    console.log('   Plan 状态分布:');
    for (const [s, c] of Object.entries(planStatusCount).sort()) {
        const flag = completedStatuses.includes(s) ? '✅' : workingStatuses.includes(s) ? '🔄' : '  ';
        console.log(`     ${flag} ${s}: ${c} 条`);
    }

    // 2. 备份状态变更日志
    console.log('\n[2/2] 备份状态变更日志...');
    const logs = await callAPI('get_status_change_log', { top: 500 });
    const logRecords = logs.data || [];
    console.log(`   状态变更日志: ${logRecords.length} 条`);

    // 3. 保存
    const backup = {
        time: new Date().toISOString(),
        summary: {
            reports_count: reports.length,
            plan_count: planRows.length,
            plan_status_distribution: planStatusCount,
        },
        reports: reports.map(r => ({
            product_code: r.product_code,
            product_name: r.product_name,
            store_name: r.store_name || r.store_id,
            replenish_status: r.replenish_status,
            demand_quantity: r.demand_quantity,
            created_at: r.created_at,
            order_type: r.order_type,
        })),
        plan: planRows.map(p => ({
            商品编码: p.商品编码,
            商品名称: p.商品名称,
            补货状态: p.补货状态,
            实际订货数量: p.实际订货数量,
            仓库库存: p.仓库库存,
            订货时间: p.订货时间,
            到货确认时间: p.到货确认时间,
            备注: p.备注,
        })),
        status_logs: logRecords,
    };

    const fs = await import('fs');
    fs.writeFileSync(outputFile, JSON.stringify(backup, null, 2), 'utf-8');
    console.log(`\n✅ 备份完成! 文件: ${outputFile}`);
    console.log(`   文件大小: ${(fs.statSync(outputFile).size / 1024).toFixed(1)} KB`);
}

main().catch(e => {
    console.error('❌ 备份异常:', e.message);
    process.exit(1);
});
