-- ========================================
-- v4.0 架构重构: 修复补丁
-- 执行环境：Supabase SQL Editor
-- ========================================

-- 1. 安装 pg_net 扩展（net.http_post 报错）
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. store_authorized_devices 补充 store_id 列
ALTER TABLE store_authorized_devices ADD COLUMN IF NOT EXISTS store_id TEXT;

-- 3. 创建索引加速
CREATE INDEX IF NOT EXISTS idx_devices_store_id ON store_authorized_devices(store_id);

-- 4. 修复 keep_warm 的 net.http_post 参数顺序
--    原: (url, body, headers) → 正确: (url, headers, body)
SELECT cron.unschedule('keep-edge-warm');

SELECT cron.schedule(
  'keep-edge-warm',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url => 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data'::text,
    headers => '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI"}'::jsonb,
    body => '{"action":"get_all_products"}'::jsonb
  );
  $$
);

-- 5. 修复 scheduled_sync 的 net.http_post 参数顺序
SELECT cron.unschedule('sync-spfxb-result');

-- （同步已由本地脚本接管，不再需要 cron 定时调用）
