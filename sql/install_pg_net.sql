-- 安装 pg_net 扩展（用于 Webhook HTTP 请求）
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 验证安装
SELECT * FROM pg_extension WHERE extname = 'pg_net';

-- 测试函数是否存在
SELECT proname FROM pg_proc WHERE proname LIKE '%http%';
