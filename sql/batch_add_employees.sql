-- =====================================================
-- 批量添加门店员工（上报人名册用，虚拟手机号仅用于满足NOT NULL约束）
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴执行
-- =====================================================

-- 说明：
--   只有 phone='15305479520' 的员工可以登录门店测试
--   其他员工使用虚拟手机号（1990000XXXX），仅供上报人选择，不可登录
-- =====================================================

-- 02第二药店 (wszhyy02)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000001', '孔茹', 'wszhyy02', '02第二药店', '123456', true, NOW()),
('19900000002', '朱耿兰', 'wszhyy02', '02第二药店', '123456', true, NOW()),
('19900000003', '於德菊', 'wszhyy02', '02第二药店', '123456', true, NOW()),
('19900000004', '尹洪丽', 'wszhyy02', '02第二药店', '123456', true, NOW());

-- 03第三药店 (wszhyy03)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000005', '张明利', 'wszhyy03', '03第三药店', '123456', true, NOW()),
('19900000006', '朱绪美', 'wszhyy03', '03第三药店', '123456', true, NOW());

-- 04第四药店 (wszhyy04)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000007', '陈莉', 'wszhyy04', '04第四药店', '123456', true, NOW()),
('19900000008', '张广君', 'wszhyy04', '04第四药店', '123456', true, NOW());

-- 06常口店 (wszhyy06)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000009', '王林林', 'wszhyy06', '06常口店', '123456', true, NOW());

-- 08第八药店 (wszhyy08)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000010', '宋真真', 'wszhyy08', '08第八药店', '123456', true, NOW());

-- 09第九药店 (wszhyy09)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000011', '卜庆庆', 'wszhyy09', '09第九药店', '123456', true, NOW()),
('19900000012', '郭茹', 'wszhyy09', '09第九药店', '123456', true, NOW());

-- 14第十四药店 (wszhyy14)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000013', '付娟', 'wszhyy14', '14第十四药店', '123456', true, NOW()),
('19900000014', '布召俊', 'wszhyy14', '14第十四药店', '123456', true, NOW());

-- 16凤凰山药店 (wszhyy16)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000015', '朱倩', 'wszhyy16', '16凤凰山药店', '123456', true, NOW()),
('19900000016', '刘珊珊', 'wszhyy16', '16凤凰山药店', '123456', true, NOW());

-- 17益丰店 (wszhyy17)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000017', '朱庚翠', 'wszhyy17', '17益丰店', '123456', true, NOW()),
('19900000018', '李萍', 'wszhyy17', '17益丰店', '123456', true, NOW());

-- 21富源店 (wszhyy21)
INSERT INTO store_employees (phone, name, store_id, store_name, password, is_active, created_at)
VALUES 
('19900000019', '张珊珊', 'wszhyy21', '21富源店', '123456', true, NOW()),
('19900000020', '刘美芝', 'wszhyy21', '21富源店', '123456', true, NOW());

-- =====================================================
-- 执行后请刷新门店端页面，上报人下拉框即可显示这些员工
-- =====================================================
