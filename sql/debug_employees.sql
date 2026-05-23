-- 调试：检查 02第二药店 的员工数据
SELECT id, name, phone, store_id, store_name, is_active, created_at
FROM store_employees
WHERE store_id = 'wszhyy02';

-- 检查所有门店员工数量统计
SELECT store_id, COUNT(*) as cnt
FROM store_employees
GROUP BY store_id
ORDER BY cnt DESC;

-- 检查 is_active 为 null 的情况
SELECT name, is_active, is_active IS NULL as is_null
FROM store_employees
WHERE store_id = 'wszhyy02';
