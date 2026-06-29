-- ========================================
-- Edge Function Keep-Warm（防止冷启动）
-- 每5分钟 ping 一次 Edge Function，保持实例活跃
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴执行
-- ========================================

-- 1. 启用 pg_cron 扩展（如果未启用）
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. 启用 pg_net 扩展（HTTP 请求）
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 3. 创建定时任务（每5分钟 ping 一次）
SELECT cron.schedule(
  'keep-edge-warm',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data'::text,
    '{"action":"get_all_products"}'::jsonb,
    '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI"}'::jsonb
  );
  $$
);

-- 4. 查看已创建的定时任务
SELECT * FROM cron.job WHERE jobname = 'keep-edge-warm';

-- 5. 删除定时任务（如需）
-- SELECT cron.unschedule('keep-edge-warm');
