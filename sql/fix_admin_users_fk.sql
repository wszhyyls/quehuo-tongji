-- ============================================
-- 修复 admin_users 表外键约束
-- 问题：created_by 之前引用 admin_users(id)，应改为 auth.users(id)
-- 执行方式：在 Supabase Dashboard → SQL Editor 中执行
-- ============================================

-- 1. 删除旧的外键约束（如果存在）
-- 先查找约束名
DO $$
DECLARE
    fk_name TEXT;
BEGIN
    SELECT tc.constraint_name INTO fk_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu 
        ON tc.constraint_name = ccu.constraint_name
    WHERE tc.table_name = 'admin_users' 
      AND tc.constraint_type = 'FOREIGN KEY'
      AND ccu.column_name = 'id'
      AND ccu.table_name = 'admin_users';
    
    IF fk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE admin_users DROP CONSTRAINT %I', fk_name);
        RAISE NOTICE '已删除旧外键约束: %', fk_name;
    END IF;
END $$;

-- 2. 添加新的外键约束（引用 auth.users(id)）
ALTER TABLE admin_users
ADD CONSTRAINT admin_users_created_by_fkey
FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 3. 确保超级管理员记录存在（兼容任意 admin 邮箱）
-- 如果之前种子数据没匹配上，这里重新插入
INSERT INTO admin_users (user_id, username, name, role, permissions, is_active, created_by)
SELECT 
    au.id as user_id,
    'admin' as username,
    '超级管理员' as name,
    'super_admin' as role,
    '{"view_summary":true,"edit_status":true,"manage_order":true,"manage_employees":true,"manage_devices":true,"manage_stores":true,"manage_admins":true,"sync_data":true,"view_audit_log":true}'::jsonb as permissions,
    true as is_active,
    NULL as created_by
FROM auth.users au
WHERE au.email LIKE 'admin@%'
   OR au.raw_user_meta_data->>'username' = 'admin'
ON CONFLICT (username) DO UPDATE SET
    role = 'super_admin',
    permissions = '{"view_summary":true,"edit_status":true,"manage_order":true,"manage_employees":true,"manage_devices":true,"manage_stores":true,"manage_admins":true,"sync_data":true,"view_audit_log":true}'::jsonb;

-- 4. 验证结果
SELECT id, username, name, role, is_active, created_at 
FROM admin_users 
WHERE role = 'super_admin';