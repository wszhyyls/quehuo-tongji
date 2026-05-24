-- 查看 SPFXB_Result 表上的所有索引列（兼容旧版 SQL Server，无 STRING_AGG）
SELECT 
    i.name AS 索引名,
    COL_NAME(ic.object_id, ic.column_id) AS 列名,
    ic.key_ordinal AS 列序号
FROM sys.indexes i
JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
WHERE i.object_id = OBJECT_ID('SPFXB_Result')
ORDER BY i.name, ic.key_ordinal;
