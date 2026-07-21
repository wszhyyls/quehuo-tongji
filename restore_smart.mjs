// 智能恢复：恢复备份数据 + 保留备份后新增的上报记录
// 用法：node restore_smart.mjs business_snapshot_2026-06-29T01-50-10.json

import fs from 'fs';

const FN_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data';
const KB = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

const backupFile = process.argv[2];
if (!backupFile || !fs.existsSync(backupFile)) {
    console.error('请指定备份文件: node restore_smart.mjs business_snapshot_xxx.json');
    process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));

async function restore() {
    const backupReports = backup.data?.summary?.reports || backup.business_data?.raw_reports || [];
    console.log('══════════════════════════════════');
    console.log('  智能恢复 - 保留新增上报记录');
    console.log(`  备份文件: ${backupFile}`);
    console.log(`  备份时间: ${backup.backup_time}`);
    console.log(`  备份记录: ${backupReports.length} 条`);
    console.log('══════════════════════════════════\n');

    if (backupReports.length === 0) {
        console.error('❌ 备份中没有 reports 数据');
        process.exit(1);
    }

    // 先查询当前有多少条
    console.log('查询当前数据...');
    const summaryResp = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KB}` },
        body: JSON.stringify({ action: 'get_summary', params: {} }),
        signal: AbortSignal.timeout(60000)
    });
    const summary = await summaryResp.json();
    const currentReports = summary.data?.reports || [];
    const backupIds = new Set(backupReports.map(r => r.id).filter(Boolean));
    const newRecords = currentReports.filter(r => !backupIds.has(r.id));

    console.log(`  当前记录: ${currentReports.length} 条`);
    console.log(`  备份后新增: ${newRecords.length} 条（将保留）`);
    console.log(`  将要恢复: ${backupReports.length} 条\n`);

    console.log('正在恢复...');
    const resp = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KB}` },
        body: JSON.stringify({ action: 'restore_reports', params: { backup_reports: backupReports } }),
        signal: AbortSignal.timeout(120000)
    });
    const result = await resp.json();

    if (result.success) {
        console.log('══════════════════════════════════');
        console.log('  恢复完成');
        console.log(`  已恢复: ${result.data.restored} 条`);
        console.log(`  保留新增: ${result.data.kept_new} 条`);
        console.log(`  当前总计: ${result.data.total} 条`);
        console.log('══════════════════════════════════');
    } else {
        console.error('❌ 恢复失败:', result.error);
    }
}

restore().catch(e => { console.error('失败:', e); process.exit(1); });
