-- 修复: 创建 Webhook 所需的 schema
CREATE SCHEMA IF NOT EXISTS supabase_functions;

-- 赋予权限
GRANT USAGE ON SCHEMA supabase_functions TO postgres;
GRANT USAGE ON SCHEMA supabase_functions TO anon;
GRANT USAGE ON SCHEMA supabase_functions TO authenticated;
GRANT USAGE ON SCHEMA supabase_functions TO service_role;

-- 创建扩展（如果还没启用）
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 再次尝试创建 webhook，或者刷新页面后重试
