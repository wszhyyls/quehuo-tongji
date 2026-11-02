// C：存量清洗——把 reports.product_name 按 product_cache 的标准名(FullName)刷一遍
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
const config = JSON.parse(readFileSync('./config.json', 'utf-8'));
const sb = createClient(config.supabase.url, config.supabase.serviceKey);

// 1. 分页拉 product_cache 建立 code -> 标准名 映射
const nameMap = {};
{
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb.from('product_cache')
      .select('product_code, product_name')
      .range(from, from + PAGE - 1);
    const rows = data || [];
    rows.forEach(p => { if (p.product_code) nameMap[p.product_code] = p.product_name; });
    if (rows.length < PAGE) break;
  }
}
console.log('product_cache 标准名条数:', Object.keys(nameMap).length);

// 2. 分页拉缺货订购 reports，找需更新的
const toUpdate = [];
const examples = [];
{
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb.from('reports')
      .select('id, product_code, product_name')
      .eq('order_type', '缺货订购')
      .not('product_code', 'is', null)
      .range(from, from + PAGE - 1);
    const rows = data || [];
    rows.forEach(r => {
      const std = nameMap[r.product_code];
      if (std && r.product_name !== std) {
        toUpdate.push({ id: r.id, product_name: std });
        if (examples.length < 20) examples.push(`${r.product_code}: ${r.product_name} -> ${std}`);
      }
    });
    if (rows.length < PAGE) break;
  }
}
console.log('需更新记录数:', toUpdate.length);
console.log('示例（前20条）:');
examples.forEach(e => console.log('  ', e));

if (toUpdate.length === 0) { console.log('无需更新，退出'); process.exit(0); }

// 3. 分批 upsert（只更新 product_name 列）
const BATCH = 200;
let done = 0;
for (let i = 0; i < toUpdate.length; i += BATCH) {
  const batch = toUpdate.slice(i, i + BATCH);
  const { error } = await sb.from('reports').upsert(batch, { onConflict: 'id' });
  if (error) { console.error(`第 ${i / BATCH + 1} 批失败:`, error.message); process.exit(1); }
  done += batch.length;
  console.log(`已更新 ${done}/${toUpdate.length}`);
}
console.log('✅ 清洗完成，共更新', done, '条');
