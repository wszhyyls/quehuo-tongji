-- ============================================
-- RQZT 商品缓存表 + 索引 + 同步存储过程
-- 用途：避免每次跨库全表扫描 ZHYYLS.Vptype
-- 影响：商品查询 3-5s → 200ms，对 ZHYYLS 零写入
-- 执行方式：在 SSMS 连接 RQZT 数据库后执行
-- ============================================

-- 1. 创建商品缓存表
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[ProductCache_RQZT]') AND type = 'U')
BEGIN
    CREATE TABLE dbo.ProductCache_RQZT (
        product_code VARCHAR(50) NOT NULL PRIMARY KEY,   -- 商品编码（聚集索引自动创建）
        product_name NVARCHAR(200) NULL,                  -- 商品名称
        spec NVARCHAR(100) NULL,                          -- 规格
        manufacturer NVARCHAR(200) NULL,                  -- 生产企业
        pinyin_code VARCHAR(100) NULL,                    -- 拼音助记码
        sync_time DATETIME DEFAULT GETDATE()              -- 同步时间
    );
    PRINT '✅ ProductCache_RQZT 表创建成功';
END
ELSE
    PRINT '⚠️ ProductCache_RQZT 表已存在，跳过创建';
GO

-- 2. 创建拼音码索引（加速拼音首字母搜索）
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ProductCache_Pinyin')
BEGIN
    CREATE INDEX IX_ProductCache_Pinyin ON dbo.ProductCache_RQZT(pinyin_code);
    PRINT '✅ 拼音码索引创建成功';
END
GO

-- 3. 创建名称索引（加速名称搜索）
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ProductCache_Name')
BEGIN
    CREATE INDEX IX_ProductCache_Name ON dbo.ProductCache_RQZT(product_name);
    PRINT '✅ 名称索引创建成功';
END
GO

-- 4. 创建同步存储过程（从 ZHYYLS 读取，写入 RQZT）
IF EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[usp_Sync_ProductCache_RQZT]') AND type = 'P')
    DROP PROCEDURE dbo.usp_Sync_ProductCache_RQZT;
GO

CREATE PROCEDURE dbo.usp_Sync_ProductCache_RQZT
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @startTime DATETIME = GETDATE();
    DECLARE @syncCount INT = 0;
    DECLARE @errorMsg NVARCHAR(500);

    BEGIN TRY
        -- 清空旧缓存（商品基础数据，无关联依赖，可安全清空）
        TRUNCATE TABLE dbo.ProductCache_RQZT;

        -- 从 ZHYYLS 拉取商品基础信息（只读跨库查询，不影响 ZHYYLS）
        INSERT INTO dbo.ProductCache_RQZT (product_code, product_name, spec, manufacturer, pinyin_code, sync_time)
        SELECT
            LTRIM(RTRIM(ISNULL(a.USERCODE, '')))    AS product_code,
            LTRIM(RTRIM(ISNULL(a.FullName, '')))    AS product_name,
            LTRIM(RTRIM(ISNULL(a.Standard, '')))    AS spec,
            LTRIM(RTRIM(ISNULL(b.FullName, '')))    AS manufacturer,
            LTRIM(RTRIM(ISNULL(a.PYZJM, '')))       AS pinyin_code,
            @startTime                               AS sync_time
        FROM ZHYYLS.dbo.Vptype a WITH (NOLOCK)
        LEFT JOIN ZHYYLS.dbo.cstype b WITH (NOLOCK) ON a.area = b.rec
        WHERE a.leveal = '3'
          AND (
            -- 近1年有销售记录
            EXISTS (
                SELECT 1 FROM ZHYYLS.dbo.Vsalebill s WITH (NOLOCK)
                JOIN ZHYYLS.dbo.Vbillindex i WITH (NOLOCK) ON s.billid = i.billid
                WHERE s.prec = a.rec AND i.billdate >= DATEADD(year, -1, GETDATE())
            )
            -- 或有库存
            OR EXISTS (
                SELECT 1 FROM ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK)
                WHERE gs.prec = a.rec AND gs.qty > 0
            )
        );

        SET @syncCount = @@ROWCOUNT;
        PRINT '✅ 商品缓存同步完成: ' + CAST(@syncCount AS VARCHAR) + ' 条, 耗时 ' + CAST(DATEDIFF(ms, @startTime, GETDATE()) AS VARCHAR) + 'ms';
    END TRY
    BEGIN CATCH
        SET @errorMsg = ERROR_MESSAGE();
        PRINT '❌ 同步失败: ' + @errorMsg;
        RAISERROR(@errorMsg, 16, 1);
    END CATCH
END;
GO

-- 5. 首次执行同步（填充数据）
PRINT '🔄 开始首次商品缓存同步...';
EXEC dbo.usp_Sync_ProductCache_RQZT;
GO

PRINT '';
PRINT '=============================================';
PRINT '  RQZT 商品缓存方案部署完成！';
PRINT '  下次同步: 执行 EXEC dbo.usp_Sync_ProductCache_RQZT';
PRINT '=============================================';
