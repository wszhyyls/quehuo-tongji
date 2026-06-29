-- ========================================
-- 修复 order_sync 触发器：net.http_post 参数类型
-- ========================================

-- 1. 先删除旧触发器（如果存在）
DROP TRIGGER IF EXISTS trg_sync_order_detail ON reports;

-- 2. 删除旧函数
DROP FUNCTION IF EXISTS trg_sync_order_detail_fn();

-- 3. 重新创建函数（使用正确的 jsonb 参数类型）
CREATE OR REPLACE FUNCTION trg_sync_order_detail_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  req_id bigint;
BEGIN
  SELECT net.http_post(
    url => 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/sync-order-detail'::text,
    headers => '{"Content-Type": "application/json"}'::jsonb,
    body => jsonb_build_object('record', row_to_json(NEW))
  ) INTO req_id;
  RETURN NEW;
END;
$$;

-- 4. 重新创建触发器
CREATE TRIGGER trg_sync_order_detail
  AFTER INSERT ON reports
  FOR EACH ROW
  EXECUTE FUNCTION trg_sync_order_detail_fn();

-- 5. 验证
SELECT 
  trigger_name,
  event_manipulation,
  action_statement
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND trigger_name = 'trg_sync_order_detail';
