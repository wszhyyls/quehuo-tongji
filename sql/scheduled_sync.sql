-- ========================================
-- SPFXB_Result 定时同步任务
-- 每30分钟自动同步 Excel → SPFXB_Result → Supabase缓存
-- ========================================
-- 
-- 📋 执行步骤：
-- 1. 打开 Supabase Dashboard → SQL Editor → 新建查询
-- 2. 打开 Project Settings → API → 复制 service_role key
-- 3. 把下面的 YOUR_SERVICE_ROLE_KEY 替换为实际的 key
-- 4. 全部粘贴到 SQL Editor 执行
-- ========================================

-- 启用扩展（如果未启用）
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 创建定时任务：每30分钟同步一次 SPFXB_Result
SELECT cron.schedule(
  'sync-spfxb-result',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/scheduled-task',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body := '{"action":"full_sync"}'::jsonb
  );
  $$
);

-- 查看已创建的定时任务
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'sync-spfxb-result';

-- 如需删除：
-- SELECT cron.unschedule('sync-spfxb-result');
