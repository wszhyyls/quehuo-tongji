-- ========================================
-- 缺货统计系统 v3.18.6 数据库优化
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴执行
-- 影响：零停机，仅建索引和表
-- ========================================

-- 1. store_authorized_devices 联合索引（最常用查询加速）
CREATE INDEX IF NOT EXISTS idx_devices_device_username 
ON store_authorized_devices(device_id, username, is_active);

-- 2. shortage_storestock_cache 门店+商品联合索引
CREATE INDEX IF NOT EXISTS idx_stock_store_product 
ON shortage_storestock_cache(store_name, product_code);

-- 3. reports 门店+时间索引（历史查询加速）
CREATE INDEX IF NOT EXISTS idx_reports_store_time 
ON reports(store_id, created_at DESC);

-- 4. product_cache 商品编码索引（搜索加速）
CREATE INDEX IF NOT EXISTS idx_product_cache_code 
ON product_cache(product_code);

-- ========================================
-- 门店配置表（替代多处硬编码）
-- 新增门店只需 INSERT 一行，零代码改动
-- ========================================
CREATE TABLE IF NOT EXISTS store_config (
  store_id TEXT PRIMARY KEY,
  store_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  device_limit INT DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 初始数据
INSERT INTO store_config (store_id, store_name, display_name, device_limit) VALUES
  ('wszhyy02', '02第二药店', '02第二药店', 2),
  ('wszhyy03', '03第三药店', '03第三药店', 1),
  ('wszhyy04', '04第四药店', '04第四药店', 1),
  ('wszhyy06', '06常口店', '06常口店', 1),
  ('wszhyy08', '08第八药店', '08第八药店', 1),
  ('wszhyy09', '09第九药店', '09第九药店', 1),
  ('wszhyy14', '14第十四药店', '14第十四药店', 1),
  ('wszhyy16', '16凤凰山药店', '16凤凰山药店', 1),
  ('wszhyy17', '17益丰店', '17益丰店', 1),
  ('wszhyy21', '21富源店', '21富源店', 1),
  ('15305479520', '02第二药店', '02第二药店', 2)
ON CONFLICT (store_id) DO NOTHING;
