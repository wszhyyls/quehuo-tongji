// 将 1110101 的 5/22 旧记录标记为已完成（库存不足，应清理）
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODcyNzQ2MSwiZXhwIjoyMDk0MzAzNDYxfQ.gkgIKEqBXtUMz9op1Q9nUnvIZVA4KOsdycQoAAigE4U';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// 查询 1110101 的 5/22 记录 ID
const { data: oldRecord } = await supabase
    .from('reports')
    .select('id, created_at, demand_quantity, store_id, replenish_status')
    .eq('product_code', '1110101')
    .lt('created_at', '2026-06-01T00:00:00')
    .single();

if (!oldRecord) {
    console.log('未找到5/22旧记录');
    process.exit(0);
}

console.log('找到旧记录:', oldRecord);

// 更新为已完成
const { error } = await supabase
    .from('reports')
    .update({ 
        replenish_status: '厂家断货',
        remark: '已逾 1 个月未到货，标记为厂家断货（清理于 ' + new Date().toISOString().slice(0,10) + '）'
    })
    .eq('id', oldRecord.id);

if (error) {
    console.error('更新失败:', error);
} else {
    console.log('✅ 已标记为「厂家断货」');
    console.log('现在汇总应该是 4 (新数据) + 旧记录 (已归档)');
}
