-- Supabase 状态变更日志表（本地同步脚本写入，Edge Function 读取）
-- 请在 Supabase SQL Editor 中执行此脚本

CREATE TABLE IF NOT EXISTS public.status_change_log (
    id BIGSERIAL PRIMARY KEY,
    product_code TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    operator TEXT,
    remark TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 唯一约束：同一商品相同时刻不重复
CREATE UNIQUE INDEX IF NOT EXISTS idx_status_change_log_product_time 
    ON public.status_change_log (product_code, changed_at);

-- 查询索引
CREATE INDEX IF NOT EXISTS idx_status_change_log_product 
    ON public.status_change_log (product_code, changed_at DESC);

-- 同步元数据表（记录上次同步时间）
CREATE TABLE IF NOT EXISTS public.sync_metadata (
    key TEXT PRIMARY KEY,
    last_status_log_sync TIMESTAMPTZ,
    last_product_sync TIMESTAMPTZ,
    last_inventory_sync TIMESTAMPTZ,
    last_order_sync TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 启用 RLS（Service Role 密钥不受限）
ALTER TABLE public.status_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_metadata ENABLE ROW LEVEL SECURITY;
