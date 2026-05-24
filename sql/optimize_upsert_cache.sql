-- ============================================
-- 库存缓存增量 UPSERT 优化
-- 将全量 DELETE + INSERT 改为单次 UPSERT
-- 效果：消除删除→插入之间的数据空窗期，写入时间减半
-- 执行方式：Supabase SQL Editor
-- ============================================

-- 1. 创建唯一约束（UPSERT 依赖）
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

-- 2. 删除旧数据（清理脏记录，只执行一次）
-- DELETE FROM shortage_storestock_cache WHERE store_name IS NULL OR store_name IN ('*', 'null', 'undefined');
