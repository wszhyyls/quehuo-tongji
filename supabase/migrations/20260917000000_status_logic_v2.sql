-- ============================================================
-- 药品状态变更逻辑 v2：取消「已到货」，完成判定改为「采购入库累计 ≥ 缺货汇总」
-- 在 Supabase SQL Editor 中执行
-- ============================================================

-- 1. reports 表新增「已结算」标记（完成时回填）
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

-- 2. 商品级完成周期锚点表
CREATE TABLE IF NOT EXISTS public.product_completion (
    product_code TEXT PRIMARY KEY,
    last_completed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. store_notifications 新增「通知去重」字段
ALTER TABLE public.store_notifications ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- 4. 存量数据迁移：取消「已到货」状态，一次性改为「已完成」
UPDATE public.reports
SET replenish_status = '已完成',
    status_remark = '迁移',
    status_changed_at = NOW(),
    status_changed_by = '系统迁移'
WHERE replenish_status = '已到货';

-- 5. 为所有已有上报的商品初始化完成周期锚点（= 迁移执行时间）
INSERT INTO public.product_completion (product_code, last_completed_at)
SELECT DISTINCT product_code, NOW()
FROM public.reports
WHERE product_code IS NOT NULL AND product_code <> ''
ON CONFLICT (product_code) DO NOTHING;

-- 6. 清空旧的「已到货」通知（避免门店端残留过期提醒）
DELETE FROM public.store_notifications
WHERE message LIKE '%已到货%' OR message LIKE '%仓库可配送%';

-- 索引
CREATE INDEX IF NOT EXISTS idx_reports_settled ON public.reports (settled_at);
CREATE INDEX IF NOT EXISTS idx_product_completion_time ON public.product_completion (last_completed_at);
