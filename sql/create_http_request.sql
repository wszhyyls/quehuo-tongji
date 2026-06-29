-- 创建 supabase_functions.http_request 函数（Webhook 需要）
CREATE OR REPLACE FUNCTION supabase_functions.http_request(
  method text,
  url text,
  headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb,
  timeout_ms integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  request_id bigint;
  response jsonb;
BEGIN
  -- 使用 pg_net 发送 HTTP 请求
  SELECT net.http_post(
    url := url,
    headers := headers,
    body := body::text
  ) INTO request_id;
  
  -- 等待响应（简化版，实际应异步处理）
  PERFORM pg_sleep(0.1);
  
  SELECT net.http_collect_response(request_id) INTO response;
  
  RETURN response;
END;
$$;

-- 授予权限
GRANT EXECUTE ON FUNCTION supabase_functions.http_request TO postgres, anon, authenticated, service_role;
