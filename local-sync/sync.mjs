/**
 * 本地数据同步脚本 v1.0
 * 功能：SQL Server ↔ Supabase 双向数据同步
 * 
 * 同步方向：
 *   上行(SQL→Supabase): 商品缓存、门店库存、订货状态、状态日志
 *   下行(Supabase→SQL): 门店上报记录同步到 Shortage_OrderFeedback
 * 
 * 运行方式：
 *   node sync.mjs              # 增量同步（默认）
 *   node sync.mjs --full        # 全量同步
 *   node sync.mjs --products    # 仅同步商品
 *   node sync.mjs --inventory   # 仅同步库存
 *   node sync.mjs --orders      # 仅同步订单状态
 *   node sync.mjs --watch       # 持续运行，按间隔轮询
 */

import sql from 'mssql';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========== 加载配置 ==========
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ 未找到 config.json，请复制 config.json 并填写数据库连接信息');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

const config = loadConfig();

// ========== 命令行参数 ==========
const args = process.argv.slice(2);
const MODE = args.includes('--full') ? 'full' 
  : args.includes('--products') ? 'products'
  : args.includes('--inventory') ? 'inventory'
  : args.includes('--orders') ? 'orders'
  : args.includes('--watch') ? 'watch'
  : args.includes('--quick') ? 'quick'
  : 'incremental';
const QUICK_MODE = args.includes('--quick');

// ========== SQL Server 配置 ==========
const isWinAuth = config.sqlServer.useWindowsAuth === true;
const sqlConfig = {
  server: config.sqlServer.host,
  port: config.sqlServer.port || 1433,
  database: config.sqlServer.database || 'RQZT',
  connectionTimeout: 10000,
  requestTimeout: 300000,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
};
if (isWinAuth) {
  // Windows 集成身份验证
  sqlConfig.authentication = { type: 'ntlm', options: { domain: '' } };
  sqlConfig.options.trustedConnection = true;
} else {
  sqlConfig.user = config.sqlServer.user;
  sqlConfig.password = config.sqlServer.password;
}

// ========== Supabase 客户端 ==========
const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey
);

// ========== 日志工具 ==========
function log(level, msg, data) {
  const ts = new Date().toLocaleString('zh-CN');
  const prefix = level === 'info' ? 'ℹ' : level === 'warn' ? '⚠' : level === 'error' ? '❌' : '✓';
  console.log(`[${ts}] ${prefix} ${msg}`);
  if (data) console.log(`  ${JSON.stringify(data).substring(0, 200)}`);
}

// ========== SQL Server 连接 ==========
let sqlPool = null;

async function getSqlPool() {
  if (sqlPool && sqlPool.connected) return sqlPool;
  try {
    sqlPool = await sql.connect(sqlConfig);
    log('info', `已连接 SQL Server: ${sqlConfig.server}:${sqlConfig.port}`);
    return sqlPool;
  } catch (err) {
    log('error', `SQL Server 连接失败: ${err.message}`);
    throw err;
  }
}

async function closeSqlPool() {
  if (sqlPool) {
    try { await sqlPool.close(); } catch(e) {}
    sqlPool = null;
  }
}

// ========== 1. 商品缓存同步 (上行) ==========
async function syncProductCache(full = false) {
  const startTime = Date.now();
  log('info', '开始同步商品缓存...');
  const pool = await getSqlPool();
  
  try {
    // 执行刷新存储过程（从 ZHYYLS 同步到 RQZT 本地缓存表）
    log('info', '执行 usp_Sync_ProductCache_RQZT...');
    await pool.request().execute('usp_Sync_ProductCache_RQZT');
    
    // 读取缓存表
    const result = await pool.request().query(`
      SELECT 
        product_code,
        product_name,
        spec,
        manufacturer,
        pinyin_code
      FROM dbo.ProductCache_RQZT WITH (NOLOCK)
      ORDER BY product_code
    `);
    
    const products = (result.recordset || []).map(p => ({
      product_code: (p.product_code || '').trim(),
      product_name: p.product_name || '',
      product_spec: p.spec || '',
      manufacturer: p.manufacturer || '',
      pinyin_code: (p.pinyin_code || '').trim().toLowerCase(),
    }));
    
    log('info', `从 SQL Server 读取 ${products.length} 条商品`);
    
    // 批量 UPSERT 到 Supabase
    const batchSize = config.sync.batchSize || 100;
    let synced = 0;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const { error } = await supabase
        .from('product_cache')
        .upsert(batch, { onConflict: 'product_code', ignoreDuplicates: false });
      
      if (error) {
        log('error', `商品缓存批次 ${Math.floor(i/batchSize)+1} 失败`, error);
      } else {
        synced += batch.length;
      }
    }
    
    // 如果是全量同步，删除 SQL Server 中已不存在的商品
    if (full && products.length > 0) {
      const codes = products.map(p => `'${p.product_code.replace(/'/g, "''")}'`).join(',');
      const { error: delErr } = await supabase
        .from('product_cache')
        .delete()
        .not('product_code', 'in', `(${codes})`);
      if (delErr) log('warn', '清理旧商品缓存失败', delErr);
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('ok', `商品缓存同步完成: ${synced} 条, 耗时 ${elapsed}s`);
    return { synced };
  } catch (err) {
    log('error', `商品缓存同步失败: ${err.message}`);
    throw err;
  }
}

