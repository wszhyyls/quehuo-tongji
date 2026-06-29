-- ========================================
-- v3.22.0: 修复数据库表缺少列问题
-- ========================================

-- 1. sync_log_table 添加 message 列（操作日志需要）
ALTER TABLE sync_log_table ADD COLUMN IF NOT EXISTS message TEXT;

-- 2. store_authorized_devices 补充可能缺失的列
ALTER TABLE store_authorized_devices ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- 3. store_authorized_devices 补充 is_authorized 列
ALTER TABLE store_authorized_devices ADD COLUMN IF NOT EXISTS is_authorized BOOLEAN DEFAULT false;

-- 4. 验证结果
SELECT 
    table_name, 
    column_name, 
    data_type,
    is_nullable
FROM information_schema.columns 
WHERE table_schema = 'public' 
  AND table_name IN ('sync_log_table', 'store_authorized_devices')
ORDER BY table_name, ordinal_position;
