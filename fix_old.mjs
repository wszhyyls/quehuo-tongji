// 通过 Node fetch 调用 Supabase REST API（无外部依赖）
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODcyNzQ2MSwiZXhwIjoyMDk0MzAzNDYxfQ.gkgIKEqBXtUMz9op1Q9nUnvIZVA4KOsdycQoAAigE4U';

const body = JSON.stringify({
    replenish_status: '厂家断货',
    remark: '已逾1个月未到货，标记为厂家断货（清理于 2026-07-03）'
});

const url = 'https://qswpgnnedqvuegwfbprd.supabase.co/rest/v1/reports?product_code=eq.1110101&created_at=lt.2026-06-01';

const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
        'apikey': KEY,
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    },
    body: body,
    signal: AbortSignal.timeout(30000)
});

const result = await resp.json();
console.log('状态码:', resp.status);
console.log('更新结果:');
console.log(JSON.stringify(result, null, 2));
