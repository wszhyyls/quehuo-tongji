-- =====================================================
-- 清理重复员工数据（删除旧的138开头虚拟手机号，保留199开头的）
-- =====================================================

-- 删除所有138开头的虚拟手机号（旧批次）
DELETE FROM store_employees WHERE phone LIKE '13800000%';

-- 验证：查看剩余员工（应该只有199开头的20人）
SELECT store_name, name, phone FROM store_employees ORDER BY store_name, name;
