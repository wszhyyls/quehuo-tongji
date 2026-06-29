// 从 Supabase 恢复 Feedback 数据
const url = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data';
const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

console.log('正在恢复数据...');
const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
    body: JSON.stringify({ action: 'rebuild_feedback_from_supabase' }),
    signal: AbortSignal.timeout(120000)
});
const result = await resp.json();
console.log('结果:', JSON.stringify(result, null, 2));
