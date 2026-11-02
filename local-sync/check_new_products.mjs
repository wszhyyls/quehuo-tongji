// 检查新品订购数据是否存在
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('./config.json', 'utf8'));
const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// 1. 按订单类型统计
const { data: all, error: e1, count } = await supabase
  .from('reports')
  .select('id, order_type, created_at, replenish_status, new_product_name', { count: 'exact' })
  .order('created_at', { ascending: false })
  .limit(5000);

if (e1) { console.error('查询失败:', e1.message); process.exit(1); }

const byType = {};
all.forEach(r => { byType[r.order_type] = (byType[r.order_type] || 0) + 1; });
console.log('=== 按订单类型统计（最近5000条内）===');
console.log(JSON.stringify(byType));

// 2. 新品订购最近 5 条
const np = all.filter(r => r.order_type === '新品订购');
console.log('=== 新品订购记录数（本次取样）:', np.length, '===');
np.slice(0, 5).forEach(r => console.log(JSON.stringify({ id: r.id, name: r.new_product_name, status: r.replenish_status, created: r.created_at })));

// 3. 精确 count 新品订购
const { count: npCount, error: e3 } = await supabase
  .from('reports')
  .select('id', { count: 'exact', head: true })
  .eq('order_type', '新品订购');
console.log('=== 新品订购精确总数:', npCount, '错误:', e3 ? e3.message : '无', '===');
