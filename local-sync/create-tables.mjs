/**
 * 通过 Supabase SQL API 创建 status_change_log 和 sync_metadata 表
 * 需要设置 SUPABASE_DB_PASSWORD 环境变量
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 从 config.json 读取配置
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

// 使用 Supabase 客户端（Service Role Key）
const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
  { auth: { persistSession: false } }
);

async function main() {
  console.log('正在创建 Supabase 表...\n');

  // 通过 RPC 执行 SQL（需要 pg_net 扩展支持或直接使用 REST API）
  // 备选方案：使用 fetch 直接调用 Supabase Management API

  // 方案：逐条 INSERT 来测试表是否存在
  // 如果表不存在，Supabase 会报错，然后我们手动创建

  try {
    // 尝试查询 status_change_log 表
    const { error: queryErr } = await supabaseAdmin
      .from('status_change_log')
      .select('id')
      .limit(1);

    if (queryErr && queryErr.code === '42P01') {
      // 表不存在，需要创建
      console.log('表 status_change_log 不存在，请在 Supabase SQL Editor 中执行以下 SQL：\n');
      console.log(fs.readFileSync(path.join(__dirname, '..', 'sql', 'create_status_changelog_supabase.sql'), 'utf-8'));
      console.log('\n---');
      console.log('SQL Editor 地址: https://supabase.com/dashboard/project/qswpgnnedqvuegwfbprd/sql/new');
    } else if (queryErr) {
      console.log('查询错误:', queryErr.message);
    } else {
      console.log('✓ status_change_log 表已存在');
    }

    // 尝试查询 sync_metadata 表
    const { error: metaErr } = await supabaseAdmin
      .from('sync_metadata')
      .select('key')
      .limit(1);

    if (metaErr && metaErr.code === '42P01') {
      console.log('表 sync_metadata 不存在。');
    } else if (metaErr) {
      console.log('查询错误:', metaErr.message);
    } else {
      console.log('✓ sync_metadata 表已存在');
    }

  } catch (err) {
    console.error('错误:', err.message);
  }
}

main();
