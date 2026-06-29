-- 实时同步: reports 表 INSERT → 自动调用 Edge Function 写入 SQL Server
-- 兼容低版本 pg_net：只用三参数，不带 timeout
CREATE OR REPLACE FUNCTION sync_order_to_sql_server()
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
    body => jsonb_build_object('record', row_to_json(NEW))::text
  ) INTO req_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_order_detail ON public.reports;
CREATE TRIGGER trg_sync_order_detail
  AFTER INSERT ON public.reports
  FOR EACH ROW
  EXECUTE FUNCTION sync_order_to_sql_server();
