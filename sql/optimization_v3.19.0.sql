-- ========================================
-- 缺货统计系统 v3.19.0 优化脚本 - 数据库索引
-- 执行环境：Supabase SQL Editor
-- 目的：加速 reports 查询、设备授权查询
-- ========================================

-- 1. reports 表复合索引（门店历史查询加速）
CREATE INDEX IF NOT EXISTS idx_reports_store_created ON reports (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_product_store ON reports (product_code, store_id);

-- 2. store_authorized_devices 授权状态索引
CREATE INDEX IF NOT EXISTS idx_devices_auth_status ON store_authorized_devices (is_active, is_authorized, last_login_at DESC);

-- 3. product_cache 搜索加速（确保存在）
CREATE INDEX IF NOT EXISTS idx_product_cache_pinyin ON product_cache (pinyin_code);
CREATE INDEX IF NOT EXISTS idx_product_cache_name ON product_cache (product_name);

-- 4. shortage_storestock_cache 唯一约束（UPSERT 依赖，如未建则建）
-- DO $$ BEGIN
--   ALTER TABLE shortage_storestock_cache ADD CONSTRAINT uk_store_product UNIQUE (product_code, store_name);
-- EXCEPTION WHEN duplicate_table THEN NULL; END $$;

-- 5. 登录失败记录表（持久化防刷）
CREATE TABLE IF NOT EXISTS login_fail_log (
    id BIGSERIAL PRIMARY KEY,
    identifier TEXT NOT NULL,
    fail_time TIMESTAMPTZ DEFAULT NOW(),
    ip_address TEXT,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_fail_id_time ON login_fail_log (identifier, fail_time DESC);

-- 6. 新品审批回复表
CREATE TABLE IF NOT EXISTS report_approvals (
    id BIGSERIAL PRIMARY KEY,
    report_id TEXT NOT NULL,
    product_code TEXT,
    store_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('已审批', '已驳回')),
    reason TEXT,
    operator TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_approvals_report ON report_approvals (report_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_product ON report_approvals (product_code);

-- 验证索引
SELECT indexname, tablename FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname;
