// 检查 reports 总数与 1100035 在倒序 2000 条内的位置
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
const config = JSON.parse(readFileSync('./config.json', 'utf-8'));
const sb = createClient(config.supabase.url, config.supabase.serviceKey);
const { count } = await sb.from('reports').select('id', { count: 'exact', head: true }).eq('order_type', '缺货订购');
console.log('缺货订购总记录数:', count);
const { count: activeCount } = await sb.from('reports').select('id', { count: 'exact', head: true })
  .eq('order_type', '缺货订购').neq('replenish_status', '已完成');
console.log('未完成(参与判定)记录数:', activeCount);
