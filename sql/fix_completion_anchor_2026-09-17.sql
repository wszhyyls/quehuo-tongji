-- ============================================================
-- v5.9.0 锚点修正：未完成商品的完成周期锚点回退为最早上报日期
-- 背景：迁移脚本把所有有上报的商品锚点初始化为「迁移执行时间」，
--       导致迁移前已发生的采购入库（如 09-02 的入库）被
--       `入库日期 > 锚点` 过滤掉，迁移时仍是待处理的商品永远无法完成。
-- 修正：对「迁移时仍为未完成状态」的商品，锚点回退为该商品
--       最早上报日期（从未完成过 = 整段都是同一周期）。
-- 在 Supabase SQL Editor 中执行，执行后点一次「一键同步」触发判定。
-- ============================================================

UPDATE public.product_completion pc
SET last_completed_at = sub.min_created, updated_at = NOW()
FROM (
  SELECT product_code, MIN(created_at) AS min_created
  FROM public.reports
  WHERE order_type = '缺货订购' AND product_code IS NOT NULL AND product_code <> ''
  GROUP BY product_code
) sub
WHERE pc.product_code = sub.product_code
  AND pc.last_completed_at >= TIMESTAMPTZ '2026-09-17'  -- 只修正迁移时初始化的锚点
  AND EXISTS (
    SELECT 1 FROM public.reports r
    WHERE r.product_code = pc.product_code
      AND r.order_type = '缺货订购'
      AND r.replenish_status <> '已完成'
  );

-- 验证：查看修正后的锚点
SELECT pc.product_code, pc.last_completed_at
FROM public.product_completion pc
WHERE EXISTS (
  SELECT 1 FROM public.reports r
  WHERE r.product_code = pc.product_code
    AND r.order_type = '缺货订购'
    AND r.replenish_status <> '已完成'
)
ORDER BY pc.product_code;
