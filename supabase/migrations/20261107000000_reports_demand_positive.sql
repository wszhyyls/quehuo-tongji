-- ============================================================
-- 需求为 0 修复: reports 表 demand_quantity 加 CHECK 约束
-- 创建时间: 2026-11-07
-- 策略: 先清理历史脏数据 → 再加约束
-- ============================================================

-- Step 1: 先看有多少条 0/负值/NULL 需求（只读，确认数量后再执行清理）
-- SELECT count(*) FROM reports WHERE demand_quantity IS NULL OR demand_quantity <= 0;

-- Step 2: 清理历史脏数据 —— 标记为"已关闭"保留溯源，而非直接删除
UPDATE reports
SET
  replenish_status = '已关闭',
  close_reason = COALESCE(close_reason || ' / ', '') || '需求数量异常(<=0)',
  status_changed_at = now(),
  status_changed_by = '系统自动(migration:reports_demand_positive)'
WHERE demand_quantity IS NULL OR demand_quantity <= 0;

-- Step 3: 加 CHECK 约束 —— 之后任何 attempt 插入 demand_quantity <= 0 都会被 DB 层拒绝
ALTER TABLE reports
  ADD CONSTRAINT reports_demand_positive CHECK (demand_quantity > 0);

-- Step 4: 验证
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'reports'::regclass AND conname = 'reports_demand_positive';
