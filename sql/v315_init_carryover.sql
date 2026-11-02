-- ============================================================
-- v3.15 老数据初始化
-- 把有未完成上报的商品的 last_anchor 重置为最早未完成上报日
-- carryover_qty 保持 0（第一次全量算，之后才走增量）
-- ============================================================

-- Step 1: 有未完成上报的商品 → last_anchor = 最早未完成上报日
WITH pending_earliest AS (
  SELECT 
    r.product_code,
    MIN(r.created_at) as earliest_pending
  FROM reports r
  WHERE r.order_type = '缺货订购'
    AND r.replenish_status NOT IN ('已完成', '厂家断货', '已关闭')
    AND r.product_code IS NOT NULL
  GROUP BY r.product_code
)
UPDATE product_completion pc
SET 
  last_anchor = pe.earliest_pending,
  carryover_qty = 0,  -- 第一次全量算，从 0 开始
  fail_count = 0,
  updated_at = NOW()
FROM pending_earliest pe
WHERE pc.product_code = pe.product_code
  AND pc.last_anchor > pe.earliest_pending;  -- 只改有漂移的

-- Step 2: 还没有 product_completion 的商品（有待处理上报但从未判定过）→ 插入
WITH pending_earliest AS (
  SELECT 
    r.product_code,
    MIN(r.created_at) as earliest_pending
  FROM reports r
  WHERE r.order_type = '缺货订购'
    AND r.replenish_status NOT IN ('已完成', '厂家断货', '已关闭')
    AND r.product_code IS NOT NULL
  GROUP BY r.product_code
)
INSERT INTO product_completion (product_code, last_completed_at, last_anchor, carryover_qty, fail_count, updated_at)
SELECT pe.product_code, NULL, pe.earliest_pending, 0, 0, NOW()
FROM pending_earliest pe
WHERE NOT EXISTS (
  SELECT 1 FROM product_completion pc WHERE pc.product_code = pe.product_code
);

-- 验证
SELECT COUNT(*) as updated FROM product_completion WHERE updated_at > NOW() - INTERVAL '1 minute';