// ========== 2. 门店库存同步 (上行) ==========
async function syncStoreInventory(full = false, quickMode = false) {
  const startTime = Date.now();
  log('info', '开始同步门店库存...');
  const pool = await getSqlPool();
  
  try {
    // 执行 SPFXB 刷新（获取最新库存数据），quick 模式跳过
    if (!quickMode) {
      log('info', '执行 SPFXB 刷新...');
      const syncReq = pool.request();
      syncReq.input('RefreshRanking', sql.Int, 0);
      await syncReq.execute('SPFXB');
      log('info', 'SPFXB 执行完成');
    } else {
      log('info', '快速模式：跳过 SPFXB，直接读表');
    }
    
    // 读取结果
    const query = full 
      ? `SELECT * FROM dbo.SPFXB_Result WITH (NOLOCK) WHERE 商品编码 IS NOT NULL AND LTRIM(RTRIM(商品编码)) <> ''`
      : `SELECT TOP 5000 * FROM dbo.SPFXB_Result WITH (NOLOCK) 
         WHERE 商品编码 IS NOT NULL 
         AND (库存数量 > 0 OR 在途数量 > 0 OR 门店库存汇总 > 0)
         ORDER BY 商品编码`;
    
    const result = await pool.request().query(query);
    const records = result.recordset || [];
    log('info', `从 SQL Server 读取 ${records.length} 条库存记录`);
    
    // 映射字段并批量写入 Supabase
    const batchSize = config.sync.batchSize || 100;
    let synced = 0;
    
    for (let i = 0; i < records.length; i += batchSize) {
      const rawBatch = records.slice(i, i + batchSize).map(r => ({
        product_code: (r.商品编码 || '').trim(),
        store_name: r.门店名称 || '',
        store_id: (r.门店名称 || '').trim(),
        store_stock: parseInt(r.库存数量) || 0,
        in_transit: parseInt(r.在途数量) || 0,
        store_total: parseInt(r.门店库存汇总) || 0,
        dc_stock: parseInt(r.配送中心库存数量) || 0,
        sales_30days: parseInt(r.前30天销售数量) || 0,
        sales_90days: parseInt(r.前90天销售数量) || 0,
        monthly_sales: parseInt(r.月均销售数量) || 0,
        standard_stock: parseInt(r.标准库存数量) || 0,
        store_plan: parseInt(r.门店计划) || 0,
        flag: r.标记 || '',
        category: r.类别 || '',
        last_updated: new Date().toISOString(),
      }));
      
      // 批次内去重（product_code + store_name）
      const seen = new Set();
      const batch = rawBatch.filter(r => {
        const key = `${r.product_code}||${r.store_name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      
      const { error } = await supabase
        .from('shortage_storestock_cache')
        .upsert(batch, { onConflict: 'product_code,store_name', ignoreDuplicates: false });
      
      if (error) {
        log('error', `库存批次 ${Math.floor(i/batchSize)+1} 失败`, error);
      } else {
        synced += batch.length;
      }
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('ok', `门店库存同步完成: ${synced} 条, 耗时 ${elapsed}s`);
    return { synced };
  } catch (err) {
    log('error', `门店库存同步失败: ${err.message}`);
    throw err;
  }
}

// ========== 3. 订单状态同步 (上行: SQL→Supabase) ==========
async function syncOrderStatus() {
  const startTime = Date.now();
  log('info', '开始同步订单状态...');
  const pool = await getSqlPool();
  
  try {
    // 从 SQL Server 读取订货反馈状态
    const result = await pool.request().query(`
      SELECT 商品编码, 补货状态, 实际订货数量, 订货时间, 到货确认时间, 操作人, 备注
      FROM dbo.Shortage_OrderFeedback WITH (NOLOCK)
      WHERE 商品编码 IS NOT NULL
    `);
    
    const records = result.recordset || [];
    let updated = 0;
    
    for (const r of records) {
      const productCode = (r.商品编码 || '').trim();
      const status = r.补货状态 || '';
      if (!productCode) continue;
      
      // 更新 Supabase reports 表中对应记录的补货状态
      const { error } = await supabase
        .from('reports')
        .update({ 
          replenish_status: status,
          actual_order_qty: r.实际订货数量 || null,
          updated_at: new Date().toISOString()
        })
        .eq('product_code', productCode)
        .eq('order_type', '缺货订购');
      
      if (!error) updated++;
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('ok', `订单状态同步完成: ${updated} 条更新, 耗时 ${elapsed}s`);
    return { updated };
  } catch (err) {
    log('error', `订单状态同步失败: ${err.message}`);
    throw err;
  }
}

// ========== 4. 上报记录同步 (下行: Supabase→SQL) ==========
async function syncNewReports() {
  const startTime = Date.now();
  log('info', '同步 Supabase 新上报记录到 SQL Server...');
  
  try {
    // 获取 Supabase 中最近1小时内创建的上报记录
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const { data: reports, error } = await supabase
      .from('reports')
      .select('*')
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    
    if (!reports || reports.length === 0) {
      log('info', '无新上报记录');
      return { synced: 0 };
    }
    
    log('info', `发现 ${reports.length} 条新上报记录`);
    const pool = await getSqlPool();
    let synced = 0;
    
    for (const report of reports) {
      try {
        await pool.request()
          .input('商品编码', sql.NVarChar, report.product_code || '')
          .input('补货状态', sql.NVarChar, report.replenish_status || '待处理')
          .input('门店名称', sql.NVarChar, report.store_name || '')
          .input('上报数量', sql.Int, report.demand_quantity || 0)
          .input('备注', sql.NVarChar, (report.remark || '').substring(0, 500))
          .query(`
            IF EXISTS (SELECT 1 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码)
              UPDATE dbo.Shortage_OrderFeedback 
              SET 补货状态 = CASE WHEN 补货状态 = '已完成' THEN 补货状态 ELSE @补货状态 END,
                  备注 = CASE WHEN @备注 IS NOT NULL AND @备注 <> '' THEN @备注 ELSE 备注 END
              WHERE 商品编码 = @商品编码
            ELSE
              INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 补货状态, 门店名称, 上报数量, 备注, 订货时间)
              VALUES (@商品编码, @补货状态, @门店名称, @上报数量, @备注, GETDATE())
          `);
        synced++;
      } catch (e) {
        log('warn', `同步上报记录 ${report.product_code} 失败: ${e.message}`);
      }
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('ok', `上报记录同步完成: ${synced} 条, 耗时 ${elapsed}s`);
    return { synced };
  } catch (err) {
    log('error', `上报记录同步失败: ${err.message}`);
    throw err;
  }
}

// ========== 5. 状态变更日志同步 (上行) ==========
async function syncStatusChangeLog() {
  const startTime = Date.now();
  log('info', '同步状态变更日志...');
  const pool = await getSqlPool();
  
  try {
    // 获取上次同步时间
    const { data: metaData } = await supabase
      .from('sync_metadata')
      .select('last_status_log_sync')
      .eq('key', 'status_change_log')
      .single();
    
    const lastSync = metaData?.last_status_log_sync || '2020-01-01T00:00:00Z';
    
    // 查询增量数据
    const req = pool.request();
    req.input('LastSync', sql.DateTime, new Date(lastSync));
    const result = await req.query(`
      SELECT 商品编码, 原状态, 新状态, 操作人, 备注, 变更时间
      FROM dbo.StatusChangeLog WITH (NOLOCK)
      WHERE 变更时间 > @LastSync
      ORDER BY 变更时间 ASC
    `);
    
    const logs = (result.recordset || []).map(r => ({
      product_code: (r.商品编码 || '').trim(),
      old_status: r.原状态 || '',
      new_status: r.新状态 || '',
      operator: r.操作人 || '',
      remark: r.备注 || '',
      changed_at: r.变更时间?.toISOString() || new Date().toISOString(),
    }));
    
    if (logs.length > 0) {
      // 写入 Supabase（status_change_log 表如不存在则创建）
      const { error } = await supabase
        .from('status_change_log')
        .upsert(logs, { onConflict: 'product_code,changed_at' });
      
      if (error) {
        log('warn', `状态日志写入失败 (表可能不存在): ${error.message}`);
        // 尝试用 RPC 创建表
        log('info', '请手动在 Supabase 创建 status_change_log 表，参见 sql/create_status_changelog_supabase.sql');
      } else {
        log('info', `状态日志同步: ${logs.length} 条`);
      }
    }
    
    // 更新同步时间
    const now = new Date().toISOString();
    await supabase
      .from('sync_metadata')
      .upsert({ key: 'status_change_log', last_status_log_sync: now, updated_at: now }, 
        { onConflict: 'key' });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('ok', `状态日志同步完成: ${logs.length} 条, 耗时 ${elapsed}s`);
    return { synced: logs.length };
  } catch (err) {
    log('error', `状态日志同步失败: ${err.message}`);
    throw err;
  }
}

// ========== 6. 自动检测状态变化 ==========
async function runAutoDetectStatus() {
  const startTime = Date.now();
  log('info', '执行自动状态检测...');
  
  try {
    const pool = await getSqlPool();
    await pool.request().execute('usp_AutoDetectOrderStatus_Feedback');
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('ok', `自动状态检测完成, 耗时 ${elapsed}s`);
    return { success: true };
  } catch (err) {
    log('error', `自动状态检测失败: ${err.message}`);
    throw err;
  }
}

// ========== 主运行流程 ==========
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════╗');
  console.log('║  缺货统计系统 - 本地数据同步 v1.0 ║');
  console.log('╚══════════════════════════════════╝');
  console.log(`  SQL Server: ${sqlConfig.server}:${sqlConfig.port}`);
  console.log(`  Supabase:   ${config.supabase.url}`);
  console.log(`  模式:       ${MODE}`);
  console.log('');
  
  try {
    const results = {};
    
    // 根据模式选择执行哪些同步
    const doProducts = MODE === 'full' || MODE === 'products' || MODE === 'incremental' || MODE === 'watch' || MODE === 'quick';
    const doInventory = MODE === 'full' || MODE === 'inventory' || MODE === 'incremental' || MODE === 'watch' || MODE === 'quick';
    const doOrders = MODE === 'full' || MODE === 'orders' || MODE === 'incremental' || MODE === 'watch';
    const doStatusLog = MODE === 'full' || MODE === 'incremental' || MODE === 'watch';
    const fullMode = MODE === 'full';
    
    if (doProducts && config.sync.syncProducts !== false) {
      results.products = await syncProductCache(fullMode);
    }
    
    if (doInventory && config.sync.syncInventory !== false) {
      results.inventory = await syncStoreInventory(fullMode || MODE === 'quick', QUICK_MODE);
    }
    
    if (doOrders && config.sync.syncOrders !== false) {
      // 先同步下行（Supabase→SQL）
      await syncNewReports();
      
      // 执行自动状态检测（SQL Server 内部）
      if (config.sync.autoDetectStatus !== false) {
        await runAutoDetectStatus();
      }
      
      // 再同步上行（SQL→Supabase）
      results.orderStatus = await syncOrderStatus();
    }
    
    if (doStatusLog && config.sync.syncStatusLog !== false) {
      results.statusLog = await syncStatusChangeLog();
    }
    
    console.log('');
    console.log('═══════════════════════════════════');
    console.log('  同步完成！');
    Object.entries(results).forEach(([key, val]) => {
      console.log(`  ${key}: ${JSON.stringify(val)}`);
    });
    console.log('═══════════════════════════════════');
    
    // 持续运行模式
    if (MODE === 'watch') {
      const interval = (config.sync.intervalSeconds || 60) * 1000;
      console.log(`\n持续运行模式，每 ${config.sync.intervalSeconds}s 同步一次...\n`);
      setInterval(async () => {
        try {
          await syncProductCache(false);
          await syncStoreInventory(false);
          await syncNewReports();
          await runAutoDetectStatus();
          await syncOrderStatus();
          await syncStatusChangeLog();
          console.log('');
        } catch (e) {
          log('error', `轮询同步异常: ${e.message}`);
        }
      }, interval);
    }
    
  } catch (err) {
    console.error('\n❌ 同步失败:', err.message);
    process.exit(1);
  } finally {
    if (MODE !== 'watch') {
      await closeSqlPool();
    }
  }
}

main();
