-- ============================================
-- 清理重复数据 + 创建唯一约束（UPSERT前置步骤）
-- 错误：product_code + store_name 有重复
-- 解决：只保留最新的一条，删除旧的
-- ============================================

-- 1. 查看重复数据（可选，确认问题）
-- SELECT product_code, store_name, COUNT(*) as cnt 
-- FROM shortage_storestock_cache 
-- GROUP BY product_code, store_name 
-- HAVING COUNT(*) > 1;

-- 2. 删除重复数据，只保留 last_updated 最新的
DELETE FROM shortage_storestock_cache
WHERE ctid NOT IN (
    SELECT MAX(ctid)
    FROM shortage_storestock_cache
    GROUP BY product_code, store_name
);

-- 3. 清理脏数据（store_name 为空或异常值）
DELETE FROM shortage_storestock_cache 
WHERE store_name IS NULL 
   OR store_name IN ('*', 'null', 'undefined', '');

-- 4. 创建唯一约束（清理后应该能成功）
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'shortage_storestock_cache_product_store_unique'
    ) THEN
        ALTER TABLE shortage_storestock_cache 
        ADD CONSTRAINT shortage_storestock_cache_product_store_unique 
        UNIQUE (product_code, store_name);
        RAISE NOTICE '✅ 唯一约束创建成功';
    ELSE
        RAISE NOTICE '⚠️ 唯一约束已存在';
    END IF;
END $$;
