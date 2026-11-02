-- ========================================
-- 每天 北京时间 00:30 自动同步（防重复采购）
-- pg_cron 调用 scheduled-task Edge Function
-- 时区修正: pg_cron 服务器为 UTC，UTC 16:30 = 北京时间 00:30
-- 鉴权: Bearer service_role key（绕过 JWT 验证）
-- ========================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-spfxb-result') THEN
    PERFORM cron.unschedule('sync-spfxb-result');
  END IF;
END $$;

SELECT cron.schedule(
  'sync-spfxb-result',
  '30 16 * * *',
  $$
  SELECT net.http_post(
    'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/scheduled-task',
    '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODcyNzQ2MSwiZXhwIjoyMDk0MzAzNDYxfQ.gkgIKEqBXtUMz9op1Q9nUnvIZVA4KOsdycQoAAigE4U","Content-Type":"application/json"}',
    '{"action":"full_sync"}'
  ) AS request_id;
  $$
);

-- 验证
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'sync-spfxb-result';

-- pg_cron 时区说明:
-- pg_cron 以服务器时区 UTC 运行，cron 表达式直接按 UTC 解析
-- 北京时间 = UTC + 8，所以北京时间 00:30 对应 UTC 16:30
-- 下次执行时间（UTC 16:30）= 北京时间次日 00:30
