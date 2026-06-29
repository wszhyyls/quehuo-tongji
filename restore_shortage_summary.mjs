// 恢复缺货订购汇总数据
// 用法：node restore_shortage_summary.mjs backup_data_2026-06-29T09-45-00.json
// ⚠️  恢复前会先提示确认，并自动备份当前数据

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const SUPABASE_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ 请先设置环境变量 SUPABASE_SERVICE_KEY');
    console.error('   PowerShell: $env:SUPABASE_SERVICE_KEY="eyJh..."');
    process.exit(1);
}

const backupFile = process.argv[2];
if (!backupFile) {
    console.error('❌ 请指定备份文件');
    console.error('   用法: node restore_shortage_summary.mjs <备份文件名>');
    process.exit(1);
}

if (!fs.existsSync(backupFile)) {
    console.error(`❌ 文件不存在: ${backupFile}`);
    process.exit(1);
}

console.log('══════════════════════════════════');
console.log('  ⚠️  数据恢复 - 请确认');
console.log('══════════════════════════════════');
console.log(`  备份文件: ${backupFile}`);

const raw = fs.readFileSync(backupFile, 'utf-8');
const backup = JSON.parse(raw);

console.log(`  备份时间: ${backup.backup_time}`);
console.log(`  reports  : ${(backup.tables.reports || []).length} 条`);
console.log(`  storestock: ${(backup.tables.shortage_storestock_cache || []).length} 条`);
console.log(`  products : ${(backup.tables.product_cache || []).length} 条`);
console.log('══════════════════════════════════');
console.log('\n即将先备份当前数据，然后恢复到指定版本...');
console.log('按 Ctrl+C 取消，5秒后继续...');

await new Promise(resolve => setTimeout(resolve, 5000));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
});

// 先备份当前数据
const now = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const preRestoreFile = `backup_data_before_restore_${now}.json`;
console.log(`\n🔄 备份当前数据 → ${preRestoreFile}`);

const currentBackup = { backup_time: new Date().toISOString(), version: 'auto', tables: {} };

try {
    const { data: curReports } = await supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(10000);
    currentBackup.tables.reports = curReports || [];
} catch (e) { console.warn('⚠ 当前 reports 备份失败:', e.message); }

try {
    const { data: curCache } = await supabase.from('shortage_storestock_cache').select('*').limit(10000);
    currentBackup.tables.shortage_storestock_cache = curCache || [];
} catch (e) { console.warn('⚠ 当前 shortage_storestock_cache 备份失败:', e.message); }

try {
    const { data: curProducts } = await supabase.from('product_cache').select('*').limit(10000);
    currentBackup.tables.product_cache = curProducts || [];
} catch (e) { console.warn('⚠ 当前 product_cache 备份失败:', e.message); }

fs.writeFileSync(preRestoreFile, JSON.stringify(currentBackup, null, 2), 'utf-8');
console.log('✅ 当前数据已备份\n');

// 恢复 reports
async function restoreTable(tableName, records) {
    if (!records || records.length === 0) {
        console.log(`  ⏭ ${tableName}: 无数据，跳过`);
        return;
    }
    console.log(`  📝 ${tableName}: ${records.length} 条记录`);
    
    // 分批删除 + 插入
    const batchSize = 500;
    
    // 删除现有数据
    console.log(`    → 清除现有数据...`);
    try {
        const { error: delErr } = await supabase
            .from(tableName)
            .delete()
            .neq('id', '00000000-0000-0000-0000-000000000000'); // 安全删除条件
        if (delErr) throw delErr;
    } catch (e) {
        // 如果表中没有 id 列，使用其他方式
        console.log(`    → 尝试分批删除...`);
        for (let i = 0; i < records.length; i += batchSize) {
            const ids = records.slice(i, i + batchSize).map(r => r.id || r.product_code).filter(Boolean);
            if (ids.length > 0) {
                try { await supabase.from(tableName).delete().in('id', ids); } catch(e) {}
                try { await supabase.from(tableName).delete().in('product_code', ids); } catch(e) {}
            }
        }
    }
    
    // 分批插入
    console.log(`    → 写入 ${records.length} 条...`);
    let inserted = 0;
    for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const { error: insErr } = await supabase.from(tableName).insert(batch);
        if (insErr) {
            console.error(`    ❌ 第 ${Math.floor(i/batchSize) + 1} 批失败:`, insErr.message);
        } else {
            inserted += batch.length;
        }
    }
    console.log(`    ✅ 已写入 ${inserted}/${records.length}`);
}

// 执行恢复
console.log('🔄 恢复数据中...');
await restoreTable('reports', backup.tables.reports);
await restoreTable('shortage_storestock_cache', backup.tables.shortage_storestock_cache);
await restoreTable('product_cache', backup.tables.product_cache);

console.log('\n══════════════════════════════════');
console.log('  恢复完成');
console.log(`  恢复前备份: ${preRestoreFile}`);
console.log('══════════════════════════════════');
