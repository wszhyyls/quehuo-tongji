-- ============================================================
-- v3.15 架构升级：结转余量模式 + 事件驱动保护期 + 失败计数
-- ============================================================

-- 1. product_completion 加字段
ALTER TABLE product_completion ADD COLUMN IF NOT EXISTS last_anchor timestamp with time zone;
ALTER TABLE product_completion ADD COLUMN IF NOT EXISTS carryover_qty integer NOT NULL DEFAULT 0;
ALTER TABLE product_completion ADD COLUMN IF NOT EXISTS fail_count integer NOT NULL DEFAULT 0;
ALTER TABLE product_completion ADD COLUMN IF NOT EXISTS last_purchase_at timestamp with time zone;
ALTER TABLE product_completion ADD COLUMN IF NOT EXISTS closed_count integer NOT NULL DEFAULT 0;

-- 2. 回填老数据：last_anchor = last_completed_at（保守，从判定日起算增量采购）
UPDATE product_completion SET
  last_anchor = COALESCE(last_anchor, last_completed_at),
  carryover_qty = COALESCE(carryover_qty, 0),
  fail_count = COALESCE(fail_count, 0);

-- 3. reports 表加关闭状态字段（可选，先加好）
ALTER TABLE reports ADD COLUMN IF NOT EXISTS close_reason text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS auto_closed_at timestamp with time zone;

-- 4. 建索引加速查询
CREATE INDEX IF NOT EXISTS idx_reports_status_product ON reports(replenish_status, product_code, order_type);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);

-- 5. 验证
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'product_completion' ORDER BY ordinal_position;
