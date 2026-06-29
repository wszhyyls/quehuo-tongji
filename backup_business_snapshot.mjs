// 业务数据快照备份（与页面显示一致）
// 用法：node backup_business_snapshot.mjs

import fs from 'fs';

const SUPABASE_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co';
const FN_URL = `${SUPABASE_URL}/functions/v1/query-shortage-data`;
const KB = process.env.SUPABASE_SERVICE_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

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
const outputFile = `business_snapshot_${now}.json`;

async function backup() {
    console.log('══════════════════════════════════');
    console.log('  业务数据快照备份');
    console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log('══════════════════════════════════\n');

    const snapshot = {
        backup_time: new Date().toISOString(),
        version: 'v5.5.0',
        business_data: {}
    };

    // 获取汇总数据（与页面显示一致）
    console.log('[1/2] 获取业务汇总数据...');
    const r = await callAPI('get_summary', {});
    if (!r.success) {
        console.error('❌ 获取失败:', r.error);
        process.exit(1);
    }

    const reports = r.data.reports || [];
    const plan = r.data.plan?.[0] || [];

    // 按页面逻辑分类统计
    const shortageReports = reports.filter(r => r.order_type === '缺货订购' || !r.order_type);
    const newProductReports = reports.filter(r => r.order_type === '新品订购');

    // 构建 shortage_by_product（与页面一致）
    const sbp = {};
    shortageReports.forEach(r => {
        const key = r.product_code;
        if (!sbp[key]) {
            sbp[key] = {
                product_code: key,
                product_name: r.product_name || '',
                specification: r.specification || '',
                manufacturer: r.manufacturer || '',
                supplier: r.supplier || '',
                total_demand: 0,
                replenish_status: r.replenish_status || '待处理',
                stores: {},
                latest_report_time: ''
            };
        }
        const rt = r.created_at || '';
        if (rt > sbp[key].latest_report_time) sbp[key].latest_report_time = rt;
        sbp[key].total_demand += r.demand_quantity || 0;
        sbp[key].stores[r.store_id] = {
            demand: r.demand_quantity,
            urgency_level: r.urgency_level || '普通',
            reporter: r.reporter_name || ''
        };
    });

    const shortageByProduct = Object.values(sbp);

    // 按页面逻辑分离：活跃 vs 已完成
    const isCompletedStatus = (s) => s === '已完成' || s === '厂家断货';
    const activeItems = shortageByProduct.filter(p => !isCompletedStatus(p.replenish_status));
    const completedItems = shortageByProduct.filter(p => isCompletedStatus(p.replenish_status));

    snapshot.business_data = {
        // 缺货订购 - 活跃（页面上显示的 194 条）
        active_shortage: {
            count: activeItems.length,
            items: activeItems,
            summary: {
                pending: activeItems.filter(p => p.replenish_status === '待处理').length,
                ordered: activeItems.filter(p => p.replenish_status === '已订购').length,
                arrived: activeItems.filter(p => p.replenish_status === '已到货').length,
                others: activeItems.filter(p => !['待处理', '已订购', '已到货'].includes(p.replenish_status)).length
            }
        },
        // 缺货订购 - 已完成（页面下方折叠的 75 条）
        completed_shortage: {
            count: completedItems.length,
            items: completedItems,
            summary: {
                completed: completedItems.filter(p => p.replenish_status === '已完成').length,
                outstock: completedItems.filter(p => p.replenish_status === '厂家断货').length
            }
        },
        // 新品订购
        new_products: {
            raw_count: newProductReports.length,
            grouped: []  // 按名称规格分组（与页面一致）
        },
        // 原始数据（用于恢复）
        raw_reports: reports,
        raw_plan: plan
    };

    // 新品分组（与页面逻辑一致）
    const npg = {};
    newProductReports.forEach(r => {
        const gk = (r.new_product_name || '') + '|' + (r.new_specification || '');
        if (!npg[gk]) {
            npg[gk] = {
                product_name: r.new_product_name,
                specification: r.new_specification,
                manufacturer: r.new_manufacturer,
                total_demand: 0,
                stores: []
            };
        }
        npg[gk].total_demand += r.demand_quantity || 0;
        npg[gk].stores.push({ store_id: r.store_id, demand: r.demand_quantity });
    });
    snapshot.business_data.new_products.grouped = Object.values(npg);
    snapshot.business_data.new_products.grouped_count = Object.keys(npg).length;

    // 写入文件
    const json = JSON.stringify(snapshot, null, 2);
    fs.writeFileSync(outputFile, json, 'utf-8');
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);

    console.log('\n══════════════════════════════════');
    console.log('  业务数据快照');
    console.log('══════════════════════════════════');
    console.log(`  📦 缺货订购 - 活跃: ${snapshot.business_data.active_shortage.count} 条`);
    console.log(`     ├─ 待处理: ${snapshot.business_data.active_shortage.summary.pending}`);
    console.log(`     ├─ 已订购: ${snapshot.business_data.active_shortage.summary.ordered}`);
    console.log(`     ├─ 已到货: ${snapshot.business_data.active_shortage.summary.arrived}`);
    console.log(`     └─ 其他  : ${snapshot.business_data.active_shortage.summary.others}`);
    console.log(`  ✅ 缺货订购 - 已完成: ${snapshot.business_data.completed_shortage.count} 条`);
    console.log(`     ├─ 已完成  : ${snapshot.business_data.completed_shortage.summary.completed}`);
    console.log(`     └─ 厂家断货: ${snapshot.business_data.completed_shortage.summary.outstock}`);
    console.log(`  🆕 新品订购: ${snapshot.business_data.new_products.grouped_count} 种（${snapshot.business_data.new_products.raw_count} 条）`);
    console.log(`──────────────────────────────────`);
    console.log(`  📁 ${outputFile} (${sizeKB} KB)`);
    console.log('');
    console.log('  ✅ 与页面显示一致的快照已保存！');
    console.log('══════════════════════════════════');
}

backup().catch(e => {
    console.error('备份失败:', e);
    process.exit(1);
});
