-- ========================================
-- 修复: usp_AutoDetectOrderStatus_Feedback 截断错误 (错误 8152)
-- 错误位置: 存储过程第12行 + 第30行
--   第12行: f.备注 = ISNULL(f.备注,'') + ' | 自动检测完成 ...'
--   第30行: f.备注 = ISNULL(f.备注,'') + ' | 自动检测配货 ...'
-- 原因: 备注列 nvarchar(200) 不够，拼接后超长
-- ========================================

-- 修复：扩大备注字段
ALTER TABLE dbo.Shortage_OrderFeedback ALTER COLUMN 备注 NVARCHAR(1000);

-- 验证
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'Shortage_OrderFeedback'
  AND COLUMN_NAME = '备注';
