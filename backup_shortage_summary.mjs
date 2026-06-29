// 备份缺货订购汇总 + 已完成订单（通过 Edge Function API）
// 用法：node backup_shortage_summary.mjs
// 恢复：node restore_shortage_summary.mjs <备份文件名>

import fs from 'fs';

const SUPABASE_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co';
const FN_URL = `${SUPABASE_URL}/functions/v1/query-shortage-data`;
const KB = process.env.SUPABASE_SERVICE_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

console.log(`🔑 密钥: ${process.env.SUPABASE_SERVICE_KEY ? 'service_role' : 'anon'}`);

async function callAPI(action, params, timeout = 120000) {
    const resp = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KB}` },
        body: JSON.stringify({ action, params }),
        signal: AbortSignal.timeout(timeout)
    });
    return resp.json();
}

const now = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const outputFile = `backup_data_${now}.json`;

async function backup() {
    console.log('══════════════════════════════');
    console.log('  缺货统计系统 - 数据备份');
    console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log('══════════════════════════════\n');

    const backup = {
        backup_time: new Date().toISOString(),
        version: 'v5.5.0',
        data: {},
        stats: {}
    };

    // 1. 备份缺货汇总 (get_summary 包含 reports + plan + supplierLookup)
    console.log('[1/4] 备份缺货汇总 (reports + plan)...');
    try {
        const r = await callAPI('get_summary', {});
        if (r.success) {
            backup.data.summary = r.data;
            const reports = r.data.reports || [];
            console.log(`   ✅ reports: ${reports.length} 条`);
            const plan = r.data.plan?.[0] || [];
            console.log(`   ✅ plan   : ${plan.length} 条`);
        } else {
            console.error(`   ❌ ${r.error}`);
        }
    } catch (e) {
        console.error(`   ❌ ${e.message}`);
    }

    // 2. 备份所有商品 (全量拉取)
    console.log('[2/4] 备份商品列表...');
    try {
        const r = await callAPI('get_all_products', {}, 240000);
        if (r.success) {
            backup.data.products = r.data;
            const count = Array.isArray(r.data) ? r.data.length : 0;
            console.log(`   ✅ ${count} 个商品`);
        } else {
            console.error(`   ❌ ${r.error || '未知错误'}`);
        }
    } catch (e) {
        console.error(`   ❌ ${e.message}`);
    }

    // 3. 批量获取所有库存数据
    console.log('[3/4] 备份库存数据...');
    try {
        // 通过同步全量库存 action 获取全部库存
        const r = await callAPI('sync_inventory_full', {}, 120000);
        if (r.success) {
            backup.data.inventory = r.data;
            console.log(`   ✅ 库存数据: 已获取`);
        } else {
            console.error(`   ❌ ${r.error || '未知错误'}`);
        }
    } catch (e) {
        console.error(`   ❌ ${e.message}`);
    }

    // 4. 备份状态变更日志（最近的）
    console.log('[4/4] 备份状态变更日志...');
    try {
        const r = await callAPI('get_status_log', { top: 300 });
        if (r.success) {
            backup.data.status_log = r.data;
            const count = Array.isArray(r.data) ? (r.data.length || r.data[0]?.length || 0) : 0;
            console.log(`   ✅ ${count} 条日志`);
        } else {
            console.error(`   ❌ ${r.error}`);
        }
    } catch (e) {
        console.error(`   ❌ ${e.message}`);
    }

    // 统计
    const reports = backup.data.summary?.reports || [];
    const plan = backup.data.summary?.plan?.[0] || [];
    const products = backup.data.products || [];

    backup.stats = {
        total_reports: reports.length,
        shortage_items: (backup.data.summary?.shortage_by_product)?.length || plan.length || 0,
        completed_orders: reports.filter(r => r.replenish_status === '已完成' || r.replenish_status === '厂家断货').length,
        pending_orders: reports.filter(r => r.replenish_status === '待处理').length,
        ordered_orders: reports.filter(r => r.replenish_status === '已订购').length,
        arrived_orders: reports.filter(r => r.replenish_status === '已到货').length,
        new_products: (backup.data.summary?.new_products_grouped)?.length || 0,
        unique_products: [...new Set(reports.map(r => r.product_code).filter(Boolean))].length,
        product_count: Array.isArray(products) ? products.length : 0,
    };

    // 写入
    const json = JSON.stringify(backup, null, 2);
    fs.writeFileSync(outputFile, json, 'utf-8');
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);

    console.log('\n══════════════════════════════');
    console.log('  备份统计');
    console.log('══════════════════════════════');
    console.log(`  上报总数        : ${backup.stats.total_reports}`);
    console.log(`  缺货品种        : ${backup.stats.shortage_items}`);
    console.log(`  待处理          : ${backup.stats.pending_orders}`);
    console.log(`  已订购          : ${backup.stats.ordered_orders}`);
    console.log(`  已到货          : ${backup.stats.arrived_orders}`);
    console.log(`  已完成/断货     : ${backup.stats.completed_orders}`);
    console.log(`  新品品种        : ${backup.stats.new_products}`);
    console.log(`  涉及商品        : ${backup.stats.unique_products}`);
    console.log(`  商品总数        : ${backup.stats.product_count}`);
    console.log(`──────────────────────────────`);
    console.log(`  📁 ${outputFile} (${sizeKB} KB)`);
    console.log('');
    console.log('  ✅ 备份完成，可以开始测试！');
    console.log('  如需恢复，运行: node restore_shortage_summary.mjs ' + outputFile);
    console.log('══════════════════════════════');
}

backup().catch(e => {
    console.error('备份失败:', e);
    process.exit(1);
});
