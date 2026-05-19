-- ============================================
-- 管理员子账号 + 权限系统 SQL
-- 执行方式：在 Supabase Dashboard → SQL Editor 中执行
-- ============================================

-- 1. 创建 admin_users 表（管理员子账号信息 + 权限配置）
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    username VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(50),
    role VARCHAR(20) NOT NULL DEFAULT 'viewer' CHECK (role IN ('super_admin', 'admin', 'viewer')),
    permissions JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 2. 添加默认超级管理员记录（绑定现有 admin 账号）
-- 注意：请先确认 admin 的 auth.users.id，或执行后手动更新
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
WHERE au.email = 'admin@wszh.com'
ON CONFLICT (username) DO UPDATE SET
    role = 'super_admin',
    permissions = '{"view_summary":true,"edit_status":true,"manage_order":true,"manage_employees":true,"manage_devices":true,"manage_stores":true,"manage_admins":true,"sync_data":true,"view_audit_log":true}'::jsonb;

-- 3. 创建更新时间触发器
CREATE OR REPLACE FUNCTION update_admin_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_users_updated_at ON admin_users;
CREATE TRIGGER trg_admin_users_updated_at
    BEFORE UPDATE ON admin_users
    FOR EACH ROW
    EXECUTE FUNCTION update_admin_users_updated_at();

-- 4. 启用 RLS
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- 5. RLS 策略：超级管理员可操作所有记录
CREATE POLICY "admin_users_super_admin_all"
ON admin_users
FOR ALL
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM admin_users au 
        WHERE au.user_id = auth.uid() 
        AND au.role = 'super_admin' 
        AND au.is_active = true
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM admin_users au 
        WHERE au.user_id = auth.uid() 
        AND au.role = 'super_admin' 
        AND au.is_active = true
    )
);

-- 6. RLS 策略：普通管理员可查看自己的记录
CREATE POLICY "admin_users_self_read"
ON admin_users
FOR SELECT
TO authenticated
USING (
    user_id = auth.uid()
);

-- 7. 创建索引
CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);
CREATE INDEX IF NOT EXISTS idx_admin_users_user_id ON admin_users(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role);

-- 8. 添加说明注释
COMMENT ON TABLE admin_users IS '管理员子账号表：存储子账号信息及权限配置';
COMMENT ON COLUMN admin_users.role IS '角色：super_admin=超级管理员, admin=普通管理员, viewer=只读';
COMMENT ON COLUMN admin_users.permissions IS 'JSON权限配置，如 {"view_summary":true,"edit_status":false}';
