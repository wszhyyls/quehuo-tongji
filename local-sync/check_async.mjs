import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

async function main() {
  console.log('调用一键同步...');
  const start = Date.now();
  const { data, error } = await supabase.functions.invoke('query-shortage-data', {
    body: { action: 'sync_with_auto_status' }
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`前端耗时: ${elapsed}s`);
  if (error) {
    console.error('错误:', error.message || error);
    return;
  }
  console.log('已到货数:', data?.arrivedPairs?.length || 0);
  console.log('二次校验:', (data?.detect_details || []).filter((d) => String(d).includes('二次校验')).join(' | ') || '尚未完成（异步后台执行）');
  // 等待 5 秒，让后台异步执行完成
  console.log('\n等待 10 秒，让异步二次校验完成...');
  await new Promise(r => setTimeout(r, 10000));
  // 再次检查当前已到货数
  const { count } = await supabase
    .from('reports')
    .select('*', { count: 'exact', head: true })
    .eq('replenish_status', '已到货')
    .eq('status_remark', '自动');
  console.log(`当前已到货（自动）: ${count}`);
}

main().catch(console.error);