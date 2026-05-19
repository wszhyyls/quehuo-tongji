-- ========================================
-- 缺货系统升级：员工设备绑定登录 + PWA支持
-- 在 Supabase SQL Editor 中执行
-- ========================================

-- ========================================
-- 1. 员工表
-- ========================================
CREATE TABLE IF NOT EXISTS store_employees (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    store_id TEXT NOT NULL,
    store_name TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    password TEXT DEFAULT '123456',  -- 默认密码123456
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ========================================
-- 2. 设备绑定表
-- ========================================
CREATE TABLE IF NOT EXISTS device_bindings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    device_id TEXT NOT NULL,
    employee_id UUID REFERENCES store_employees(id),
    store_id TEXT NOT NULL,
    device_info JSONB DEFAULT '{}',
    first_login_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE(device_id)
);

-- ========================================
-- 3. 改造 reports 表（增加上报人字段）
-- ========================================
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reporter_id UUID REFERENCES store_employees(id);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reporter_phone TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reporter_name TEXT;

-- ========================================
-- 4. 同步日志表（替代 Edge Function 查 SQL Server）
-- ========================================
CREATE TABLE IF NOT EXISTS sync_log_table (
    id SERIAL PRIMARY KEY,
    sync_time TIMESTAMP WITH TIME ZONE,
    sync_type TEXT DEFAULT 'full',
    status TEXT DEFAULT 'pending',
    detail TEXT,
    created_by TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ========================================
-- 5. 索引
-- ========================================
CREATE INDEX IF NOT EXISTS idx_employees_phone ON store_employees(phone);
CREATE INDEX IF NOT EXISTS idx_employees_store ON store_employees(store_id);
CREATE INDEX IF NOT EXISTS idx_device_device_id ON device_bindings(device_id);
CREATE INDEX IF NOT EXISTS idx_device_employee ON device_bindings(employee_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_time ON sync_log_table(sync_time);

-- ========================================
-- 6. RLS 策略
-- 注意：PostgreSQL 不支持 CREATE POLICY IF NOT EXISTS
--       用 DO 块包裹避免重复执行报错
-- ========================================
ALTER TABLE store_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_bindings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "employees_select_public" ON store_employees
        FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "employees_manage_admin" ON store_employees
        FOR ALL USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "device_bindings_select_public" ON device_bindings
        FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "device_bindings_manage_admin" ON device_bindings
        FOR ALL USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 同步日志策略
ALTER TABLE sync_log_table ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "sync_log_select_public" ON sync_log_table
        FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "sync_log_manage_admin" ON sync_log_table
        FOR ALL USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ========================================
-- 7. 触发器：更新 updated_at
-- ========================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_employees_updated_at ON store_employees;
CREATE TRIGGER update_employees_updated_at
    BEFORE UPDATE ON store_employees FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ========================================
-- 完成！
-- ========================================
