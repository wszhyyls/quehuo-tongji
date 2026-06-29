// 备份 Shortage_OrderFeedback 数据
const url = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data';
const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';
const fs = await import('fs');

console.log('备份数据中...');

const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
    body: JSON.stringify({ action: 'get_status_log', top: 300 }),
    signal: AbortSignal.timeout(60000)
});

const result = await resp.json();

if (!result.success || !result.data) {
    console.error('获取失败:', result);
    process.exit(1);
}

const records = Array.isArray(result.data) ? result.data : (result.data[0] || []);

const now = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
const file = `feedback_backup_${now}.sql`;

let sql = '-- 备份时间: ' + new Date().toISOString() + '\n';
sql += '-- 记录数: ' + records.length + '\n\n';
sql += 'DELETE FROM dbo.Shortage_OrderFeedback;\nGO\n\n';

for (const r of records) {
    const code = (r.商品编码 || '').replace(/'/g, "''");
    const status = (r.补货状态 || '待处理').replace(/'/g, "''");
    const qty = r.实际订货数量 || 0;
    const note = (r.备注 || '').replace(/'/g, "''");
    sql += `INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 备注) VALUES ('${code}', ${qty}, '${status}', GETDATE(), '${note}');\n`;
}

fs.writeFileSync(file, sql, 'utf-8');
console.log(`✅ 备份完成: ${file} (${records.length}条)`);
