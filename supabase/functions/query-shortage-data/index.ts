// Supabase Edge Function - 查询缺货系统数据
// v3.12: 连接池预热 + 查询超时保护 + 状态查询修复
// v374: 逐笔 report 独立判定 + 采购不重复消耗
// v375: P0 安全修复 — ZHYYLS 只读断言 + action 级别鉴权
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import sql from "https://esm.sh/mssql@9";
// 【2026-11-08 放开锚点】所有判定核心函数直接内联，避免 Deno import 打包问题

// ========== P0-2: ZHYYLS 只读断言（2026-11-07 新增）==========
// ZHYYLS 是 ERP 业务库，Edge Function 只允许 SELECT + EXEC 只读存储过程
// 任何 INSERT/UPDATE/DELETE/MERGE/TRUNCATE 涉及 ZHYYLS 的一律拒绝
const ZHYYLS_WRITE_PATTERNS = [
  /\bINSERT\s+(INTO\s+)?ZHYYLS\b/i,
  /\bUPDATE\s+ZHYYLS\b/i,
  /\bDELETE\s+FROM\s+ZHYYLS\b/i,
  /\bMERGE\s+INTO\s+ZHYYLS\b/i,
  /\bTRUNCATE\s+TABLE\s+ZHYYLS\b/i,
];
function assertZhyylsReadOnly(sqlText: string | undefined): void {
  if (!sqlText) return;
  const hasZhylsRef = /ZHYYLS/i.test(sqlText);
  if (!hasZhylsRef) return; // 不涉及 ZHYYLS 库，不用检查
  for (const pattern of ZHYYLS_WRITE_PATTERNS) {
    if (pattern.test(sqlText)) {
      const msg = `[安全拦截] ZHYYLS 库只读，但检测到写操作关键字: ${sqlText.substring(0, 200)}`;
      console.error(msg);
      throw new Error(msg);
    }
  }
}

// ========== 默认员工密码（从环境变量读取，安全性增强）==========
const DEFAULT_EMPLOYEE_PASSWORD = Deno.env.get("DEFAULT_EMPLOYEE_PASSWORD") || "wszh123456";
// ========== P0-1: 鉴权密钥 ==========
const TASK_SECRET = Deno.env.get("TASK_SECRET") || "wszh_auto_sync_2026"; // 定时任务专用
const ADMIN_USERS = ['admin', '15305479520']; // 管理员白名单（用于写操作鉴权）

// ========== 特殊账号配置 ==========
// 这些账号不受设备授权和单设备登录限制
const EXEMPT_ACCOUNTS = ['admin', '15305479520'];

// ========== 门店设备数量限制 ==========
// 每个门店允许登录的设备数量上限，默认1台，02店允许2台
const STORE_DEVICE_LIMITS: Record<string, number> = {
  'wszhyy02': 2,  // 02第二药店允许2台设备
};
// 未在此列表中的门店，默认限制1台设备

// ========== 辅助函数：检查是否是例外账号 ==========
function isExemptAccount(identifier: string): boolean {
  return EXEMPT_ACCOUNTS.includes(identifier);
}

// ========== 登录防刷（同IP/设备5分钟内失败5次锁定）==========
const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MINUTES = 5;

function checkLoginRateLimit(identifier: string): { allowed: boolean; message?: string } {
  const now = Date.now();
  const record = loginAttempts.get(identifier);
  
  // 清理过期记录（超过锁定时间）
  if (record && (now - record.firstAttempt) > LOGIN_LOCK_MINUTES * 60 * 1000) {
    loginAttempts.delete(identifier);
  }
  
  const current = loginAttempts.get(identifier);
  if (current && current.count >= LOGIN_MAX_ATTEMPTS) {
    const remaining = Math.ceil((LOGIN_LOCK_MINUTES * 60 * 1000 - (now - current.firstAttempt)) / 60000);
    return { allowed: false, message: `登录失败次数过多，请${remaining}分钟后再试` };
  }
  return { allowed: true };
}

function recordLoginAttempt(identifier: string, success: boolean) {
  if (success) {
    loginAttempts.delete(identifier); // 成功则清除记录
    return;
  }
  const now = Date.now();
  const record = loginAttempts.get(identifier);
  if (!record || (now - record.firstAttempt) > LOGIN_LOCK_MINUTES * 60 * 1000) {
    loginAttempts.set(identifier, { count: 1, firstAttempt: now });
  } else {
    record.count++;
  }
}

// ========== 错误信息通俗化映射（将技术错误转为中文提示）==========
function friendlyError(err: unknown): string {
  const msg = String(err);
  // 大小写不敏感匹配（ConnectionError、Connect、connect 都能命中）
  const lower = msg.toLowerCase();
  if (msg.includes("Invalid object name") || msg.includes("找不到对象")) return "数据源连接异常，请刷新页面重试";
  if (lower.includes("timeout") || msg.includes("超时")) return "数据查询超时，请稍后重试";
  if (lower.includes("econnrefused") || lower.includes("etimedout") || lower.includes("failed to connect") || lower.includes("connection error") || lower.includes("econnreset") || lower.includes("socket hang up")) {
    // 提示具体原因：很可能是 SQL Server 地址配置错误或网络不通
    return "无法连接 SQL Server（请检查网络/防火墙/服务器地址），稍后重试";
  }
  if (msg.includes("401") || msg.includes("Unauthorized")) return "登录已过期，请重新登录";
  if (msg.includes("403") || msg.includes("Forbidden")) return "没有操作权限，请联系管理员";
  if (msg.includes("404") || msg.includes("Not Found")) return "请求的数据不存在";
  if (msg.includes("500") || msg.includes("Internal")) return "系统繁忙，请稍后重试";
  return msg.substring(0, 200); // 兜底：截断技术错误信息
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// 默认 IP 兜底：与其他配置（local-sync/config.json、vba/*.bas、test-sql-connection）保持一致
// 注意：Edge Function 环境变量优先级最高，仅当未设置时使用默认值
const SQL_SERVER_HOST = Deno.env.get("SQL_SERVER_HOST") || "221.6.168.13";
const SQL_SERVER_PORT = parseInt(Deno.env.get("SQL_SERVER_PORT") || "1311");
const SQL_SERVER_USER = Deno.env.get("SQL_SERVER_USER")!;
const SQL_SERVER_PWD = Deno.env.get("SQL_SERVER_PASSWORD")!;
const SQL_SERVER_DB = Deno.env.get("SQL_SERVER_DATABASE") || "RQZT";

// 启动时打印实际使用的连接配置（脱敏）
console.log(`[配置] SQL Server: ${SQL_SERVER_HOST}:${SQL_SERVER_PORT}/${SQL_SERVER_DB}, User: ${SQL_SERVER_USER}`);

const sqlConfig = {
  server: SQL_SERVER_HOST,
  port: SQL_SERVER_PORT,
  user: SQL_SERVER_USER,
  password: SQL_SERVER_PWD,
  database: SQL_SERVER_DB,
  connectionTimeout: 15000,
  requestTimeout: 30000,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
};

// ========== SQL 连接池管理（性能优化）==========
// 缓存活跃的连接，复用而非每次新建
interface PoolCache {
  pool: sql.ConnectionPool;
  lastUsed: number;
  inUse: boolean;
}

const MAX_POOL_SIZE = 5;  // 最多缓存5个连接
const POOL_TTL = 1800000;  // 30分钟后未使用则关闭连接（配合 Keep-Warm 保持活跃）
const poolCache: Map<string, PoolCache> = new Map();


// v5.8.1+ 配送查询内存缓存：原 60s，但会和 SP 查询产生数据不一致
// 改为 0（不缓存）以保证需求明细和 SP 看到的数据一致
const transitCache: Map<string, { value: number; ts: number }> = new Map();
const TRANSIT_CACHE_TTL = 0; // 不缓存：保证需求明细和 SP 数据一致

// v5.8.1+ sync_cache 限流：防止 DoS 高频调用
const syncRateLimit = {
    windowStart: Date.now() as number,
    reqCount: 0 as number,
};
const SYNC_RATE_WINDOW_MS = 60000;   // 1 分钟窗口
const SYNC_RATE_MAX_ALLOW = 5;        // 最多 5 次


// ========== P0-2: SQL 查询安全代理（2026-11-07 新增）==========
// 代理 ConnectionPool.request()，让所有 .query() 自动过 assertZhyylsReadOnly
function createSafePool(pool: sql.ConnectionPool): sql.ConnectionPool {
  const origRequest = pool.request.bind(pool);
  (pool as any).request = function (...args: any[]) {
    const req = origRequest(...args);
    const origQuery = (req as any).query.bind(req);
    (req as any).query = function (sqlText: string, ...rest: any[]) {
      assertZhyylsReadOnly(sqlText);
      return origQuery(sqlText, ...rest);
    };
    return req;
  };
  return pool;
}

// 获取连接池（带缓存）
async function getPool(dbName: string = SQL_SERVER_DB): Promise<sql.ConnectionPool> {
  const cacheKey = dbName;
  const now = Date.now();
  
  // 清理过期连接
  for (const [key, cache] of poolCache.entries()) {
    if (now - cache.lastUsed > POOL_TTL && !cache.inUse) {
      try {
        await cache.pool.close();
      } catch (e) {
        console.error(`关闭过期连接失败: ${key}`, e);
      }
      poolCache.delete(key);
    }
  }
  
  // 检查是否有可用连接
  const existing = poolCache.get(cacheKey);
  if (existing && !existing.inUse && now - existing.lastUsed < POOL_TTL) {
    existing.inUse = true;
    existing.lastUsed = now;
    return createSafePool(existing.pool); // P0-2: 返回前包一层安全代理
  }
  
  // 如果缓存已满，等待可用连接或创建新连接
  if (poolCache.size >= MAX_POOL_SIZE) {
    // 等待任意连接释放
    for (const [key, cache] of poolCache.entries()) {
      if (!cache.inUse) {
        try {
          await cache.pool.close();
        } catch (e) {
          console.error(`关闭旧连接失败: ${key}`, e);
        }
        poolCache.delete(key);
        break;
      }
    }
  }
  
  // 创建新连接（含重试机制，最多3次，间隔递增）
  const config = dbName === SQL_SERVER_DB ? sqlConfig : { ...sqlConfig, database: dbName };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const pool = createSafePool(await sql.connect(config)); // P0-2: 创建后立即包安全代理
      poolCache.set(cacheKey, { pool, lastUsed: now, inUse: true });
      if (attempt > 1) console.log(`[getPool] 第${attempt}次重试连接成功 (${dbName})`);
      return pool;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        const delay = attempt * 1000; // 1s, 2s
        console.warn(`[getPool] 连接失败(尝试${attempt}/3)，${delay}ms后重试:`, err);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  console.error(`[getPool] 3次连接全部失败 (${dbName}):`, lastErr);
  throw lastErr;
}

// 释放连接回缓存池
function releasePool(pool: sql.ConnectionPool, dbName: string = SQL_SERVER_DB) {
  const cacheKey = dbName;
  const cache = poolCache.get(cacheKey);
  if (cache && cache.pool === pool) {
    cache.inUse = false;
    cache.lastUsed = Date.now();
  }
}

// ========== L2 内存缓存（减少 SQL Server 重复查询）==========
interface MemCacheEntry<T> {
  data: T;
  ts: number;
}
const memCache = new Map<string, MemCacheEntry<any>>();
const MEM_CACHE_TTL_PRODUCTS = 600000;   // 商品列表缓存10分钟
const MEM_CACHE_TTL_INVENTORY = 120000;  // 库存快照缓存2分钟

function memCacheGet<T>(key: string, ttl: number): T | null {
  const entry = memCache.get(key);
  if (entry && (Date.now() - entry.ts) < ttl) return entry.data;
  memCache.delete(key);
  return null;
}

function memCacheSet(key: string, data: any) {
  memCache.set(key, { data, ts: Date.now() });
  // 最多保留50个缓存条目
  if (memCache.size > 50) {
    const first = memCache.keys().next().value;
    if (first) memCache.delete(first);
  }
}

// 关闭所有连接（清理）
async function closeAllPools() {
  for (const [key, cache] of poolCache.entries()) {
    try {
      await cache.pool.close();
    } catch (e) {
      console.error(`关闭连接失败: ${key}`, e);
    }
  }
  poolCache.clear();
}

// ========== 连接池预热（v3.12新增）==========
// 系统初始化时预创建连接，避免冷启动延迟
let warmupDone = false;
async function warmupPools() {
  if (warmupDone) return;
  console.log('[预热] 开始预热数据库连接池...');
  try {
    // 预创建主库连接
    const pool = await getPool();
    releasePool(pool);
    console.log('[预热] 连接池预热完成');
  } catch (e) {
    console.error('[预热] 连接池预热失败:', e);
  }
  warmupDone = true;
}

// ========== 查询超时保护（v3.12新增）==========
// 为每个 SQL 查询添加超时，避免慢查询阻塞
const DEFAULT_QUERY_TIMEOUT = 30000;  // 默认30秒超时

interface QueryOptions {
  timeout?: number;
}

async function queryWithTimeout<T>(
  pool: sql.ConnectionPool,
  request: sql.Request,
  options: QueryOptions = {}
): Promise<sql.RecordSet[]> {
  const timeout = options.timeout || DEFAULT_QUERY_TIMEOUT;
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`查询超时（${timeout / 1000}秒）`));
    }, timeout);
    
    request.query((err, result) => {
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(result.recordsets);
      }
    });
  });
}

async function executeWithTimeout<T>(
  pool: sql.ConnectionPool,
  request: sql.Request,
  procedureName: string,
  options: QueryOptions = {}
): Promise<sql.RecordSet[]> {
  const timeout = options.timeout || DEFAULT_QUERY_TIMEOUT;
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`存储过程执行超时（${timeout / 1000}秒）: ${procedureName}`));
    }, timeout);
    
    request.execute(procedureName, (err, result) => {
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(result.recordsets);
      }
    });
  });
}

// ========== v5.8.3 二次校验（异步后台执行，避免 Edge Function 超时）==========
// 检查 Supabase 中所有"已到货（自动）"商品，仓库库存=0 的回退为待处理
// 同步执行（在 releasePool 之前），单次批量 SQL，覆盖全部已到货商品
async function runSecondCheck(pool: any, supabase: any) {
  try {
    // 1. 查所有已到货（自动）商品
    const { data: arrivedAll, error: errA } = await supabase
      .from("reports")
      .select("product_code, store_id")
      .eq("replenish_status", "已到货")
      .eq("order_type", "缺货订购")
      .eq("status_remark", "自动");
    if (errA) { console.warn('[SecondCheck] 查询失败:', errA.message); return; }
    if (!arrivedAll || arrivedAll.length === 0) return;

    const finalCodes = [...new Set(arrivedAll.map((it: any) => it.product_code).filter(Boolean))];
    if (finalCodes.length === 0) return;

    // 2. 单次批量查 SQL Server 仓库库存（按商品编码聚合，IN 子句批量）
    const finalStockMap: Record<string, number> = {};
    const BATCH = 100;  // 单批 100 条，单次 SQL
    for (let i = 0; i < finalCodes.length; i += BATCH) {
      const codeBatch = finalCodes.slice(i, i + BATCH);
      const req2 = pool.request();
      const placeholders = codeBatch.map((c: string, idx: number) => {
        const p = `c${idx}`;
        req2.input(p, sql.NVarChar, c);
        return `@${p}`;
      }).join(',');
      try {
        const whRes = await req2.query(`
          SELECT v.usercode, ISNULL(SUM(gs.qty), 0) as wh_qty
          FROM ZHYYLS.dbo.Vptype v WITH(NOLOCK)
          LEFT JOIN ZHYYLS.dbo.GoodsStocks gs WITH(NOLOCK) ON gs.prec = v.rec AND gs.krec = '3'
          WHERE v.usercode IN (${placeholders})
          GROUP BY v.usercode
        `);
        (whRes.recordset || []).forEach((r: any) => { finalStockMap[r.usercode] = Number(r.wh_qty); });
        codeBatch.forEach((c: string) => { if (!(c in finalStockMap)) finalStockMap[c] = 0; });
      } catch (_) { /* 单批失败不阻断 */ }
    }

    // 3. 对库存=0 的回退
    let finalRevert = 0;
    for (const it of arrivedAll) {
      const stock = finalStockMap[it.product_code];
      if ((stock === undefined ? 0 : stock) <= 0) {
        try {
          const { error: updErr } = await supabase.from("reports").update({
            replenish_status: '待处理',
            status_remark: '自动',
            status_changed_at: new Date().toISOString(),
            status_changed_by: '系统自动'
          })
            .eq("product_code", it.product_code)
            .eq("store_id", it.store_id)
            .eq("order_type", "缺货订购")
            .eq("replenish_status", "已到货")
            .eq("status_remark", "自动");
          if (!updErr) {
            finalRevert++;
            try {
              await supabase.from("store_notifications").upsert({
                store_id: it.store_id,
                product_code: it.product_code,
                message: `${it.product_code} 仓库库存已耗尽，已回退为待处理`,
                created_at: new Date().toISOString(),
                is_read: false
              }, { onConflict: 'store_id,product_code' });
            } catch (_) { /* 通知失败不阻断 */ }
          }
        } catch (_) { /* 单条失败不阻断 */ }
      }
    }
    if (finalRevert > 0) {
      console.log(`[SecondCheck] 回退 ${finalRevert} 条已到货→待处理`);
    }
  } catch (e) {
    console.warn('[SecondCheck] 失败:', e);
  }
}

// ========== v5.6 自动检测：计算下沉到 RQZT 存储过程（SQL 2008 R2 兼容） ==========
async function preciseAutoDetectStatus(
  pool: sql.ConnectionPool,
  supabaseClient: any
): Promise<{ detected: number; details: string[] }> {
  const details: string[] = [];
  try {
    // 1. 从 Supabase reports 获取所有未完成的缺货订购记录（按门店，不受 Feedback 影响）
    const { data: allOrdered } = await supabaseClient
      .from("reports")
      .select("product_code, store_name, demand_quantity, created_at, replenish_status, store_id")
      .eq("order_type", "缺货订购")
      .gt("demand_quantity", 0)
      .not("product_code", "is", null)
      .order("created_at", { ascending: false })
      .limit(2000);
    
    // 筛选未完成的记录（待处理/已订购/已到货/待付款/配货中），排除已完成/厂家断货/已关闭
    const sqlItems: Array<{ 商品编码: string; 补货状态: string; 订货数量: number }> = [];
    const sqlCodes = new Set<string>();
    for (const r of (allOrdered || [])) {
      if (!r.product_code || !r.store_name) continue;
      const status = r.replenish_status || '待处理';
      if (status === '已完成' || status === '厂家断货' || status === '已关闭' || status === '已配送') continue;
      if (!sqlCodes.has(r.product_code)) {
        sqlItems.push({ 商品编码: r.product_code, 补货状态: status, 订货数量: r.demand_quantity || 0 });
        sqlCodes.add(r.product_code);
      }
    }
    details.push(`待检测商品: ${sqlItems.length} 个（从 Supabase reports 直接筛选，不受 Feedback 影响）`);


    // 2. 获取 Supabase 各门店需求（包含上报日期，排除已完成/厂家断货的门店）
    const { data: supabaseOrdered } = await supabaseClient
      .from("reports")
      .select("product_code, store_name, demand_quantity, created_at, replenish_status")
      .eq("order_type", "缺货订购")
      .gt("demand_quantity", 0)
      .not("product_code", "is", null)
      .order("created_at", { ascending: false })
      .limit(1200);

    const storeDemandMap: Record<string, Record<string, { demand: number; since: string }>> = {};
    if (supabaseOrdered) {
      for (const r of supabaseOrdered) {
        if (!r.product_code || !r.store_name) continue;
        // 不过滤"已完成"状态：保留最新 demand 记录
        // 修复：之前过滤掉已完成的报告，导致 staging 用了老的需求（demand=1），SP 误判
        if (!storeDemandMap[r.product_code]) storeDemandMap[r.product_code] = {};
        const sinceDate = toBjDate(r.created_at) || bjToday();
        if (!storeDemandMap[r.product_code][r.store_name]) {
          // 第一次见此 (product, store)：因为按 created_at desc 排序，这是最新一次
          // 修复：之前 demand 只用最新一份的需求，since 用最早的，导致 staging 和 UI 不一致
          // 现在 demand 累加所有 report（与 UI 的 ss.demand 行为一致），since 用最新一份
          storeDemandMap[r.product_code][r.store_name] = { demand: r.demand_quantity || 0, since: sinceDate };
        } else {
          // 累加 demand（与 loadSummary 中的 ss.demand += r.demand_quantity 行为一致）
          storeDemandMap[r.product_code][r.store_name].demand += r.demand_quantity || 0;
          // since 保持最新一次的不变（与 UI 的 report_time 一致）
        }
      }
    }

    // 补充 SQL Server 中没有的商品
    let missingCount = 0;
    for (const code of Object.keys(storeDemandMap)) {
      if (!sqlCodes.has(code)) {
        const totalQty = Object.values(storeDemandMap[code]).reduce((sum, s) => sum + s.demand, 0);
        sqlItems.push({ 商品编码: code, 补货状态: '已订购', 订货数量: totalQty });
        missingCount++;
      }
    }
    if (missingCount > 0) {
      details.push(`Supabase 补充: ${missingCount} 个商品（SQL Server 缺失）`);
    }

    // 3. 构建需求行（含上报日期）
    const demandRows: Array<{ product_code: string; store_name: string; demand_qty: number; total_qty: number; report_date: string }> = [];
    for (const item of sqlItems) {
      const code = item.商品编码;
      const stores = storeDemandMap[code];
      if (!stores) continue;
      // total_qty = 该商品所有活动门店的需求之和（而非 Feedback 表的订货数量）
      const totalQty = Object.values(stores).reduce((sum, s) => sum + (s.demand || 0), 0);
      for (const [storeName, info] of Object.entries(stores)) {
        demandRows.push({
          product_code: code,
          store_name: storeName,
          demand_qty: info.demand,
          total_qty: totalQty,
          report_date: info.since,
        });
      }
    }
    if (demandRows.length === 0) {
      details.push("无有效门店需求，跳过");
      return { detected: 0, details };
    }
    details.push(`门店需求记录: ${demandRows.length} 条`);

    // 4. 清空 staging 表并写入需求数据（含上报日期）
    await pool.request().query("DELETE FROM dbo.RQZT_AutoDetect_Demand");
    details.push("已清空需求 staging 表");

    const BATCH_SIZE = 200;
    let inserted = 0;
    for (let i = 0; i < demandRows.length; i += BATCH_SIZE) {
      const batch = demandRows.slice(i, i + BATCH_SIZE);
      const req = pool.request();
      const values: string[] = [];
      batch.forEach((row, idx) => {
        const p = `p${idx}`, s = `s${idx}`, d = `d${idx}`, t = `t${idx}`, rd = `rd${idx}`;
        req.input(p, sql.NVarChar(50), row.product_code);
        req.input(s, sql.NVarChar(50), row.store_name);
        req.input(d, sql.Int, row.demand_qty);
        req.input(t, sql.Int, row.total_qty);
        req.input(rd, sql.VarChar(10), row.report_date);
        values.push(`(@${p}, @${s}, @${d}, @${t}, @${rd})`);
      });
      await req.query(`
        INSERT INTO dbo.RQZT_AutoDetect_Demand (product_code, store_name, demand_qty, total_qty, report_date)
        VALUES ${values.join(', ')}
      `);
      inserted += batch.length;
    }
    details.push(`已写入需求 staging: ${inserted} 条`);

    // 5. 配送总量查询已下沉到 SP 中，按每条需求的上报日期精确过滤
    details.push("配送总量由 SP 按上报日期后查询");

    // v5.8.1+ C3 判定完全由 SP 负责（上报日期后配送 ≥ 需求 → 已完成）
    // 不用库存判断：库存会受销售影响不可靠，报告后配送才是干净数据

    // 6. 确保 SP 存在（如果用户没手动创建，这里给出提示）
    const spCheck = await pool.request().query("SELECT OBJECT_ID('dbo.sp_RQZT_AutoComplete') AS id");
    if (!spCheck.recordset?.[0]?.id) {
      details.push("SP sp_RQZT_AutoComplete 不存在，请在 RQZT 中手动创建");
      return { detected: 0, details };
    }

    // 6. 调用 SP，全部计算在 RQZT 完成
    const today = bjToday();
    const thirtyDaysAgo = bjDaysAgo(30);
    const req = pool.request();
    req.input("StartDate", sql.VarChar(10), thirtyDaysAgo);
    req.input("EndDate", sql.VarChar(10), today);

    const spResult = await req.execute("sp_RQZT_AutoComplete");
    // SP 返回 (product_code, store_name, stat) 列表，stat 是 '已到货' 或 '已完成'
    const rows = (spResult.recordset || []) as any[];
    const spCompletedPairs = rows.map((r: any) => ({
      product_code: r.product_code,
      store_name: r.store_name,
      status: r.stat || '已完成'
    })).filter((p: any) => p.product_code && p.store_name);
    let updatedCount = 0;
    if (spResult.recordsets && spResult.recordsets.length > 1) {
      updatedCount = spResult.recordsets[1][0]?.updated || 0;
    }
    details.push(`SP 判定: 已完成 ${spCompletedPairs.filter(p => p.status === '已完成').length} 个, 已到货 ${spCompletedPairs.filter(p => p.status === '已到货').length} 个, 更新商品 ${updatedCount} 个`);

    const completedPairs = spCompletedPairs;
    details.push(`SP 判定总计: ${completedPairs.length} 条`);

    // 7. 按门店同步 Supabase reports —— 已移至独立 action（apply_status_sync）分阶段执行

    // 7.5 v5.8.1+ 已订购回退：如果总需求 > 实际订购量，说明订购不够了，改回待处理
    try {
      // 找出所有状态为"已订购"的商品及总需求
      const orderedProducts = new Map<string, number>(); // product_code → total_demand
      for (const row of demandRows) {
        const code = row.product_code;
        if (!orderedProducts.has(code)) {
          orderedProducts.set(code, row.total_qty || 0);
        }
      }
      const orderedCodes = [...orderedProducts.keys()];
      if (orderedCodes.length > 0) {
        // 查 Shortage_OrderFeedback 的实际订货数量
        const fbReq = pool.request();
        const fbParams: string[] = [];
        orderedCodes.forEach((c, i) => { fbReq.input(`oc${i}`, sql.NVarChar(50), c); fbParams.push(`@oc${i}`); });
        const fbRes = await fbReq.query(`
          SELECT 商品编码, ISNULL(实际订货数量, 0) as 订货数量
          FROM dbo.Shortage_OrderFeedback
          WHERE 商品编码 IN (${fbParams.join(',')}) AND 补货状态 = '已订购'
        `);
        const orderQtyMap = new Map<string, number>();
        (fbRes.recordset || []).forEach((r: any) => {
          orderQtyMap.set(r.商品编码, Number(r.订货数量) || 0);
        });

        // 对比：总需求 > 订购量 → 改回待处理
        let revertedCount = 0;
        for (const [code, totalDemand] of orderedProducts) {
          const orderedQty = orderQtyMap.get(code) || 0;
          // 订购量=0 说明之前手工设的（没填数量），跳过
          if (orderedQty <= 0) continue;
          if (totalDemand > orderedQty) {
            await supabaseClient.from("reports").update({
              replenish_status: '待处理',
              status_remark: '自动回退（需求' + totalDemand + '>订购' + orderedQty + '）',
              status_changed_at: new Date().toISOString(),
              status_changed_by: '系统自动'
            })
              .eq("product_code", code)
              .eq("replenish_status", "已订购")
              .eq("order_type", "缺货订购");
            revertedCount++;
          }
        }
        if (revertedCount > 0) {
          details.push(`已订购回退: ${revertedCount} 个商品（需求超出订购量）`);
        }
      }
    } catch (e) {
      details.push(`已订购回退异常: ${String(e)}`);
    }

    // 8. 智能回退：检查"已到货"商品当前仓库库存，若=0则回退为"待处理"
    // 场景：上次标记"已到货"后，库存被其他店请走
    // 修复：去掉 limit 500（之前超过 500 个就漏处理），分批查库存避免大 IN 子查询超时
    try {
      // 只回退"系统自动"标记的已到货，手动设置的保留
      const { data: arrivedAll, error: arrivedErr } = await supabaseClient
        .from("reports")
        .select("product_code, store_id, status_remark")
        .eq("replenish_status", "已到货")
        .eq("order_type", "缺货订购")
        .eq("status_remark", "自动");
      details.push(`[诊断] arrivedAll 长度: ${arrivedAll?.length || 0}, 错误: ${arrivedErr?.message || 'none'}`);
      if (arrivedAll && arrivedAll.length > 0) {
        // 按商品去重
        const codeSet = [...new Set(arrivedAll.map(it => it.product_code).filter(Boolean))];
        if (codeSet.length > 0) {
          // 分批查库存（每批 50 个 code，避免大 IN 子查询超时）
          const stockMap: Record<string, number> = {};
          const BATCH_SIZE = 50;
          for (let i = 0; i < codeSet.length; i += BATCH_SIZE) {
            const codeBatch = codeSet.slice(i, i + BATCH_SIZE);
            // 使用 .input() 逐个添加参数（node-mssql 不支持 .inputs() 批量方法）
            const req = pool.request();
            const placeholders = codeBatch.map((c, idx) => {
              const p = `c${idx}`;
              req.input(p, sql.NVarChar, c);
              return `@${p}`;
            }).join(',');
            const whRes = await req.query(`
              SELECT v.usercode, ISNULL(SUM(gs.qty), 0) as wh_qty
              FROM ZHYYLS.dbo.Vptype v WITH(NOLOCK)
              LEFT JOIN ZHYYLS.dbo.GoodsStocks gs WITH(NOLOCK) ON gs.prec = v.rec AND gs.krec = '3'
              WHERE v.usercode IN (${placeholders})
              GROUP BY v.usercode
            `);
            (whRes.recordset || []).forEach((r: any) => { stockMap[r.usercode] = Number(r.wh_qty); });
            // 把没找到的编码也标记为 0
            codeBatch.forEach(c => { if (!(c in stockMap)) stockMap[c] = 0; });
          }

          // 对每个"已到货"商品，若仓库库存=0则一律回退为"待处理"
          let reverted = 0;
          let checkCount = 0;
          for (const it of arrivedAll) {
            const stock = stockMap[it.product_code];
            checkCount++;
            if ((stock === undefined ? 0 : stock) <= 0) {
              const { error: updErr } = await supabaseClient.from("reports").update({
                replenish_status: '待处理',
                status_remark: '自动',
                status_changed_at: new Date().toISOString(),
                status_changed_by: '系统自动'
              })
                .eq("product_code", it.product_code)
                .eq("store_id", it.store_id)
                .eq("order_type", "缺货订购")
                .eq("replenish_status", "已到货")
                .eq("status_remark", "自动");
              if (!updErr) {
                reverted++;
                // 同步更新通知消息
                try {
                  await supabaseClient.from("store_notifications").upsert({
                    store_id: it.store_id,
                    product_code: it.product_code,
                    message: `${it.product_code} 仓库库存已耗尽，已回退为待处理`,
                    created_at: new Date().toISOString(),
                    is_read: false
                  }, { onConflict: 'store_id,product_code' });
                } catch (_) { /* 通知更新失败不阻断 */ }
              }
            }
          }
          details.push(`[诊断] 循环遍历: ${checkCount} 条, 回退: ${reverted} 条`);
          // 调试：把诊断信息加到 details
          details.push(`[诊断] arrivedAll 长度: ${arrivedAll?.length || 0}`);
          details.push(`[诊断] codeSet 大小: ${codeSet.length}`);
          details.push(`[诊断] stockMap 大小: ${Object.keys(stockMap).length}`);
          // 检查 1083 是否在 arrivedAll
          const found1083 = (arrivedAll || []).find(it => it.product_code === '1083');
          details.push(`[诊断] arrivedAll 中 1083: ${found1083 ? JSON.stringify(found1083) : '未找到'}`);
          details.push(`[诊断] stockMap[1083]: ${stockMap['1083']}`);
          details.push(`[诊断] reverted: ${reverted}`);
          if (reverted > 0) {
            details.push(`智能回退：${reverted} 条已到货回退为待处理（仓库库存=0）`);
            console.log(`[Revert] ${reverted} 已到货 → 待处理`);
          }
        }
      }
    } catch (e) {
      console.warn('[Revert] 智能回退检查失败:', e);
    }

    // 8.6 智能回退"已完成"：以本次 SP 判定结果为基准
    // 如果一个 (product, store) 之前被自动标了"已完成"（status_remark='自动'），但本次 SP 没把它判定为"已完成"
    // 说明之前的标"已完成"是错的（数据可能已变或之前的 staging 错误），回退为"待处理"
    // 场景：1160036 的 03第三药店 老 report 被自动标"已完成" → 修复 staging 后 SP 不会再标它 → 应回退
    try {
      const storeNameToIdRevert: Record<string, string> = {
        '02第二药店': 'wszhyy02', '03第三药店': 'wszhyy03', '04第四药店': 'wszhyy04',
        '06常口店': 'wszhyy06', '08第八药店': 'wszhyy08', '09第九药店': 'wszhyy09',
        '14第十四药店': 'wszhyy14', '16凤凰山药店': 'wszhyy16', '17益丰店': 'wszhyy17', '21富源店': 'wszhyy21',
      };
      // 收集本次 SP 判定的 (product_code, store_id) 集合（已完成 + 已到货）
      const currentSyncKeys = new Set<string>();
      for (const pair of completedPairs) {
        const sid = storeNameToIdRevert[pair.store_name];
        if (sid) currentSyncKeys.add(pair.product_code + '||' + sid);
      }
      console.log(`[Revert] 本次SP判定的 (product, store) 集合: ${currentSyncKeys.size} 个`);

      // 找出所有"已完成"（自动标记）的 report
      const { data: completedItems } = await supabaseClient
        .from("reports")
        .select("id, product_code, store_id")
        .eq("replenish_status", "已完成")
        .eq("order_type", "缺货订购")
        .eq("status_remark", "自动")
        .limit(500);
      if (completedItems && completedItems.length > 0) {
        let revertedCompleted = 0;
        for (const item of completedItems) {
          if (!item.product_code || !item.store_id) continue;
          const key = item.product_code + '||' + item.store_id;
          // 如果本次 SP 没把它判定为已完成（也不在已到货），说明这个"已完成"已经过时，回退
          if (!currentSyncKeys.has(key)) {
            await supabaseClient.from("reports")
              .update({
                replenish_status: "待处理",
                status_remark: "自动回退（本次SP未判定为已完成）",
                status_changed_at: new Date().toISOString(),
                status_changed_by: "系统自动"
              })
              .eq("id", item.id);
            revertedCompleted++;
            console.log(`[Revert] ${item.product_code} ${item.store_id} 已完成→待处理 (本次SP未判定)`);
          }
        }
        if (revertedCompleted > 0) {
          details.push(`已完成回退：${revertedCompleted} 条（本次SP未判定为已完成）`);
          console.log(`[Revert] ${revertedCompleted} 已完成 → 待处理`);
        }
      }
    } catch (e) {
      console.warn('[Revert] 已完成回退检查失败:', e);
      details.push(`已完成回退异常: ${String(e)}`);
    }

    const arrivedPairs = completedPairs.filter(p => p.status === '已到货');
    const completedStoreCount = completedPairs.filter(p => p.status === '已完成').length;
    const arrivedStoreCount = arrivedPairs.length;

    return { detected: updatedCount, details, completedPairs, arrivedPairs, completedCount: completedStoreCount, arrivedCount: arrivedStoreCount };
  } catch (err) {
    console.error("[preciseAutoDetect] 错误:", err);
    return { detected: 0, details: [String(err)] };
  }
}

// ========== v2 完成判定：采购入库累计 ≥ 缺货汇总（商品级，单调递增，永不回退） ==========
// 迁移上线时间兜底锚点（product_completion 无记录时使用，方案⑤）
const STATUS_MIGRATION_EPOCH = '2026-09-17';

// 门店名称 → 门店ID 映射（复用，通知/待办时用）
const STORE_NAME_TO_ID_V2: Record<string, string> = {
  '02第二药店': 'wszhyy02', '03第三药店': 'wszhyy03', '04第四药店': 'wszhyy04',
  '06常口店': 'wszhyy06', '08第八药店': 'wszhyy08', '09第九药店': 'wszhyy09',
  '14第十四药店': 'wszhyy14', '16凤凰山药店': 'wszhyy16', '17益丰店': 'wszhyy17', '21富源店': 'wszhyy21',
};

// 返回某商品所有采购入库明细（BillType=34, InKRec='3'），按 BillDate 升序
// 用于逐笔消耗：每条 report 用自己的上报日做锚点，只消耗锚点之后未被前序消耗的入库
async function queryPurchaseDetails(
  pool: sql.ConnectionPool,
  code: string
): Promise<{ date: string; qty: number }[]> {
  const req = pool.request();
  req.input("code", sql.NVarChar(50), code);
  const res = await req.query(`
    SELECT CONVERT(VARCHAR(10), vs.BillDate, 120) as [date],
           ISNULL(ABS(vs.Qty), 0) as qty
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE v.usercode = @code
      AND vs.BillType = 34
      AND vs.InKRec = '3'
      AND vs.BillDate >= '2025-01-01'
    ORDER BY vs.BillDate ASC
  `);
  return (res.recordset || []).map((r: any) => ({
    date: String(r.date || ''),
    qty: Number(r.qty || 0)
  })).filter(r => r.qty > 0 && r.date);
}

async function preciseAutoDetectStatusV2(
  pool: sql.ConnectionPool,
  supabaseClient: any
): Promise<{ detected: number; details: string[]; completedCodes: string[]; completedCount: number }> {
  const details: string[] = [];
  const now = new Date().toISOString();
  try {
    // ====== Step 1: 分页拉全量未完成 reports（和 scheduled-task 完全一致的分页写法）======
    let allItems: any[] = [];
    let from = 0;
    const PAGE_SIZE = 1000;
    while (true) {
      const { data: page, error } = await supabaseClient
        .from("reports")
        .select("id, product_code, store_id, store_name, demand_quantity, created_at, replenish_status, status_changed_at")
        .eq("order_type", "缺货订购")
        .not("product_code", "is", null)
        .gt("demand_quantity", 0)
        .neq("replenish_status", "已完成")
        .neq("replenish_status", "厂家断货")
        .neq("replenish_status", "已关闭")
        .neq("replenish_status", "已配送")  // ★ 已配送是终态，绝对不能被 FIFO 重判覆盖！
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) { console.warn('[preciseAutoDetectV2] 分页查询失败:', error.message); break; }
      if (!page || page.length === 0) break;
      allItems = allItems.concat(page);
      if (page.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    details.push(`未完成缺货: ${allItems.length} 条`);

    const activeCodes = [...new Set(allItems.map((r: any) => r.product_code).filter(Boolean))];
    details.push(`待检测商品: ${activeCodes.length} 个`);
    if (activeCodes.length === 0) {
      return { detected: 0, details, completedCodes: [], completedCount: 0 };
    }

    // ====== Step 2: 批量查全部商品的采购入库明细（一次性 SQL，和 scheduled-task 完全一致）======
    const codesList = activeCodes.map(c => `N'${c.replace(/'/g, "''")}'`).join(',');
    let purchaseByCode: Record<string, Array<{ date: string; qty: number }>> = {};
    try {
      const purchaseRes = await pool.request().query(`
        SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
        FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
        JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
        WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesList})
      `);
      for (const row of purchaseRes.recordset) {
        const r = row as any;
        if (!purchaseByCode[r.usercode]) purchaseByCode[r.usercode] = [];
        purchaseByCode[r.usercode].push({ date: r.BillDate, qty: Number(r.qty || 0) });
      }
    } catch (e: any) {
      console.error('[preciseAutoDetectV2] 批量采购入库查询失败:', e?.message || e);
      details.push('⚠ SQL异常跳过全部判定');
      return { detected: 0, details, completedCodes: [], completedCount: 0 };
    }

    // ====== Step 3: 调用共享 runFIFO（和 scheduled-task 完全一致的核心算法）======
    // 共享模块：../_shared/fifo.ts —— 两边都调它，保证判定结果一致
    // 锚点规则：商品级 earliestTs → 北京时间日期严格门槛
    const reportsForRunFIFO = allItems.map((r: any) => ({
      id: r.id, product_code: r.product_code,
      demand_quantity: Number(r.demand_quantity) || 0, created_at: r.created_at
    }));
    const fifoRes = runFIFO(reportsForRunFIFO, purchaseByCode); // 默认 sameDayCounts=true（2026-11-08 放开锚点）
    const toCompleteIds = fifoRes.toCompleteIds;
    const purchaseEnoughMap = fifoRes.purchaseEnoughMap;
    details.push(...fifoRes.details);
    let completedCount = 0;

    details.push(`FIFO 采购入库扣减: ${toCompleteIds.length} 条 report 有机会被自动完成`);

    // ====== Step 4: 批量 UPDATE（分批 500，和 scheduled-task 一致）======
    // newlyCompletedCodes = 被 runFIFO 判定为已完成的 report 对应的商品集合
    // 不同 report 可能 remark 不同（含/不含"含当天入库"），按 remark 分组后各自 batch update
    const newlyCompletedCodes = new Set<string>();
    const remarkMap = fifoRes.remarkMap;
    if (toCompleteIds.length > 0) {
      for (const id of toCompleteIds) {
        const r = allItems.find(x => x.id === id);
        if (r) newlyCompletedCodes.add(r.product_code);
      }
      // 按 remark 分组
      const idsByRemark: Record<string, string[]> = {};
      for (const id of toCompleteIds) {
        const rm = remarkMap[id] || '自动判定：仓库采购入库满足（FIFO 先上报先满足）';
        if (!idsByRemark[rm]) idsByRemark[rm] = [];
        idsByRemark[rm].push(id);
      }
      for (const [remark, ids] of Object.entries(idsByRemark)) {
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500);
          const { error: updErr } = await supabaseClient.from("reports").update({
            replenish_status: '已完成',
            status_remark: remark,
            status_changed_at: now,
            status_changed_by: '系统自动',
            settled_at: now
          }).in("id", batch).neq("replenish_status", "已完成").neq("replenish_status", "已配送");
          if (!updErr) completedCount += batch.length;
        }
      }
      // 更新 product_completion + 清通知
      for (const code of newlyCompletedCodes) {
        try {
          await supabaseClient.from("product_completion").upsert({
            product_code: code, last_completed_at: now, fail_count: 0, updated_at: now
          }, { onConflict: 'product_code' });
        } catch (_) {}
        try { await supabaseClient.from("store_notifications").update({ notified_at: null }).eq("product_code", code); } catch (_) {}
      }
    }

    details.push(`FIFO 扣减完成: ${completedCount} 条 report`);

    // ====== Step 5: 30 天超时回退（采购已够则不回退的保护直接来自 fifoRes.purchaseEnoughMap）======
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    let revertedCount = 0;
    const nowTs = Date.now();
    for (const r of allItems) {
      const s = r.replenish_status;
      if (s !== '已订购' && s !== '待付款') continue;
      const changedAt = r.status_changed_at ? new Date(r.status_changed_at).getTime() : 0;
      if (!changedAt || (nowTs - changedAt) < THIRTY_DAYS_MS) continue;
      // 采购已够就不回退（共享 runFIFO 返回的 purchaseEnoughMap 已用相同锚点规则计算）
      if (purchaseEnoughMap[r.product_code]) continue;
      try {
        const { error: revErr } = await supabaseClient.from("reports").update({
          replenish_status: '待处理',
          status_remark: '超时回退(30天未到货)',
          status_changed_at: new Date().toISOString(),
          status_changed_by: '系统自动'
        }).eq("id", r.id);
        if (!revErr) revertedCount++;
      } catch (e) { /* 回退失败不阻断 */ }
    }
    if (revertedCount > 0) {
      details.push(`超时回退: ${revertedCount} 条(30天未到货) → 待处理`);
    }

    return { detected: completedCount, details, completedCodes: [...newlyCompletedCodes], completedCount };
  } catch (err) {
    console.error("[preciseAutoDetectV2] 错误:", err);
    return { detected: 0, details: [String(err)], completedCodes: [], completedCount: 0 };
  }
}

// 查询活跃商品的仓库库存（krec='3'）、门店库存（krec<>'3'）和在途数量，批量返回
async function queryInventoryMaps(
  pool: sql.ConnectionPool,
  codes: string[]
): Promise<{ whStock: Record<string, number>; storeStock: Record<string, number>; transit: Record<string, number> }> {
  const whStock: Record<string, number> = {};
  const storeStock: Record<string, number> = {};
  const transit: Record<string, number> = {};
  if (codes.length === 0) return { whStock, storeStock, transit };

  const krecToStoreId: Record<string, string> = {};
  Object.entries(STORE_KREC_MAP).forEach(([name, krec]) => {
    krecToStoreId[krec] = STORE_NAME_TO_ID_V2[name] || '';
  });

  for (let i = 0; i < codes.length; i += 100) {
    const batch = codes.slice(i, i + 100);
    try {
      // 仓库库存（配送中心 krec='3'）
      const whReq = pool.request();
      const whPlaceholders = batch.map((c, idx) => { whReq.input(`c${idx}`, sql.NVarChar(50), c); return `@c${idx}`; }).join(',');
      const whRes = await whReq.query(`
        SELECT v.usercode, ISNULL(SUM(gs.qty), 0) as wh_qty
        FROM ZHYYLS.dbo.Vptype v WITH(NOLOCK)
        LEFT JOIN ZHYYLS.dbo.GoodsStocks gs WITH(NOLOCK) ON gs.prec = v.rec AND gs.krec = '3'
        WHERE v.usercode IN (${whPlaceholders})
        GROUP BY v.usercode
      `);
      (whRes.recordset || []).forEach((r: any) => { whStock[r.usercode] = Number(r.wh_qty); });
    } catch (_) { /* 仓库库存失败不阻断 */ }

    try {
      // 门店库存（各门店 krec <> '3'）
      const stReq = pool.request();
      const stPlaceholders = batch.map((c, idx) => { stReq.input(`s${idx}`, sql.NVarChar(50), c); return `@s${idx}`; }).join(',');
      const stRes = await stReq.query(`
        SELECT v.usercode, gs.krec, ISNULL(SUM(gs.qty), 0) as store_qty
        FROM ZHYYLS.dbo.Vptype v WITH(NOLOCK)
        JOIN ZHYYLS.dbo.GoodsStocks gs WITH(NOLOCK) ON gs.prec = v.rec
        WHERE v.usercode IN (${stPlaceholders}) AND gs.krec <> '3'
        GROUP BY v.usercode, gs.krec
      `);
      (stRes.recordset || []).forEach((r: any) => {
        const sid = krecToStoreId[r.krec];
        if (sid) storeStock[r.usercode + '||' + sid] = Number(r.store_qty);
      });
    } catch (_) { /* 门店库存失败不阻断 */ }

  }

  // 在途（实时：Gp_SendDoing 存储过程，一次返回全部在途记录）
  try {
    const d30 = bjDaysAgo(30);
    const today = bjToday();
    const gReq = pool.request();
    gReq.input('sd', sql.VarChar(10), d30);
    gReq.input('ed', sql.VarChar(10), today);
    const gRes = await Promise.race([
      gReq.query(`EXEC ZHYYLS.dbo.Gp_SendDoing 0,'','',0,0,0,@sd,@ed,0,0,0,2`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('在途查询超时(30s)')), 30000))
    ]);
    const rows = gRes.recordset || [];
    // 反查 PRec → usercode
    const precList = [...new Set(rows.map((r: any) => r.PRec).filter(Boolean))];
    const precToCode: Record<number, string> = {};
    for (let i = 0; i < precList.length; i += 500) {
      const batch = precList.slice(i, i + 500);
      const vpReq = pool.request();
      const ph = batch.map((p, idx) => { vpReq.input(`p${idx}`, sql.Int, p); return `@p${idx}`; }).join(',');
      const vpRes = await vpReq.query(`SELECT rec, usercode FROM ZHYYLS.dbo.Vptype WITH(NOLOCK) WHERE rec IN (${ph})`);
      (vpRes.recordset || []).forEach((r: any) => { precToCode[r.rec] = r.usercode; });
    }
    // 构建 transit map（posid = 门店 krec，KRec=3 为配送中心出库）
    for (const r of rows) {
      const sid = krecToStoreId[String(r.posid)];
      const code = precToCode[r.PRec];
      if (!sid || !code) continue;
      const k = code + '||' + sid;
      transit[k] = (transit[k] || 0) + Number(r.Qty);
    }
  } catch (_) { /* 在途查询失败不阻断 */ }

  return { whStock, storeStock, transit };
}

// 查询累计配送量（从上报日期起，配送中心 OutKRec='3' 出库到门店，排除调货出库单）
async function queryDeliveredMap(
  pool: sql.ConnectionPool,
  pairs: Array<{ code: string; krec: string; since: string }>
): Promise<Record<string, number>> {
  const delivered: Record<string, number> = {};
  if (pairs.length === 0) return delivered;

  const codes = [...new Set(pairs.map(p => p.code))];
  const precMap: Record<string, number> = {};
  const precToCode: Record<number, string> = {};
  for (let i = 0; i < codes.length; i += 200) {
    const batch = codes.slice(i, i + 200);
    const req = pool.request();
    const ph = batch.map((c, idx) => { req.input(`c${idx}`, sql.NVarChar(50), c); return `@c${idx}`; }).join(',');
    const res = await req.query(`SELECT rec, usercode FROM ZHYYLS.dbo.Vptype WITH(NOLOCK) WHERE usercode IN (${ph})`);
    (res.recordset || []).forEach((r: any) => { precMap[r.usercode] = r.rec; precToCode[r.rec] = r.usercode; });
  }

  const krecToStoreId: Record<string, string> = {};
  Object.entries(STORE_KREC_MAP).forEach(([name, krec]) => { krecToStoreId[krec] = STORE_NAME_TO_ID_V2[name] || ''; });

  for (let i = 0; i < pairs.length; i += 50) {
    const batch = pairs.slice(i, i + 50);
    const req = pool.request();
    const vals: string[] = [];
    batch.forEach((p, j) => {
      req.input(`p${j}`, sql.Int, precMap[p.code] || 0);
      req.input(`k${j}`, sql.NVarChar(10), p.krec);
      req.input(`s${j}`, sql.VarChar(10), p.since);
      vals.push(`(@p${j}, @k${j}, @s${j})`);
    });
    const res = await req.query(`
      CREATE TABLE #ZHD (prec INT, krec NVARCHAR(10), since VARCHAR(10));
      INSERT INTO #ZHD (prec, krec, since) VALUES ${vals.join(',')};
      SELECT z.prec, z.krec, ISNULL(SUM(ABS(v.Qty)), 0) as delivered_qty
      FROM #ZHD z
      JOIN ZHYYLS.dbo.vBuySendSumDetail v WITH(NOLOCK)
        ON v.PRec = z.prec AND v.InKRec = z.krec AND v.OutKRec = '3'
        AND v.BillDate >= z.since
        AND (v.Comment IS NULL OR v.Comment NOT LIKE '%调货出库单%')
      GROUP BY z.prec, z.krec;
      DROP TABLE #ZHD;
    `);
    (res.recordset || []).forEach((r: any) => {
      const sid = krecToStoreId[String(r.krec)];
      const code = precToCode[r.prec];
      if (sid && code) delivered[code + '||' + sid] = Number(r.delivered_qty);
    });
  }
  return delivered;
}

// 允许的来源域名列表（安全增强）
// v442: 加 http://127.0.0.1 支持 Electron 本地静态加载版
const ALLOWED_ORIGINS = [
  "https://wszhyy.pages.dev",   // Cloudflare Pages 正式环境
  "https://wslzhyy.pages.dev",  // Cloudflare Pages 备用域名
  "http://localhost:8780",       // 本地开发环境
  "http://localhost:3000",        // 本地开发环境
  "http://localhost:5173",        // Vite 默认端口
  "null",                         // file:// 协议 Origin 为 null
];

// 门店名称 → ZHYYLS krec 映射
const STORE_KREC_MAP: Record<string, string> = {
  '02第二药店': '5', '03第三药店': '6', '04第四药店': '7',
  '06常口店': '9', '08第八药店': '66', '09第九药店': '11',
  '14第十四药店': '36', '16凤凰山药店': '50', '17益丰店': '13', '21富源店': '63',
};

// 门店账号 → 门店名称映射
const STORE_NAME_MAP: Record<string, string> = {
  'wszhyy02': '02第二药店',
  'wszhyy03': '03第三药店',
  'wszhyy04': '04第四药店',
  'wszhyy06': '06常口店',
  'wszhyy08': '08第八药店',
  'wszhyy09': '09第九药店',
  'wszhyy14': '14第十四药店',
  'wszhyy16': '16凤凰山药店',
  'wszhyy17': '17益丰店',
  'wszhyy21': '21富源店',
  '15305479520': '02第二药店',  // 02第二药店管理员账号
};

// 账号/手机号 → 真实门店ID映射（用于 sub-account 登录时定位门店）
const USER_STORE_MAP: Record<string, string> = {
  '15305479520': 'wszhyy02',
};


function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  // 允许 *.wszhyy.pages.dev 所有部署子域名 + localhost + 127.0.0.1 (Electron 本地版) + null (file:// 协议)
  const isAllowed = ALLOWED_ORIGINS.includes(origin) ||
                    /^https:\/\/[\w-]+\.wszhyy\.pages\.dev$/.test(origin) ||
                    origin.startsWith("http://localhost") ||
                    origin.startsWith("http://127.0.0.1") ||
                    origin.startsWith("http://0.0.0.0");
  const allowedOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// 输入验证函数（安全增强）
function validateInput(input: any, fieldName: string, maxLength: number = 100): string {
  if (input === null || input === undefined) return "";
  const str = String(input).trim();
  if (str.length > maxLength) {
    throw new Error(`${fieldName}长度不能超过${maxLength}个字符`);
  }
  // 特殊字符转义
  return str.replace(/[<>'"]/g, '');
}

// ========== P0-3: 时区统一 — 北京时间口径（2026-11-07 新增）==========
// Supabase reports.created_at 存 UTC ISO 8601；SQL Server ZHYYLS.BillDate 是北京时间
// 所有业务日期判定（锚点、since、30天窗口、今天）都必须用北京时间
function toBjDate(utcInput: string | Date | undefined | null): string {
  if (!utcInput) return '';
  const d = typeof utcInput === 'string' ? new Date(utcInput) : utcInput;
  if (isNaN(d.getTime())) return '';
  const bjMs = d.getTime() + 8 * 3600000; // UTC → 北京
  return new Date(bjMs).toISOString().substring(0, 10);
}
function bjToday(): string { return toBjDate(new Date()); }
function bjDaysAgo(n: number): string { return toBjDate(new Date(Date.now() - n * 86400000)); }

// ========== FIFO 锚点门槛判定（唯一一处，可配置 sameDayCounts）==========
// 采购入库 BillDate（北京时间 YYYY-MM-DD）是否计入该商品 pending reports 的 FIFO 采购池
// 参数：
//   billDateBj     — 采购入库日期（北京时间 YYYY-MM-DD，SQL Server BillDate 直接用）
//   anchorDateBj   — 锚点日期（北京时间 YYYY-MM-DD，来自 toBjDate(最早 pending report.created_at)）
//   sameDayCounts  — true=当天入库算当天报的缺（宽松）；false=当天入库不算（严格）
// 默认严格口径（sameDayCounts=false）：BillDate 必须严格晚于 anchorDateBj
// 要放宽当天入库，只需全局改 sameDayCounts 默认值为 true，其余调用点无需动
function isPurchaseEligible(
  billDateBj: string,
  anchorDateBj: string,
  sameDayCounts: boolean = true   // 【2026-11-08 放开锚点】默认宽松：BillDate >= 锚点日期（当天入库算）
): boolean {
  if (!billDateBj || !anchorDateBj) return false;
  if (sameDayCounts) {
    return billDateBj >= anchorDateBj;   // 宽松：日期相等也算
  } else {
    return billDateBj > anchorDateBj;    // 严格：日期必须严格晚于
  }
}

// ========== 内联 runFIFO（放开锚点后默认宽松口径，与 scheduled-task 共享逻辑）==========
// 2026-11-08 改版：采购池按"历史入库/当天入库"分池子，FIFO 先扣历史再扣当天，
// 每条被完成的 report 在 remarkMap 里带对应 remark（含/不含"含当天入库"）
function runFIFO(
  pendingReports: any[],
  purchaseByCode: Record<string, any[]>,
  sameDayCounts: boolean = true   // 默认宽松
): {
  toCompleteIds: string[];
  details: string[];
  purchaseEnoughMap: Record<string, boolean>;
  skippedNoEligible: number;
  remarkMap: Record<string, string>;   // 新增：reportId -> 该条的 status_remark
} {
  const details: string[] = [];
  const toCompleteIds: string[] = [];
  const remarkMap: Record<string, string> = {};
  const purchaseEnoughMap: Record<string, boolean> = {};
  let skippedNoEligible = 0;

  const itemsByCode: Record<string, any[]> = {};
  for (const r of pendingReports) {
    const code = r.product_code;
    if (!code) continue;
    if (!itemsByCode[code]) itemsByCode[code] = [];
    itemsByCode[code].push(r);
  }
  for (const code of Object.keys(itemsByCode)) {
    itemsByCode[code].sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  }

  const activeCodes = Object.keys(itemsByCode);
  details.push(`待检测商品: ${activeCodes.length} 个`);

  for (const code of activeCodes) {
    const myReports = itemsByCode[code];
    if (myReports.length === 0) continue;

    const purchaseRows = purchaseByCode[code] || [];
    if (purchaseRows.length === 0) {
      skippedNoEligible += myReports.length;
      purchaseEnoughMap[code] = false;
      continue;
    }

    // 【2026-11-09 修复】每条 report 用自己的 created_at 当 anchor
    const poolEntries = purchaseRows
      .map(p => ({ bill_date_bj: toBjDate(p.date), orig_qty: Number(p.qty || 0), remain: Number(p.qty || 0) }))
      .sort((a, b) => a.bill_date_bj.localeCompare(b.bill_date_bj));

    let passed = 0, demandSum = 0;
    let usedSame = false;
    for (const r of myReports) {
      const demand = Number(r.demand_quantity) || 0;
      if (demand <= 0) continue;
      demandSum += demand;
      const myAnchor = toBjDate(r.created_at);

      let eligibleRemain = 0;
      for (const pe of poolEntries) {
        if (isPurchaseEligible(pe.bill_date_bj, myAnchor, sameDayCounts)) eligibleRemain += pe.remain;
      }

      if (eligibleRemain >= demand) {
        // 判断是否吃到了"当天入库"（BillDate == myAnchor）
        let need = demand;
        let ateSameDay = false;
        for (const pe of poolEntries) {
          if (need <= 0) break;
          if (!isPurchaseEligible(pe.bill_date_bj, myAnchor, sameDayCounts)) continue;
          if (pe.bill_date_bj === myAnchor) ateSameDay = true;
          const take = Math.min(pe.remain, need);
          pe.remain -= take;
          need -= take;
        }
        toCompleteIds.push(r.id);
        remarkMap[r.id] = ateSameDay
          ? '自动判定：仓库采购入库满足（FIFO 先上报先满足，含当天入库）'
          : '自动判定：仓库采购入库满足（FIFO 先上报先满足）';
        if (ateSameDay) usedSame = true;
        passed++;
      } else break;
    }

    const latestAnchorBj = toBjDate(myReports[myReports.length - 1].created_at);
    let latestAnchorEligible = 0;
    for (const pe of poolEntries) {
      if (isPurchaseEligible(pe.bill_date_bj, latestAnchorBj, sameDayCounts)) latestAnchorEligible += pe.orig_qty;
    }
    purchaseEnoughMap[code] = latestAnchorEligible >= demandSum;

    if (passed > 0) {
      let latestRemainAfter = 0;
      for (const pe of poolEntries) {
        if (isPurchaseEligible(pe.bill_date_bj, latestAnchorBj, sameDayCounts)) latestRemainAfter += pe.remain;
      }
      const tag = usedSame ? ' ⚠含当天入库' : '';
      details.push(
        `  ${code}: ${passed}/${myReports.length} 完成（最新anchor后采购池剩 ${latestRemainAfter}, 总需求 ${demandSum}）${tag}`
      );
    }
  }

  details.push(`FIFO 完成判定: ${toCompleteIds.length} 条 report`);
  if (skippedNoEligible > 0) {
    details.push(`无可用采购跳过: ${skippedNoEligible} 条`);
  }

  return { toCompleteIds, details, purchaseEnoughMap, skippedNoEligible, remarkMap };
}

// 格式化日期（用于提示文案）
function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.getFullYear() + '/' + (d.getMonth()+1) + '/' + d.getDate();
  } catch { return dateStr; }
}

serve(async (req) => {
  // 连接池预热（首次请求时自动触发）
  warmupPools();
  
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    let reqBody;
    try {
      reqBody = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "请使用 POST + JSON 格式调用" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { action, params } = reqBody;

    // ========== P0-1: Action 级别鉴权（2026-11-07 新增）==========
    // 写操作 action 必须满足其一：x-task-secret 正确（定时任务）/ operator 在 admin_users 表且角色为 admin
    const ADMIN_WRITABLE_ACTIONS = new Set([
      'manual_update_status', 'batch_update_status', 'recheck_auto_completed',
      'rebuild_feedback_from_supabase', 'apply_status_sync', 'revert_false_completed',
      'fix_zero_order_qty', 'second_check', 'sync_with_auto_status', 'sync_integration',
      'sync_realtime_only', 'sync_cache', 'sync_inventory_full', 'notify_refresh',
      'delete_new_product', 'set_actual_order_qty', 'mark_store_completed',
      'restore_reports', 'backfill_status_time', 'sync_product_cache',
      'sync_inventory_incremental', 'auto_detect_status', 'sync_integration',
      'check_single_product',
      'batch_authorize', 'authorize_device', 'revoke_device', 'clear_all_device_auth',
      'approve_report', 'unbind_device', 'add_employee', 'toggle_employee',
      'update_employee_password', 'reset_employee_password', 'add_admin_user',
      'update_admin_user', 'toggle_admin_user', 'delete_admin_user',
      'log_admin_action'
    ]);
    if (ADMIN_WRITABLE_ACTIONS.has(action)) {
      // 方式 1: 定时任务专用密钥（x-task-secret header）
      const taskSecret = req.headers.get("x-task-secret") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      const bearerAuth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (taskSecret === TASK_SECRET || bearerAuth === TASK_SECRET) {
        // ✅ 定时任务
      } else {
        // 方式 2: 管理员身份 — operator 查 admin_users 表（同时支持 username 和 user_id 两种标识）
        const operator = params?.operator as string | undefined;
        let authPassed = false;
        if (operator) {
          try {
            // ★ 2026-11-10 修复：之前用 .or(`username.eq.${op},user_id.eq.${op}`)
            // 对 username 不是字面 "admin" 的账号查不到（admin_users 表用的是 id 不是 user_id，
            // 且 .or() 里一个条件不匹配会让 maybeSingle 返回空）
            // 改成两次独立查询（先 username，再 id），谁先命中用谁
            const op = String(operator).trim();
            const q1 = await supabase
              .from("admin_users")
              .select("role")
              .eq("is_active", true)
              .eq("username", op)
              .maybeSingle();
            let role: string | null = null;
            if (!q1.error && q1.data) role = (q1.data as any).role;
            if (!role) {
              const q2 = await supabase
                .from("admin_users")
                .select("role")
                .eq("is_active", true)
                .eq("id", op)
                .maybeSingle();
              if (!q2.error && q2.data) role = (q2.data as any).role;
            }
            if (role && ['admin', 'super_admin'].includes(role)) {
              authPassed = true;
            } else {
              console.warn(`[P0鉴权] operator=${op} 查询到的 role=${role || 'null'}, is_active=true`);
            }
          } catch (e) {
            console.warn(`[P0鉴权] admin_users 查询异常: ${String(e)}`);
          }
        }
        if (!authPassed) {
          // 兼容 admin 硬编码账号（store_login 里 username='admin' 直接返回 super_admin，不查 admin_users 表）
          if (operator === 'admin') {
            authPassed = true;
          }
        }
        if (!authPassed) {
          console.warn(`[P0鉴权拦截] action=${action}, operator=${operator || '(无)'}, header=task-secret=${taskSecret === TASK_SECRET}`);
          return new Response(JSON.stringify({ success: false, error: "无权限执行此操作（需要管理员身份或定时任务密钥）", code: "FORBIDDEN" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    let result;
    let lastRefreshTime: string | null = null;
    switch (action) {
      case "search_product": {
        // 搜索商品 - 查 Supabase 缓存（支持商品编码、名称、规格、厂家模糊匹配）
        // product_code 已存储 USERCODE（商品条码），与原业务系统编码一致
        // 优化：拼音码改精确匹配（已存储小写），减少 ilike 开销
        const keyword = validateInput(params?.keyword, "关键词", 50);
        if (!keyword) {
          return new Response(JSON.stringify({ error: "关键词不能为空" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const kwLower = keyword.toLowerCase().trim();
        
        // 拼音码精确匹配（最快）
        const { data: pyData, error: pyError } = await supabase
          .from("product_cache")
          .select("product_code, product_name, product_spec, manufacturer, pinyin_code")
          .eq("pinyin_code", kwLower)
          .limit(500);
        
        let result = pyData || [];
        
        // 如果精确匹配结果不足，再补充模糊匹配
        if (result.length < 50) {
          const fuzzyData = await supabase
            .from("product_cache")
            .select("product_code, product_name, product_spec, manufacturer, pinyin_code")
            .or(`product_code.ilike.%${keyword}%,product_name.ilike.%${keyword}%,product_spec.ilike.%${keyword}%,manufacturer.ilike.%${keyword}%`)
            .order("product_code")
            .limit(500);
          
          if (!fuzzyData.error && fuzzyData.data) {
            // 合并去重
            const seen = new Set(result.map(p => p.product_code));
            fuzzyData.data.forEach(p => {
              if (!seen.has(p.product_code)) {
                result.push(p);
                seen.add(p.product_code);
              }
            });
          }
        }

        result = result.slice(0, 500);
        break;
      }

      case "get_all_products": {
        // 获取全量商品数据（L2内存缓存10分钟，商品信息基本不变）
        const productCacheKey = 'all_products';
        const cached = memCacheGet<any[]>(productCacheKey, MEM_CACHE_TTL_PRODUCTS);
        if (cached) {
          console.log(`✅ get_all_products 命中L2缓存，返回 ${cached.length} 条`);
          result = cached;
          break;
        }
        
        // 从 RQZT 本地缓存表获取商品（避免跨库全表扫描 ZHYYLS，3-5s → 200ms）
        const poolRQZT = await getPool();
        try {
          const productsResult = await poolRQZT.request()
            .query(`SELECT
                    product_code,
                    product_name,
                    spec as product_spec,
                    manufacturer,
                    pinyin_code
                    FROM dbo.ProductCache_RQZT WITH (NOLOCK)
                    ORDER BY product_code`);
          
          // 映射为统一格式
          result = productsResult.recordset.map(p => ({
            product_code: (p.product_code || '').trim(),
            product_name: p.product_name || '',
            product_spec: p.product_spec || '',
            manufacturer: p.manufacturer || '',
            pinyin_code: (p.pinyin_code || '').trim().toLowerCase(),
          }));
          
          memCacheSet(productCacheKey, result); // 存入L2缓存
          console.log(`✅ get_all_products 返回 ${result.length} 个商品（RQZT缓存表）`);
        } finally {
          releasePool(poolRQZT);
        }
        break;
      }

      // ========== 检查商品列表是否有更新 ==========
      case "check_products_update": {
        // 从 RQZT 缓存表查询商品总数（避免跨库全表扫描 ZHYYLS）
        const poolRQZT = await getPool();
        try {
          const countResult = await poolRQZT.request()
            .query(`SELECT COUNT(1) as product_count FROM dbo.ProductCache_RQZT WITH (NOLOCK)`);
          
          const currentCount = countResult.recordset[0]?.product_count || 0;
          result = {
            product_count: currentCount,
            last_update: new Date().toISOString()
          };
          console.log(`✅ check_products_update 当前商品数: ${currentCount} (RQZT缓存表)`);
        } finally {
          releasePool(poolRQZT);
        }
        break;
      }

      // ========== 预加载方案：一次性返回本店所有商品库存（P0优化：优先查Supabase缓存）==========
      case "get_store_inventory": {
        // P0优化：优先从 Supabase 缓存查询，Supabase 失败再降级到 SQL Server
        // 这样可以大幅提升响应速度（Supabase ~50ms vs SQL Server ~3000ms）
        const store_name = validateInput(params?.store_name, "门店名称", 100);
        const force_refresh = params?.force_refresh === true;
        const sync_first = params?.sync_first === true;  // 是否先同步SPFXB_Result再查询
        const product_codes = Array.isArray(params?.product_codes) ? params.product_codes : null; // 可选：按商品编码过滤
        
        // 强制刷新+先同步：执行 SPFXB 增量刷新（从 ZHYYLS 实时取库存/销售/在途，5-15s）
        let spfxbTime: string | null = null;
        if (force_refresh && sync_first) {
          console.log(`[get_store_inventory] 门店「${store_name}」触发SPFXB增量刷新...`);
          try {
            const syncPool = await getPool();
            try {
              const syncReq = syncPool.request();
              syncReq.input("RefreshRanking", sql.Int, 0);
              await syncReq.execute("SPFXB");
              spfxbTime = new Date().toISOString();
              console.log(`[get_store_inventory] SPFXB增量刷新完成`);
              // 记录刷新时间到 Supabase（供所有门店读取）
              await supabase.from("sync_metadata").upsert([{
                sync_type: 'spfxb_refresh',
                last_sync: spfxbTime,
                status: 'success'
              }], { onConflict: 'sync_type' });
            } finally {
              releasePool(syncPool);
            }
          } catch (syncErr) {
            console.error(`[get_store_inventory] SPFXB增量刷新失败:`, syncErr);
          }
        }
        // 如果没有刷新，从数据库读上次刷新时间
        if (!spfxbTime) {
          const { data: metaRow } = await supabase
            .from("sync_metadata")
            .select("last_sync")
            .eq("sync_type", "spfxb_refresh")
            .single();
          spfxbTime = metaRow?.last_sync || null;
        }
        lastRefreshTime = spfxbTime;
        
        // 尝试从 Supabase 缓存查询（强制刷新时跳过缓存，直接查 SQL Server 最新数据）
        if (!force_refresh) {
        try {
          let q = supabase
            .from("shortage_storestock_cache")
            .select("*")
            .like("store_name", store_name ? `%${store_name}%` : "%%");
          // 按 product_codes 过滤（避免 1000 行 PostgREST 上限）
          if (product_codes && product_codes.length > 0) {
            q = q.in("product_code", product_codes.slice(0, 500));
          }
          const { data: supabaseData, error: supabaseError } = await q.limit(10000);
          
          if (!supabaseError && supabaseData && supabaseData.length > 0) {
            // Supabase 缓存缺少商品名称等字段，需要从 product_cache 补充
            const productCodes = [...new Set(supabaseData.map((r: any) => r.product_code).filter(Boolean))];
            let productMap: Record<string, any> = {};
            
            if (productCodes.length > 0) {
              try {
                // 分批查询（避免 URL 过长）
                const batchSize = 100;
                for (let i = 0; i < productCodes.length; i += batchSize) {
                  const batch = productCodes.slice(i, i + batchSize);
                  const { data: productData } = await supabase
                    .from("product_cache")
                    .select("product_code, product_name, product_spec, manufacturer")
                    .in("product_code", batch);
                  
                  if (productData) {
                    productData.forEach((p: any) => {
                      productMap[p.product_code] = p;
                    });
                  }
                }
              } catch (e) {
                console.warn("查询 product_cache 失败:", e);
              }
            }
            
            // 合并商品信息到库存数据
            result = supabaseData.map((r: any) => {
              const productInfo = productMap[r.product_code] || {};
              return {
                门店名称: r.store_name || "",
                商品编码: r.product_code || "",
                商品名称: productInfo.product_name || "",
                规格: productInfo.product_spec || "",
                生产企业: productInfo.manufacturer || "",
                库存数量: r.store_stock || 0,
                在途数量: r.in_transit || 0,
                门店库存汇总: r.store_total || 0,
                配送中心库存数量: r.dc_stock || 0,
                前30天销售数量: r.sales_30days || 0,
                前90天销售数量: r.sales_90days || 0,
                月均销售数量: r.monthly_sales || 0,
                标准库存数量: r.standard_stock || 0,
                门店计划: r.store_plan || 0,
                建议订货数量: Math.max(0, (r.standard_stock || 0) - (r.store_total || 0)),
                _source: 'supabase'
              };
            });
            console.log(`✅ get_store_inventory 从Supabase返回 ${result.length} 条记录`);
            break;
          } else {
            console.log(`⚠️ Supabase缓存为空，尝试从SQL Server查询`);
          }
        } catch (supabaseErr) {
          console.error(`Supabase查询失败，降级到SQL Server:`, supabaseErr);
        }
        } // end if (!force_refresh)
        
        // 降级：从 SQL Server 获取（强制刷新时直接走这里）
        const pool = await getPool();
        try {
          const request = pool.request()
            .input("门店名称", sql.NVarChar, store_name || '');

          // 按 product_codes 过滤（避免 2746 行全表扫描）
          let codesFilter = '';
          if (product_codes && product_codes.length > 0) {
            const codeList = product_codes.slice(0, 500).map(c => `'${String(c).replace(/'/g, "''")}'`).join(',');
            codesFilter = ` AND s.商品编码 IN (${codeList})`;
          }

          const sqlQuery = `
            SELECT
              s.门店名称,
              s.商品编码,
              s.商品名称,
              s.规格,
              s.生产企业,
              s.库存数量,
              s.在途数量,
              s.门店库存汇总,
              s.配送中心库存数量,
              s.前30天销售数量,
              s.前90天销售数量,
              s.月均销售数量,
              ISNULL(s.标准库存数量确认, s.标准库存数量) AS 标准库存数量,
              s.门店计划,
              CASE
                WHEN s.门店库存汇总 - ISNULL(s.标准库存数量确认, s.标准库存数量) > 0 THEN 0
                WHEN s.门店库存汇总 > ROUND(ISNULL(s.标准库存数量确认, s.标准库存数量) / 2.0, 0) THEN -1
                ELSE s.门店库存汇总 - ISNULL(s.标准库存数量确认, s.标准库存数量)
              END AS 建议订货数量
            FROM dbo.SPFXB_Result s WITH (NOLOCK)
            WHERE (@门店名称 = '' OR s.门店名称 LIKE '%' + @门店名称 + '%')${codesFilter}
          `;

          const resultSet = await request.query(sqlQuery);

          let records: any[] = [];
          if (resultSet.recordset && resultSet.recordset.length > 0) {
            records = resultSet.recordset.map((r: any) => ({
              门店名称: r.门店名称 || "",
              商品编码: r.商品编码 || "",
              商品名称: r.商品名称 || "",
              规格: r.规格 || "",
              生产企业: r.生产企业 || "",
              库存数量: r.库存数量 || 0,
              在途数量: r.在途数量 || 0,
              门店库存汇总: r.门店库存汇总 || 0,
              配送中心库存数量: r.配送中心库存数量 || 0,
              前30天销售数量: r.前30天销售数量 || 0,
              前90天销售数量: r.前90天销售数量 || 0,
              月均销售数量: r.月均销售数量 || 0,
              标准库存数量: r.标准库存数量 || 0,
              门店计划: r.门店计划 || 0,
              建议订货数量: r.建议订货数量 || 0,
              _source: 'sqlserver'
            }));
          }

          result = records;
          console.log(`✅ get_store_inventory 从SQL Server返回 ${records.length} 条记录（门店:${store_name}, 强制刷新${force_refresh ? '是' : '否'}）`);
          // 采样输出前3条记录的关键字段，方便调试
          if (records.length > 0) {
            const sample = records.slice(0, 3).map((r: any) => ({
              商品编码: r.商品编码,
              门店名称: r.门店名称,
              库存数量: r.库存数量,
              在途数量: r.在途数量,
              前30天销售数量: r.前30天销售数量,
              标准库存数量: r.标准库存数量,
              来源: r._source
            }));
            console.log(`[采样数据] 前3条:`, JSON.stringify(sample));
          } else {
            console.warn(`[警告] SPFXB_Result 中门店「${store_name}」无数据！可能门店名称不匹配`);
          }
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "get_product_detail": {
        // 商品详情 - 返回该商品在所有门店的数据（用于弹窗显示各门店库存）
        const product_code = validateInput(params?.product_code, "商品编码", 50);
        const store_name = validateInput(params?.store_name, "门店名称", 100);
        const force_refresh = params?.force_refresh === true;
        
        // P0优化：先尝试从 Supabase 查询（查所有门店的该商品）
        // 强制刷新时跳过缓存，直接查 SQL Server
        if (!force_refresh) {
          try {
            const { data: supabaseData, error: supabaseError } = await supabase
              .from("shortage_storestock_cache")
              .select("*")
              .eq("product_code", product_code)
              .limit(200);
            
            if (!supabaseError && supabaseData && supabaseData.length > 0) {
              // 过滤脏数据（store_name 为空/null/通配符，store_stock 非数字）
              const cleanData = supabaseData.filter((r: any) => {
                const name = r.store_name;
                if (!name || name === '*' || name === 'null' || name === 'undefined') return false;
                const stock = r.store_stock;
                if (typeof stock === 'string' && isNaN(Number(stock))) return false;
                return true;
              });
              
              if (cleanData.length > 0) {
                // 构建所有门店记录，当前门店排第一
                const records = cleanData
                  .sort((a: any, b: any) => {
                    const aMatch = store_name && a.store_name && a.store_name.includes(store_name) ? 0 : 1;
                    const bMatch = store_name && b.store_name && b.store_name.includes(store_name) ? 0 : 1;
                    return aMatch - bMatch || (a.store_name || '').localeCompare(b.store_name || '', 'zh-CN');
                  })
                  .map((r: any) => ({
                    门店名称: r.store_name || "",
                    商品编码: r.product_code || "",
                    商品名称: r.product_name || "",
                    规格: r.product_spec || "",
                    生产企业: r.manufacturer || "",
                    库存数量: Number(r.store_stock) || 0,
                    在途数量: Number(r.in_transit) || 0,
                    门店库存汇总: Number(r.store_total) || 0,
                    配送中心库存数量: Number(r.dc_stock) || 0,
                    前30天销售数量: Number(r.sales_30days) || 0,
                    前90天销售数量: Number(r.sales_90days) || 0,
                    月均销售数量: Number(r.monthly_sales) || 0,
                    标准库存数量: Number(r.standard_stock) || 0,
                    门店计划: Number(r.store_plan) || 0,
                    建议订货数量: Math.max(0, (Number(r.standard_stock) || 0) - (Number(r.store_total) || 0)),
                    _source: 'supabase'
                  }));
                
                result = [records];
                console.log(`✅ get_product_detail 从Supabase返回商品 ${product_code}，共 ${records.length} 条门店记录`);
                break;
              } else {
                console.log(`⚠️ Supabase缓存数据全部脏数据，降级到SQL Server`);
              }
            }
          } catch (supabaseErr) {
            console.error(`Supabase查询商品详情失败，降级到SQL Server:`, supabaseErr);
          }
        }
        
        // 降级：从 SQL Server 获取（查询该商品所有门店数据）
        const pool = await getPool();
        try {
          const request = pool.request()
            .input("商品编码", sql.NVarChar, product_code)
            .input("门店名称", sql.NVarChar, store_name || "");
          
          const sqlQuery = `
            SELECT
              s.门店名称,
              s.商品编码,
              s.商品名称,
              s.规格,
              s.生产企业,
              s.库存数量 AS 库存数量,
              s.在途数量,
              s.门店库存汇总,
              s.配送中心库存数量,
              s.前30天销售数量,
              s.前90天销售数量,
              s.月均销售数量,
              ISNULL(s.标准库存数量确认, s.标准库存数量) AS 标准库存数量,
              s.门店计划,
              CASE 
                WHEN s.门店库存汇总 - ISNULL(s.标准库存数量确认, s.标准库存数量) > 0 THEN 0
                WHEN s.门店库存汇总 > ROUND(ISNULL(s.标准库存数量确认, s.标准库存数量) / 2.0, 0) THEN -1
                ELSE s.门店库存汇总 - ISNULL(s.标准库存数量确认, s.标准库存数量)
              END AS 建议订货数量
            FROM dbo.SPFXB_Result s WITH (NOLOCK)
            WHERE s.商品编码 = @商品编码
            ORDER BY CASE WHEN @门店名称 = '' OR s.门店名称 LIKE '%' + @门店名称 + '%' THEN 0 ELSE 1 END,
                     s.门店名称
          `;
          
          const resultSet = await request.query(sqlQuery);
          
          let records: any[] = [];
          if (resultSet.recordset && resultSet.recordset.length > 0) {
            records = resultSet.recordset.map((r: any) => ({
              门店名称: r.门店名称 || "",
              商品编码: r.商品编码 || "",
              商品名称: r.商品名称 || "",
              规格: r.规格 || "",
              生产企业: r.生产企业 || "",
              库存数量: r.库存数量 || 0,
              在途数量: r.在途数量 || 0,
              门店库存汇总: r.门店库存汇总 || 0,
              配送中心库存数量: r.配送中心库存数量 || 0,
              前30天销售数量: r.前30天销售数量 || 0,
              前90天销售数量: r.前90天销售数量 || 0,
              月均销售数量: r.月均销售数量 || 0,
              标准库存数量: r.标准库存数量 || 0,
              门店计划: r.门店计划 || 0,
              建议订货数量: r.建议订货数量 || 0,
              _source: 'sqlserver'
            }));
          }
          
          // === 方案 B：终极降级（SPFXB_Result 也查不到时，直接查原始采购入库表聚合）===
          // 背景：SPFXB_Result 是定时同步的结果表，超过 ~365 天没采购的商品会消失
          // 修复：直接查 vBuySendSumDetail（BillType=34, InKRec='3'），无时间窗口限制
          let _fallbackError = null;  // 必须在 if 外声明，后面要用
          if (records.length === 0) {
            console.log(`⚠️ SPFXB_Result 无数据，终极降级到原始采购表（商品 ${product_code}）`);
            try {
              const normCode = (product_code || '').trim().replace(/^0+/, '');
              const rawReq = pool.request()
                .input("raw", sql.NVarChar, product_code)
                .input("norm", sql.NVarChar, normCode);
              // Step 1: 先查 Vptype 确认商品存在，拿到 rec（SQL 主键）
              // 注意：Vptype 只有 rec + usercode 两列，商品名称等在 SPFXB_Result
              const vptypeQuery = `
                SELECT TOP 1 rec, LTRIM(RTRIM(ISNULL(usercode,''))) as real_code
                FROM ZHYYLS.dbo.Vptype WITH(NOLOCK) 
                WHERE LTRIM(RTRIM(usercode)) = @raw
                   OR LTRIM(RTRIM(usercode)) = @norm
                   OR (LEN(usercode) = LEN(@norm) 
                       AND RIGHT(usercode, LEN(@norm)) = @norm)   -- 处理前导零
                ORDER BY CASE 
                  WHEN LTRIM(RTRIM(usercode)) = @raw THEN 0 
                  WHEN LTRIM(RTRIM(usercode)) = @norm THEN 1 
                  WHEN RIGHT(usercode, LEN(@norm)) = @norm THEN 2 
                  ELSE 3 
                END;
              `;
              const vRes = await rawReq.query(vptypeQuery);
              const vinfo = vRes.recordset?.[0];
              console.log(`[fallback] Vptype lookup for ${product_code}: found=${!!vinfo}, rec=${vinfo?.rec}, code=${vinfo?.real_code}`);
              
              if (vinfo && vinfo.rec) {
                // Step 2: 用 rec 查所有采购入库记录（BillType=34, InKRec='3'）
                const rawReq2 = pool.request()
                  .input("prec", sql.BigInt, vinfo.rec);
                const aggQuery = `
                  SELECT 
                    ISNULL(SUM(ABS(vs.Qty)), 0) as total_purchased,
                    MAX(vs.BillDate) as latest_purchase_date,
                    COUNT(*) as total_rows
                  FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
                  WHERE vs.PRec = @prec AND vs.BillType = 34 AND vs.InKRec = '3';
                `;
                const aggRes = await rawReq2.query(aggQuery);
                const agg = aggRes.recordset?.[0];
                console.log(`[fallback] Purchase agg prec=${vinfo.rec}: qty=${agg?.total_purchased}, date=${agg?.latest_purchase_date}, rows=${agg?.total_rows}`);
                
                if (agg && Number(agg.total_purchased) > 0) {
                  const dcQty = Number(agg.total_purchased) || 0;
                  const lastDate = agg.latest_purchase_date ? new Date(agg.latest_purchase_date).toISOString().slice(0, 10) : '未知';
                  const realCode = vinfo.real_code || product_code;
                  records = [{
                    门店名称: store_name || "仓库库存池（降级查询）",
                    商品编码: realCode,
                    商品名称: vinfo.pname || "商品（原始表降级）",
                    规格: vinfo.pspec || "-",
                    生产企业: vinfo.pfactory || "-",
                    库存数量: 0, 在途数量: 0, 门店库存汇总: 0,
                    配送中心库存数量: dcQty,
                    前30天销售数量: 0, 前90天销售数量: 0, 月均销售数量: 0,
                    标准库存数量: 0, 门店计划: 0, 建议订货数量: 0,
                    _source: 'fallback_raw',
                    _fallback_reason: `商品已从采购库存池消失，但历史总采购 ${dcQty} 件（最近采购：${lastDate}）。允许上报需求，判定侧自动从原始表读取入库数据。`
                  }];
                  console.log(`✅ 终极降级成功：${product_code}→${realCode} 累计采购 ${dcQty}，最近 ${lastDate}`);
                } else {
                  // Step 3: 也没标准采购入库 → 看看这个商品到底有什么类型的流水
                  const diagQuery = `
                    SELECT TOP 10 vs.BillType, vs.InKRec, vs.OutKRec, vs.BillDate, ABS(vs.Qty) as qty
                    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
                    WHERE vs.PRec = @prec
                    ORDER BY vs.BillDate DESC;
                  `;
                  const dReq = pool.request().input("prec", sql.BigInt, vinfo.rec);
                  const diagRes = await dReq.query(diagQuery);
                  const diagRows = diagRes.recordset || [];
                  console.log(`⚠️ 商品 ${product_code} 存在于 Vptype（rec=${vinfo.rec}）但无标准采购入库。最近 10 条流水: ${JSON.stringify(diagRows)}`);
                  // 仍构造一条降级记录，让门店能上报——判定侧的 FIFO 查的也是 BillType=34/InKRec='3'
                  // 如果这个商品真没有任何标准采购入库记录，FIFO 也判不到——但这至少让门店能报上去
                  records = [{
                    门店名称: store_name || "仓库库存池（降级查询）",
                    商品编码: vinfo.real_code || product_code,
                    商品名称: vinfo.pname || "商品（原始表降级）",
                    规格: vinfo.pspec || "-",
                    生产企业: vinfo.pfactory || "-",
                    库存数量: 0, 在途数量: 0, 门店库存汇总: 0,
                    配送中心库存数量: 0,
                    前30天销售数量: 0, 前90天销售数量: 0, 月均销售数量: 0,
                    标准库存数量: 0, 门店计划: 0, 建议订货数量: 0,
                    _source: 'fallback_raw',
                    _fallback_reason: `商品在主表存在（编码 ${vinfo.real_code}），但近 N 年无标准采购入库记录。您仍可提交需求，仓库会人工跟进。`
                  }];
                  console.log(`✅ 终极降级（无标准采购）: ${product_code}→${vinfo.real_code}，允许上报`);
                }
              } else {
                console.log(`❌ Vptype 里也找不到 ${product_code}（norm=${normCode}）——商品主表都不存在`);
              }
            } catch (rawErr) {
              _fallbackError = String(rawErr?.message || rawErr);
              console.error(`❌ 终极降级查询失败：`, rawErr);
            }
          }
          
          if (_fallbackError) {
            result = [{ _debug: true, _fallback_error: _fallbackError, _hint: 'fallback_sql_failed' }];
          } else {
            result = [records];
          }
          console.log(`✅ get_product_detail 从SQL Server返回商品 ${product_code}，共 ${records.length} 条门店记录（降级模式）${_fallbackError ? ' [ERROR: ' + _fallbackError + ']' : ''}`);
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "get_purchase_plan": {
        // 采购计划 - 查 SQL Server Shortage_PurchasePlanCache（含订货状态）
        const { plan_product_code, keyword, status_filter } = params;
        const pool = await getPool();
        let planResult: any = null;
        try {
          if (plan_product_code) {
            // 单商品查询
            const planData = await pool.request()
              .input("关键字", sql.NVarChar, validateInput(plan_product_code, "商品编码", 50))
              .input("状态筛选", sql.NVarChar, null)
              .input("仅缺货", sql.Bit, 1)
              .input("Top", sql.Int, 1)
              .execute("usp_GetPurchasePlanWithFeedback");
            planResult = planData.recordsets;
          } else {
            // 列表查询（支持关键词和状态筛选）
            const planList = await pool.request()
              .input("关键字", sql.NVarChar, validateInput(keyword || "", "关键词", 50) || null)
              .input("状态筛选", sql.NVarChar, validateInput(status_filter || "", "状态筛选", 20) || null)
              .input("仅缺货", sql.Bit, 1)
              .input("Top", sql.Int, 5000)
              .execute("usp_GetPurchasePlanWithFeedback");
            planResult = planList.recordsets;
          }

          // === [v3.20+ 加固] 补货状态从 Supabase reports 汇总，订货数量保留 SQL Server ===
          // TODO: 排查 v368 部署后 503 问题后重新启用 Supabase 查询部分
          // 暂时回退到 Shortage_OrderFeedback 同时覆盖补货状态和订货数量
          if (planResult && planResult[0] && Array.isArray(planResult[0]) && planResult[0].length > 0) {
            const planCodes = planResult[0].map((r: any) => r.商品编码).filter(Boolean);
            if (planCodes.length > 0) {
              const pCodesStr = planCodes.map((c: string) => `'${c.replace(/'/g, "''")}'`).join(",");
              try {
                const fbRes = await pool.request().query(
                  `SELECT 商品编码, ISNULL(实际订货数量, 0) as 实际订货数量, 补货状态 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 IN (${pCodesStr})`
                );
                const statusMap: Record<string, string> = {};
                const qtyMap: Record<string, number> = {};
                (fbRes.recordset || []).forEach((row: any) => {
                  statusMap[row.商品编码] = row.补货状态;
                  qtyMap[row.商品编码] = Number(row.实际订货数量) || 0;
                });
                planResult[0] = planResult[0].map((r: any) => ({
                  ...r,
                  补货状态: statusMap[r.商品编码] || r.补货状态 || '待处理',
                  实际订货数量: qtyMap[r.商品编码] || r.实际订货数量 || 0
                }));
              } catch (_e) {
                // SQL Server 查询失败不阻断
              }
            }
          }

          // 补充供货商信息（Vptype.comment）
          var globalSupplierMap: Record<string, string> = {};
          if (planResult && planResult[0] && Array.isArray(planResult[0]) && planResult[0].length > 0) {
            const codes2 = planResult[0].map((r: any) => r.商品编码).filter(Boolean);
            if (codes2.length > 0) {
              try {
                function normalizeCode(code: string) {
                  return (code || '').trim().toUpperCase().replace(/^0+/, '');
                }
                // 一次性拉取全部有备注的Vptype数据
                const supplierResult = await pool.request()
                  .query(`SELECT LTRIM(RTRIM(ISNULL(usercode, ''))) as 商品编码, LTRIM(RTRIM(ISNULL(comment, ''))) as 供货商 FROM ZHYYLS.dbo.Vptype WHERE comment IS NOT NULL AND comment != ''`);
                if (supplierResult.recordset) {
                  supplierResult.recordset.forEach((row: any) => { 
                    var rawCode = (row.商品编码 || '').trim().toUpperCase();
                    var norm = normalizeCode(rawCode);
                    if (norm && !globalSupplierMap[norm]) {
                      globalSupplierMap[norm] = row.供货商 || '';
                    }
                    if (rawCode && !globalSupplierMap[rawCode]) {
                      globalSupplierMap[rawCode] = row.供货商 || '';
                    }
                  });
                }
                var matchedCount = 0;
                planResult[0] = planResult[0].map((r: any) => {
                  var rawKey = (r.商品编码 || '').trim().toUpperCase();
                  var normKey = normalizeCode(rawKey);
                  var sup = globalSupplierMap[normKey] || globalSupplierMap[rawKey] || '';
                  if (sup) matchedCount++;
                  return { ...r, 供货商: sup };
                });
                console.log(`[供货商] Vptype共 ${Object.keys(globalSupplierMap).length} 家有备注，成功匹配 ${matchedCount}/${planResult[0].length} 条`);
              } catch (e) {
                console.error('获取供货商信息失败:', e);
              }
            }
          }

          // 将供应商映射作为附加数据返回
          result = { 
            plan: planResult,
            supplierLookup: globalSupplierMap
          };
        } finally {
          releasePool(pool);
        }
        break;
      }

      // ========== 订货状态管理 ==========
      case "set_actual_order_qty": {
        // 设置实际订货数量 → 自动改为"已订购"状态
        const { product_code, actual_qty, operator } = params;
        const pool = await getPool();
        try {
          const res = await pool.request()
            .input("商品编码", sql.NVarChar, validateInput(product_code, "商品编码", 50))
            .input("实际订货数量", sql.Int, actual_qty || 0)
            .input("操作人", sql.NVarChar, validateInput(operator || '管理员', "操作人", 50))
            .execute("usp_UpdateActualOrder");
          result = res.recordsets[0];
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "manual_update_status": {
        // 手动修改补货状态（含状态变更日志）
        const { product_code, target_status, operator, remark } = params;
        if (!target_status) {
          return new Response(JSON.stringify({ error: "目标状态不能为空" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const pool = await getPool();
        try {
          const validProductCode = validateInput(product_code, "商品编码", 50);
          const validStatus = validateInput(target_status, "目标状态", 20);
          const validOperator = validateInput(operator || '管理员', "操作人", 50);
          const validRemark = validateInput(remark || `手动改为${validStatus}`, "备注", 200);

          // 先查原状态
          const oldStatusResult = await pool.request()
            .input("商品编码", sql.NVarChar, validProductCode)
            .query(`SELECT 补货状态 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码`);
          const oldStatus = oldStatusResult.recordset && oldStatusResult.recordset[0] ? oldStatusResult.recordset[0].补货状态 : '';

          // 直接使用 SQL 更新/插入
          await pool.request()
            .input("商品编码", sql.NVarChar, validProductCode)
            .input("补货状态", sql.NVarChar, validStatus)
            .input("操作人", sql.NVarChar, validOperator)
            .input("备注", sql.NVarChar, `[状态变更] ${validRemark}`)
            .query(`
              IF EXISTS (SELECT 1 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码)
              BEGIN
              UPDATE dbo.Shortage_OrderFeedback
              SET 补货状态 = @补货状态,
                  操作人 = @操作人,
                  备注 = LEFT(ISNULL(备注, '') + ' | ' + @备注, 200)
              WHERE 商品编码 = @商品编码
            END
              ELSE
              BEGIN
                INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 操作人, 备注)
                VALUES (@商品编码, 0, @补货状态, GETDATE(), @操作人, @备注)
              END
            `);

          // 写入状态变更日志（StatusChangeLog）
          try {
            await pool.request()
              .input("商品编码", sql.NVarChar, validProductCode)
              .input("原状态", sql.NVarChar, oldStatus || null)
              .input("新状态", sql.NVarChar, validStatus)
              .input("操作人", sql.NVarChar, validOperator)
              .input("备注", sql.NVarChar, `[状态变更] ${validRemark}`)
              .query(`
                IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'StatusChangeLog' AND type = 'U')
                INSERT INTO dbo.StatusChangeLog (商品编码, 原状态, 新状态, 操作人, 备注, 变更时间)
                VALUES (@商品编码, @原状态, @新状态, @操作人, @备注, GETDATE())
              `);
          } catch (logErr) {
            console.warn("[manual_update_status] 状态变更日志写入失败（不影响主流程）:", logErr);
          }
          // 同步更新 Supabase reports 表中的状态
          try {
            const now = new Date().toISOString();
            const updatePayload: Record<string, unknown> = {
              replenish_status: validStatus,
              status_remark: '手动',
              status_changed_at: now,
              status_changed_by: validOperator
            };
            if (validStatus === '已完成') {
              updatePayload.settled_at = now; // 手工标记完成也结算
            }
            const { error: supaError } = await supabase
              .from("reports")
              .update(updatePayload)
              .eq("product_code", validProductCode)
              .eq("order_type", "缺货订购");
            if (supaError) {
              result = { success: false, error: `Supabase 同步失败: ${supaError.message}`, supabase_updated: false };
            } else {
              if (validStatus === '已完成') {
                // 手工标记完成：更新完成周期锚点
                try {
                  await supabase.from("product_completion").upsert({
                    product_code: validProductCode,
                    last_completed_at: now,
                    updated_at: now
                  }, { onConflict: 'product_code' });
                } catch (_) { /* 锚点更新失败不阻断 */ }
              }
              result = { success: true, message: '状态更新成功', product_code: validProductCode, status: validStatus, supabase_updated: true };
            }
          } catch (supabaseErr) {
            console.warn("[manual_update_status] Supabase 同步失败:", supabaseErr);
            result = { success: false, error: `Supabase 同步异常: ${String(supabaseErr)}`, supabase_updated: false };
          }
        } catch (sqlErr) {
          console.error("手动更新状态 SQL 错误:", sqlErr);
          throw sqlErr;
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "mark_store_completed": {
        // 按 (商品编码, 门店) 粒度标记单条 report 为"已完成"
        // 由需求明细的"已配送 >= 需求"自动判定触发
        const { items, operator } = params as {
          items?: Array<{ product_code: string; store_id: string; transit: number; demand: number }>;
          operator?: string;
        };
        if (!items || !Array.isArray(items) || items.length === 0) {
          result = { success: false, error: "items 不能为空" };
          break;
        }
        const validOperator = validateInput(operator || '管理员', "操作人", 50);
        const updated: Array<{ product_code: string; store_id: string }> = [];
        const failed: Array<{ product_code: string; store_id: string; error: string }> = [];
        for (const it of items) {
          if (!it || !it.product_code || !it.store_id) continue;
          const pc = validateInput(it.product_code, "商品编码", 50);
          const sid = validateInput(it.store_id, "门店", 50);
          const remark = `自动判定（已配送${Number(it.transit)||0}≥需求${Number(it.demand)||0}）`;
          try {
            // 只更新该 (商品, 门店) 的 report
            const { error } = await supabase
              .from("reports")
              .update({
                replenish_status: '已完成',
                status_remark: remark,
                status_changed_at: new Date().toISOString(),
                status_changed_by: validOperator
              })
              .eq("product_code", pc)
              .eq("store_id", sid)
              .eq("order_type", "缺货订购");
            if (error) {
              failed.push({ product_code: pc, store_id: sid, error: error.message });
            } else {
              updated.push({ product_code: pc, store_id: sid });
            }
          } catch (supaErr) {
            failed.push({ product_code: pc, store_id: sid, error: String(supaErr) });
          }
        }
        result = { success: true, updated, failed, message: `已自动转入已完成：${updated.length} 条${failed.length ? '，失败 ' + failed.length + ' 条' : ''}` };
        break;
      }

      case "batch_update_status": {
        // 批量修改补货状态（含状态变更日志）
        const { product_codes, target_status, operator } = params;
        if (!product_codes || !Array.isArray(product_codes) || product_codes.length === 0) {
          result = { success: false, error: "商品编码不能为空" };
          break;
        }
        if (!target_status) {
          result = { success: false, error: "目标状态不能为空" };
          break;
        }
        const pool = await getPool();
        let success_count = 0;
        let fail_count = 0;
        let errors: string[] = [];
        try {
          const validStatus = validateInput(target_status, "目标状态", 20);
          const validOperator = validateInput(operator || '管理员', "操作人", 50);
          const validRemark = `[批量标记] ${validOperator} 批量改为 ${validStatus}`;

          // 先批量查询原状态
          const statusReq = pool.request();
          const inParams: string[] = [];
          product_codes.forEach((c: any, i: number) => {
            statusReq.input(`p${i}`, sql.NVarChar, validateInput(c, "商品编码", 50));
            inParams.push(`@p${i}`);
          });
          const oldStatusResult = inParams.length > 0
            ? await statusReq.query(`SELECT 商品编码, 补货状态 FROM dbo.Shortage_OrderFeedback WITH (NOLOCK) WHERE 商品编码 IN (${inParams.join(',')})`)
            : { recordset: [] };
          const oldStatusMap: Record<string, string> = {};
          (oldStatusResult.recordset || []).forEach((r: any) => { oldStatusMap[r.商品编码] = r.补货状态 || ''; });

          // 批量更新已有记录
          const updateReq = pool.request();
          updateReq.input("补货状态", sql.NVarChar, validStatus);
          updateReq.input("操作人", sql.NVarChar, validOperator);
          updateReq.input("备注", sql.NVarChar, validRemark);
          const updateIn: string[] = [];
          product_codes.forEach((c: any, i: number) => {
            updateReq.input(`u${i}`, sql.NVarChar, validateInput(c, "商品编码", 50));
            updateIn.push(`@u${i}`);
          });
          if (updateIn.length > 0) {
            await updateReq.query(`
            UPDATE dbo.Shortage_OrderFeedback
            SET 补货状态 = @补货状态,
                操作人 = @操作人,
                备注 = LEFT(ISNULL(备注, '') + ' | ' + @备注, 200)
            WHERE 商品编码 IN (${updateIn.join(',')})
            `);
          }

          // 逐条插入/更新并记录日志（兼容之前无记录的商品）
          for (const code of product_codes) {
            try {
              const validCode = validateInput(code, "商品编码", 50);
              if (!validCode) { fail_count++; continue; }

              // 不存在则插入
              await pool.request()
                .input("商品编码", sql.NVarChar, validCode)
                .input("补货状态", sql.NVarChar, validStatus)
                .input("操作人", sql.NVarChar, validOperator)
                .input("备注", sql.NVarChar, validRemark)
                .query(`
                  IF NOT EXISTS (SELECT 1 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 = @商品编码)
                  BEGIN
                    INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 操作人, 备注)
                    VALUES (@商品编码, 0, @补货状态, GETDATE(), @操作人, @备注)
                  END
                `);

              // 写入状态变更日志
              try {
                const oldStatus = oldStatusMap[validCode] || '';
                await pool.request()
                  .input("商品编码", sql.NVarChar, validCode)
                  .input("原状态", sql.NVarChar, oldStatus || null)
                  .input("新状态", sql.NVarChar, validStatus)
                  .input("操作人", sql.NVarChar, validOperator)
                  .input("备注", sql.NVarChar, validRemark)
                  .query(`
                    IF EXISTS (SELECT 1 FROM sys.objects WHERE name = 'StatusChangeLog' AND type = 'U')
                    INSERT INTO dbo.StatusChangeLog (商品编码, 原状态, 新状态, 操作人, 备注, 变更时间)
                    VALUES (@商品编码, @原状态, @新状态, @操作人, @备注, GETDATE())
                  `);
              } catch (logErr) {
                console.warn("[batch_update_status] 状态变更日志写入失败:", logErr);
              }
              success_count++;
            } catch (e) {
              fail_count++;
              errors.push(String(e));
              console.error("[batch_update_status] 单条处理失败:", e);
            }
          }

          // 同步更新 Supabase reports 表中的状态
          try {
            const now = new Date().toISOString();
            const batchPayload: Record<string, unknown> = {
              replenish_status: validStatus,
              status_remark: '手动',
              status_changed_at: now,
              status_changed_by: validOperator
            };
            if (validStatus === '已完成') {
              batchPayload.settled_at = now;
            }
            await supabase
              .from("reports")
              .update(batchPayload)
              .in("product_code", product_codes);
            // 批量标记完成：更新完成周期锚点
            if (validStatus === '已完成') {
              for (const code of product_codes) {
                try {
                  await supabase.from("product_completion").upsert({
                    product_code: String(code),
                    last_completed_at: now,
                    updated_at: now
                  }, { onConflict: 'product_code' });
                } catch (_) { /* 锚点更新失败不阻断 */ }
              }
            }
          } catch (supabaseErr) {
            console.warn("[batch_update_status] Supabase 同步失败（不影响核心更新）:", supabaseErr);
          }

          result = { success: true, data: { success_count, fail_count, errors: errors.slice(0, 5) } };
        } catch (sqlErr) {
          console.error("批量更新状态 SQL 错误:", sqlErr);
          throw sqlErr;
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "revert_false_completed": {
        // 撤销误判：检查所有"已完成"商品，不满足条件则改回"待处理"
        const pool = await getPool();
        let reverted = 0, kept = 0, errors = 0, checked = 0;
        try {
          // 1. 获取所有已完成/厂家断货商品
          const completedResult = await pool.request().query(`
            SELECT 商品编码, 补货状态, ISNULL(实际订货数量, 0) as 订货数量
            FROM dbo.Shortage_OrderFeedback WITH (NOLOCK)
            WHERE 补货状态 IN ('已完成', '厂家断货')
          `);
          const completedItems = completedResult.recordset || [];
          
          // 2. 从 Supabase 获取各门店需求
          const codes = completedItems.map((r: any) => r.商品编码).filter(Boolean);
          let demandMap: Record<string, Array<{ store: string; demand: number }>> = {};
          if (codes.length > 0) {
            const { data: reportData } = await supabase
              .from('reports')
              .select('product_code, store_name, demand_quantity')
              .eq('order_type', '缺货订购')
              .in('product_code', codes);
            (reportData || []).forEach((r: any) => {
              if (!r.product_code || !r.store_name) return;
              if (!demandMap[r.product_code]) demandMap[r.product_code] = [];
              const exists = demandMap[r.product_code].find(s => s.store === r.store_name);
              if (!exists) demandMap[r.product_code].push({ store: r.store_name, demand: r.demand_quantity || 0 });
            });
          }
          
          // 3. 逐个判定
          for (const item of completedItems) {
            checked++;
            const code = item.商品编码;
            const totalQty = item.订货数量 || 0;
            const stores = demandMap[code] || [];
            let shouldRevert = false;
            let reason = '';
            
            if (totalQty <= 0) {
              shouldRevert = true;
              reason = '实际订货数量为0';
            } else {
              // 查仓库库存
              let whStock = 0;
              try {
                const whR = await pool.request()
                  .input('code', sql.NVarChar, code)
                  .query(`
                    SELECT ISNULL(SUM(gs.qty), 0) as qty
                    FROM ZHYYLS.dbo.Vptype v WITH (NOLOCK)
                    JOIN ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK) ON gs.prec = v.rec
                    WHERE v.usercode = @code AND gs.krec = '3'
                  `);
                whStock = (whR.recordset?.[0] as any)?.qty || 0;
              } catch (e) {}
              
              if (whStock > totalQty) {
                kept++;
                continue; // 仓库满足，不撤销
              }
              
              // 查门店库存/在途
              let allStoresSatisfied = true;
              if (stores.length === 0) {
                allStoresSatisfied = false; // 没有门店上报数据，无法判定，撤销
              } else {
                for (const s of stores) {
                  const krec = STORE_KREC_MAP[s.store] || '';
                  if (!krec) { allStoresSatisfied = false; break; }
                  let storeStock = 0, transit = 0;
                  try {
                    const stockR = await pool.request()
                      .input('code', sql.NVarChar, code)
                      .input('krec', sql.NVarChar, krec)
                      .query(`
                        SELECT ISNULL(SUM(gs.qty), 0) as qty
                        FROM ZHYYLS.dbo.Vptype v WITH (NOLOCK)
                        JOIN ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK) ON gs.prec = v.rec
                        WHERE v.usercode = @code AND gs.krec = @krec
                      `);
                    storeStock = (stockR.recordset?.[0] as any)?.qty || 0;
                  } catch (e) {}
                  
                  // 简化在途检查：用 Gp_SendDoing 一次性结果（此处为性能简化为仅检查库存）
                  // 实际应查在途，但在 Edge Function 中容易超时，暂以库存为准
                  if (!(s.demand > 0 && storeStock > s.demand)) {
                    allStoresSatisfied = false;
                    break;
                  }
                }
              }
              
              if (!allStoresSatisfied) {
                shouldRevert = true;
                reason = '仓库和门店库存均不满足';
              } else {
                kept++;
                continue;
              }
            }
            
            if (shouldRevert) {
              try {
                await pool.request()
                  .input('code', sql.NVarChar, code)
                  .input('reason', sql.NVarChar, reason)
                  .query(`
                    UPDATE dbo.Shortage_OrderFeedback
                    SET 补货状态 = '待处理',
                        备注 = ISNULL(备注, '') + ' | 撤销误判：' + @reason + ' ' + CONVERT(VARCHAR, GETDATE(), 120)
                    WHERE 商品编码 = @code
                  `);
                
                // 同步回 Supabase reports
                await supabase.from('reports').update({ replenish_status: '待处理' }).eq('product_code', code);
                reverted++;
              } catch (e) {
                errors++;
                console.error(`[revert_false_completed] ${code} 失败:`, e);
              }
            }
          }
          
          result = { success: true, checked, reverted, kept, errors };
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "fix_zero_order_qty": {
        // 修复 Shortage_OrderFeedback 中实际订货数量为 0 的记录：从 Reports 取总需求
        const pool = await getPool();
        let fixed = 0, skipped = 0, errors = 0;
        try {
          // 1. 获取所有实际订货数量为 0 的商品编码
          const zeroResult = await pool.request().query(`
            SELECT 商品编码 FROM dbo.Shortage_OrderFeedback WITH (NOLOCK)
            WHERE ISNULL(实际订货数量, 0) = 0
          `);
          const zeroCodes = (zeroResult.recordset || []).map((r: any) => r.商品编码).filter(Boolean);
          
          if (zeroCodes.length === 0) {
            result = { success: true, fixed: 0, skipped: 0, errors: 0, message: '没有需要修复的记录' };
            break;
          }
          
          // 2. 从 Supabase reports 获取总需求（缺货订购类型）
          const { data: reportData, error: reportErr } = await supabase
            .from('reports')
            .select('product_code, demand_quantity')
            .eq('order_type', '缺货订购')
            .in('product_code', zeroCodes);
          
          if (reportErr) throw new Error(`读取reports失败: ${reportErr.message}`);
          
          const demandMap: Record<string, number> = {};
          (reportData || []).forEach((r: any) => {
            if (!r.product_code) return;
            demandMap[r.product_code] = (demandMap[r.product_code] || 0) + (r.demand_quantity || 0);
          });
          
          // 3. 逐条更新
          for (const code of zeroCodes) {
            const demand = demandMap[code] || 0;
            if (demand <= 0) { skipped++; continue; }
            try {
              await pool.request()
                .input('code', sql.NVarChar, code)
                .input('qty', sql.Int, demand)
                .query(`
                  UPDATE dbo.Shortage_OrderFeedback
                  SET 实际订货数量 = @qty, 备注 = ISNULL(备注, '') + ' | 修复订货数量=' + CAST(@qty AS VARCHAR) + ' ' + CONVERT(VARCHAR, GETDATE(), 120)
                  WHERE 商品编码 = @code AND ISNULL(实际订货数量, 0) = 0
                `);
              fixed++;
            } catch (e) {
              errors++;
              console.error(`[fix_zero_order_qty] ${code} 失败:`, e);
            }
          }
          
          result = { success: true, fixed, skipped, errors, total: zeroCodes.length };
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "rebuild_feedback_from_supabase": {
        // 从 Supabase reports 表重建 Shortage_OrderFeedback 数据（批量版）
        console.log('[rebuild] 开始从 Supabase 重建 Feedback 数据...');
        
        const { data: allReports, error: readErr } = await supabase
          .from("reports")
          .select("product_code, replenish_status, created_at")
          .order("created_at", { ascending: false });
        
        if (readErr) {
          result = { success: false, error: `读取reports失败: ${readErr.message}` };
          break;
        }
        if (!allReports || allReports.length === 0) {
          result = { success: false, error: 'reports 表没有数据' };
          break;
        }
        
        // 按商品编码分组，取最新状态
        const productMap: Record<string, string> = {};
        for (const r of allReports) {
          if (!r.product_code) continue;
          const code = r.product_code.trim();
          if (!productMap[code]) {
            productMap[code] = r.replenish_status || '待处理';
          }
        }
        
        const codes = Object.keys(productMap);
        console.log(`[rebuild] 共 ${codes.length} 个唯一商品`);
        
        const pool = await getPool();
        let inserted = 0, skipped = 0, errors = 0;
        
        try {
          // 获取已存在的商品编码
          const existResult = await pool.request().query(`
            SELECT 商品编码 FROM dbo.Shortage_OrderFeedback WITH (NOLOCK)
          `);
          const existingSet = new Set((existResult.recordset || []).map((r: any) => r.商品编码));
          
          // 只插入不存在的
          const toInsert = codes.filter(c => !existingSet.has(c));
          skipped = codes.length - toInsert.length;
          
          if (toInsert.length === 0) {
            console.log(`[rebuild] 所有商品已存在，无需插入`);
            result = { success: true, inserted: 0, skipped, errors: 0, total: codes.length };
            break;
          }
          
          // 批量构建 INSERT VALUES
          const batchSize = 100;
          for (let i = 0; i < toInsert.length; i += batchSize) {
            const batch = toInsert.slice(i, i + batchSize);
            const req = pool.request();
            const vals: string[] = [];
            batch.forEach((code, j) => {
              const status = productMap[code];
              const idx = i + j;
              vals.push(`(@c${idx}, @s${idx})`);
              req.input(`c${idx}`, sql.NVarChar, code);
              req.input(`s${idx}`, sql.NVarChar(20), status);
            });
            try {
              await req.query(`
                INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 备注)
                VALUES ${vals.join(', ')}
              `);
              // 实际 INSERT 是 VALUES (@c0, @s0), (@c1, @s1), ... 但 mssql 参数化 INSERT 的 VALUES 列表需要特殊处理
              // mssql 库对多行 VALUES 支持有限，改为多条 INSERT
            } catch (_batchErr) {
              // 降级：逐条插入
              for (const code of batch) {
                try {
                  await pool.request()
                    .input("code", sql.NVarChar, code)
                    .input("status", sql.NVarChar(20), productMap[code])
                    .query(`
                      INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 备注)
                      VALUES (@code, 0, @status, GETDATE(), '从Supabase重建')
                    `);
                  inserted++;
                } catch (_e) { errors++; }
              }
              continue;
            }
            inserted += batch.length;
            console.log(`[rebuild] 已插入 ${inserted}/${toInsert.length}`);
          }
        } finally {
          releasePool(pool);
        }
        
        console.log(`[rebuild] 完成: 新增${inserted}条, 跳过${skipped}条, 失败${errors}条`);
        result = { success: true, inserted, skipped, errors, total: codes.length };
        break;
      }

      case "auto_detect_status": {
        // v5.1: 禁用全局汇总的自动检测（会误将采购中的订单标记为已完成）
        // 自动检测所有补货状态变化（已禁用）
        result = { message: "auto_detect_status 已禁用", reason: "全局汇总检测会将采购中的订单误标记为已完成，请手动修改状态" };
        /*
        const pool = await getPool();
        try {
          const res = await pool.request()
            .execute("usp_AutoDetectOrderStatus_Feedback");
          result = res.recordsets[0];
        } finally {
          releasePool(pool);
        }
        */
        try { await supabase.from("sync_log_table").insert([{ 
          sync_time: new Date().toISOString(), 
          sync_type: "status_detect", 
          status: "success", 
          detail: "自动状态检测完成" 
        }]); } catch(_e) {}
        break;
      }

      case "recheck_auto_completed": {
        // 用新逐笔逻辑重新核查：只看 created_at >= 2026-10-01 且 status_changed_by='系统自动' 的已完成 report
        // 新逻辑判定不满足的 → 回退为待处理
        const pool = await getPool();
        try {
          // 1. 查出需要核查的已完成 report（10月后 + 系统自动标记）
          const { data: autoDone, error: q1err } = await supabase
            .from("reports")
            .select("id, product_code, demand_quantity, created_at, replenish_status, status_remark")
            .eq("order_type", "缺货订购")
            .eq("replenish_status", "已完成")
            .eq("status_changed_by", "系统自动")
            .gte("created_at", "2026-10-01")
            .order("created_at", { ascending: true });

          if (q1err) { result = { success: false, error: String(q1err) }; break; }
          const toRecheck = autoDone || [];
          const targetCodes = [...new Set(toRecheck.map(r => r.product_code).filter(Boolean))];
          result = { success: true, target_count: toRecheck.length, codes: targetCodes.length, details: [] };
          if (targetCodes.length === 0) break;

          // 2. 批量查这些商品的采购入库明细
          const purchaseMap: Record<string, { date: string; qty: number; remaining: number }[]> = {};
          const BATCH = 5;
          for (let i = 0; i < targetCodes.length; i += BATCH) {
            const batch = targetCodes.slice(i, i + BATCH);
            await Promise.all(batch.map(async (code) => {
              try {
                const details = await queryPurchaseDetails(pool, code);
                purchaseMap[code] = details.map(d => ({ ...d, remaining: d.qty }));
              } catch (_) {
                purchaseMap[code] = [];
              }
            }));
          }

          // 3. 对每个涉及商品，查出该商品所有活跃 report
          const { data: allActive, error: q2err } = await supabase
            .from("reports")
            .select("id, product_code, demand_quantity, created_at, replenish_status, status_remark")
            .eq("order_type", "缺货订购")
            .in("product_code", targetCodes)
            .in("replenish_status", ["已完成", "待处理", "已订购", "待付款"])
            .order("created_at", { ascending: true });

          if (q2err) { result = { success: false, error: String(q2err) }; break; }

          // 4. 按商品分组 + created_at 升序（逐笔消耗）
          const itemsByCode: Record<string, any[]> = {};
          for (const r of (allActive || [])) {
            const code = r.product_code;
            if (!itemsByCode[code]) itemsByCode[code] = [];
            itemsByCode[code].push(r);
          }

          // 5. 逐笔判定：新逐笔逻辑满足的保持已完成，不满足的改回待处理
          const now = new Date().toISOString();
          const toRevert: string[] = [];
          const toKeep: string[] = [];
          for (const code of targetCodes) {
            const purchasePool = purchaseMap[code] || [];
            const reports = itemsByCode[code] || [];
            for (const report of reports) {
              const anchorDate = toBjDate(report.created_at);
              const shortage = Number(report.demand_quantity) || 0;
              if (shortage <= 0) continue;

              let consumed = 0;
              for (const entry of purchasePool) {
                if (entry.date <= anchorDate) continue;
                if (entry.remaining <= 0) continue;
                const take = Math.min(entry.remaining, shortage - consumed);
                entry.remaining -= take;
                consumed += take;
                if (consumed >= shortage) break;
              }

              const isSatisfied = consumed >= shortage;
              if (report.replenish_status === '已完成') {
                if (isSatisfied) {
                  toKeep.push(report.id);
                } else {
                  toRevert.push(report.id);
                }
              }
            }
          }

          // 6. 执行回退
          if (toRevert.length > 0) {
            const BATCH_SIZE = 100;
            let reverted = 0;
            for (let i = 0; i < toRevert.length; i += BATCH_SIZE) {
              const batch = toRevert.slice(i, i + BATCH_SIZE);
              const { error: uerr } = await supabase
                .from("reports")
                .update({
                  replenish_status: '待处理',
                  status_remark: '旧版本误判回退',
                  status_changed_at: now,
                  status_changed_by: '系统自动'
                })
                .in("id", batch);
              if (!uerr) reverted += batch.length;
            }
            result.reverted = reverted;
          }
          result.kept = toKeep.length;
          result.details = [
            `核查目标: ${toRecheck.length} 条已完成 report`,
            `涉及商品: ${targetCodes.length} 个`,
            `新逻辑保持: ${toKeep.length} 条`,
            `新逻辑回退: ${toRevert.length} 条 → 待处理`
          ];
        } catch (e: any) {
          result = { success: false, error: String(e), detail: e?.message };
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "sync_with_auto_status": {
        // 一键：只跑 FIFO 自动判定，不再刷商品缓存
        // 商品缓存刷新改由 scheduled-task 每天 00:30 定时执行（usp_Sync_ProductCache_RQZT）
        const pool = await getPool();
        try {
          let autoDetectCount = 0;
          let completedPairCount = 0;
          let autoDetectDetails: string[] = [];
          try {
            const detectR = await preciseAutoDetectStatusV2(pool, supabase);
            autoDetectCount = detectR.detected || 0;
            completedPairCount = detectR.completedCount || 0;
            autoDetectDetails = detectR.details || [];
            console.log(`[sync_with_auto_status] 完成判定: ${completedPairCount} 个商品`);
            for (const d of autoDetectDetails) {
              console.log(`  → ${d}`);
            }
          } catch (detectErr) {
            console.error('[sync_with_auto_status] 完成判定失败:', detectErr);
            autoDetectDetails = [String(detectErr)];
          }

          result = { success: true, message: `完成判定：${completedPairCount} 个商品已自动完成（配送口径升级改由「配送待办」按钮单独触发）`, synced_products: 0, auto_detected: autoDetectCount, detect_details: autoDetectDetails };

          // ★ 已移除自调用 upgrade_to_delivered：一键同步只做入库判定，
          // 配送口径升级（已完成→已配送）改由用户点「配送待办」按钮单独触发，
          // 避免两次重活叠加导致 WORKER_LIMIT 超限（1078 条全量拉 + 每批 400 建临时表）
          // 之前的设计：sync_with_auto_status → 自调用 upgrade_to_delivered（同步阻塞）
        } catch (e1) {
          throw e1;
        }
        releasePool(pool);
        break;
      }

      // ========== 单商品立即判定（行级按钮触发）==========
      // 只对指定商品跑 FIFO 判定，满足的改成已完成并写元数据
      case "check_single_product": {
        const { product_code, operator } = params;
        if (!product_code) {
          return new Response(JSON.stringify({ success: false, error: "product_code 必填" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const pool = await getPool();
        const now = new Date().toISOString();
        const details: string[] = [];
        try {
          // ① 拉该商品所有非终态 pending reports
          const { data: items, error: qErr } = await supabase
            .from("reports")
            .select("id, product_code, demand_quantity, created_at, replenish_status")
            .eq("product_code", product_code)
            .eq("order_type", "缺货订购")
            .gt("demand_quantity", 0)
            .neq("replenish_status", "已完成")
            .neq("replenish_status", "厂家断货")
            .neq("replenish_status", "已关闭")
            .neq("replenish_status", "已配送")
            .order("created_at", { ascending: true });
          if (qErr) throw qErr;
          if (!items || items.length === 0) {
            result = { success: true, checked: 0, completed: 0, skipped: '无待处理上报', details };
            break;
          }
          details.push(`待判定: ${items.length} 条 report`);

          // ② 查该商品采购入库（和 preciseAutoDetectStatusV2 完全一致的 SQL）
          const req = pool.request();
          req.input("code", sql.NVarChar(50), product_code);
          const pRes = await req.query(`
            SELECT vs.BillDate, ABS(vs.Qty) as qty
            FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
            JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
            WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3'
          `);
          const purchaseRows = (pRes.recordset || []).map((r: any) => ({ date: r.BillDate, qty: Number(r.qty || 0) }));
          details.push(`采购入库: ${purchaseRows.length} 条`);

          // ③ FIFO 判定（直接调用共享 runFIFO，和 preciseAutoDetectStatusV2 / scheduled-task 完全一致）
          const purchaseByCode = { [product_code]: purchaseRows };
          const fifoRes = runFIFO(
            items.map((r: any) => ({ id: r.id, product_code: r.product_code, demand_quantity: Number(r.demand_quantity) || 0, created_at: r.created_at })),
            purchaseByCode
          ); // 默认 sameDayCounts=true（2026-11-08 放开锚点）
          const toCompleteIds = fifoRes.toCompleteIds;
          details.push(...fifoRes.details);

          // ④ 按 remark 分组批量 UPDATE（不同 report 可能含/不含"当天入库"）
          let completed = 0;
          if (toCompleteIds.length > 0) {
            const remarkMap = fifoRes.remarkMap;
            const idsByRemark: Record<string, string[]> = {};
            for (const id of toCompleteIds) {
              const base = remarkMap[id] || '自动判定：仓库采购入库满足（FIFO 先上报先满足）';
              // 行级判定：额外加上"行级立即判定"后缀，和定时/一键同步区分
              const rm = base.includes('含当天入库')
                ? base.replace('先上报先满足）', '先上报先满足，行级立即判定）')
                : base.replace('先上报先满足）', '先上报先满足，行级立即判定）');
              if (!idsByRemark[rm]) idsByRemark[rm] = [];
              idsByRemark[rm].push(id);
            }
            for (const [remark, ids] of Object.entries(idsByRemark)) {
              const { error: updErr } = await supabase.from("reports").update({
                replenish_status: '已完成',
                status_remark: remark,
                status_changed_at: now,
                status_changed_by: operator || '系统自动',
                settled_at: now
              }).in("id", ids).neq("replenish_status", "已完成").neq("replenish_status", "已配送");
              if (updErr) throw updErr;
              completed += ids.length;
            }
            // 更新 product_completion
            try { await supabase.from("product_completion").upsert({ product_code, last_completed_at: now, updated_at: now, fail_count: 0 }, { onConflict: 'product_code' }); } catch (_) {}
            try { await supabase.from("store_notifications").update({ notified_at: null }).eq("product_code", product_code); } catch (_) {}
          }
          details.push(`判定完成: ${completed}/${items.length} 条 → 已完成，剩余 ${items.length - completed} 条`);

          result = { success: true, checked: items.length, completed, remaining: items.length - completed, details, product_code };
        } catch (e: any) {
          console.error(`[check_single_product] ${product_code} 判定失败:`, e);
          result = { success: false, error: e?.message || String(e), product_code };
        } finally {
          releasePool(pool);
        }
        break;
      }

      // ========== v2 到货通知刷新（独立按钮触发） ==========
      case "notify_refresh": {
        // 条件：未完成上报 + 仓库有库存 + 门店库存<需求；notified_at 本周期去重
        const pool = await getPool();
        let notified = 0;
        let skipped = 0;
        try {
          const { data: activeReports } = await supabase
            .from("reports")
            .select("product_code, store_id, store_name, demand_quantity, replenish_status")
            .eq("order_type", "缺货订购")
            .not("replenish_status", "in", "(已完成,已配送,厂家断货,已关闭)")
            .not("product_code", "is", null);

          if (!activeReports || activeReports.length === 0) {
            result = { success: true, notified: 0, skipped: 0 };
            break;
          }

          const demandMap: Record<string, number> = {};
          const keyInfo: Record<string, { product_code: string; store_id: string; store_name: string }> = {};
          for (const r of activeReports) {
            const key = r.product_code + '||' + r.store_id;
            demandMap[key] = (demandMap[key] || 0) + (Number(r.demand_quantity) || 0);
            keyInfo[key] = { product_code: r.product_code, store_id: r.store_id, store_name: r.store_name };
          }

          const codes = [...new Set(activeReports.map((r: any) => r.product_code).filter(Boolean))];
          const { whStock, storeStock, transit } = await queryInventoryMaps(pool, codes);

          const now = new Date().toISOString();
          for (const key of Object.keys(keyInfo)) {
            const info = keyInfo[key];
            const demand = demandMap[key] || 0;
            const wh = whStock[info.product_code] || 0;
            const st = storeStock[key] || 0;
            const tr = transit[key] || 0;
            if (wh <= 0) continue;
            if (st + tr >= demand) continue;
            const { data: existNotif } = await supabase
              .from("store_notifications")
              .select("id, notified_at")
              .eq("store_id", info.store_id)
              .eq("product_code", info.product_code)
              .maybeSingle();
            if (existNotif && existNotif.notified_at) { skipped++; continue; }
            const { error: nErr } = await supabase.from("store_notifications").upsert({
              store_id: info.store_id,
              product_code: info.product_code,
              message: `${info.product_code} 商品已到仓，仓库有货可领取（本店缺货${demand}件）`,
              created_at: now,
              is_read: false,
              notified_at: now
            }, { onConflict: 'store_id,product_code' });
            if (!nErr) notified++;
          }
          result = { success: true, notified, skipped };
        } catch (e) {
          console.error('[notify_refresh] 失败:', e);
          result = { success: false, error: String(e) };
        } finally {
          releasePool(pool);
        }
        break;
      }

      // ========== v2 配送待办列表（后台人工跟进配送） ==========
      case "get_delivery_todo": {
        // 条件：已完成 + 仓库有库存 + 门店库存<需求
        const pool = await getPool();
        try {
          const { data: completedReports } = await supabase
            .from("reports")
            .select("product_code, store_id, store_name, demand_quantity, product_name, specification, manufacturer, created_at")
            .eq("order_type", "缺货订购")
            .eq("replenish_status", "已完成")
            .not("product_code", "is", null);

          if (!completedReports || completedReports.length === 0) {
            result = { success: true, todo: [] };
            break;
          }

          const demandMap: Record<string, number> = {};
          const keyInfo: Record<string, { product_code: string; store_id: string; store_name: string; product_name: string; product_spec: string; manufacturer: string; since: string }> = {};
          for (const r of completedReports) {
            const key = r.product_code + '||' + r.store_id;
            demandMap[key] = (demandMap[key] || 0) + (Number(r.demand_quantity) || 0);
            const curSince = toBjDate(r.created_at);
            if (!keyInfo[key]) {
              keyInfo[key] = { product_code: r.product_code, store_id: r.store_id, store_name: r.store_name, product_name: r.product_name || '', product_spec: r.specification || '', manufacturer: r.manufacturer || '', since: curSince || '2020-01-01' };
            } else if (curSince && curSince < keyInfo[key].since) {
              keyInfo[key].since = curSince;
            }
          }

          const codes = [...new Set(completedReports.map((r: any) => r.product_code).filter(Boolean))];
          const { whStock, storeStock, transit } = await queryInventoryMaps(pool, codes);

          const todo: Array<{ product_code: string; store_id: string; store_name: string; product_name: string; product_spec: string; manufacturer: string; demand: number; wh_stock: number; store_stock: number; transit: number }> = [];
          for (const key of Object.keys(keyInfo)) {
            const info = keyInfo[key];
            const demand = demandMap[key] || 0;
            const wh = whStock[info.product_code] || 0;
            const st = storeStock[key] || 0;
            const tr = transit[key] || 0;
            if (wh > 0 && (st + tr) < demand) {
              todo.push({ product_code: info.product_code, store_id: info.store_id, store_name: info.store_name, product_name: info.product_name, product_spec: info.product_spec, manufacturer: info.manufacturer, demand, wh_stock: wh, store_stock: st, transit: tr });
            }
          }
          result = { success: true, todo };
        } catch (e) {
          console.error('[get_delivery_todo] 失败:', e);
          result = { success: false, error: String(e) };
        } finally {
          releasePool(pool);
        }
        break;
      }

      // ========== 第二阶段：应用 SP 结果到 Supabase（批量更新 + 通知）==========
      case "apply_status_sync": {
        // 将 SP 阶段判定的完成/到货对批量同步到 Supabase reports + 通知
        const { completed_pairs, arrived_pairs } = params as {
          completed_pairs: Array<{ product_code: string; store_name: string; status: string }>;
          arrived_pairs: Array<{ product_code: string; store_name: string; status: string }>;
        };
        let updatedCount = 0;
        let notifCount = 0;
        const storeNameToId: Record<string, string> = {
          '02第二药店': 'wszhyy02', '03第三药店': 'wszhyy03', '04第四药店': 'wszhyy04',
          '06常口店': 'wszhyy06', '08第八药店': 'wszhyy08', '09第九药店': 'wszhyy09',
          '14第十四药店': 'wszhyy14', '16凤凰山药店': 'wszhyy16', '17益丰店': 'wszhyy17', '21富源店': 'wszhyy21',
        };

        // ① 批量更新 Supabase reports（不覆盖已手工标记的已完成/厂家断货）
        if (completed_pairs && completed_pairs.length > 0) {
          const BATCH = 20; // 每次并发 20 条
          for (let i = 0; i < completed_pairs.length; i += BATCH) {
            const batch = completed_pairs.slice(i, i + BATCH);
            const upserts = batch.map(pair => {
              const sid = storeNameToId[pair.store_name];
              if (!sid) return Promise.resolve(0);
              return supabase.from("reports").update({
                replenish_status: pair.status,
                status_remark: '自动',
                status_changed_at: new Date().toISOString(),
                status_changed_by: '系统自动'
              })
                .eq("product_code", pair.product_code)
                .eq("store_id", sid)
                .eq("order_type", "缺货订购")
                .neq("replenish_status", "已完成")
                .neq("replenish_status", "厂家断货")
                .then(r => r.error ? 0 : 1)
                .catch(() => 0);
            });
            const results = await Promise.all(upserts);
            updatedCount += results.reduce((a: number, b: number) => a + b, 0);
          }
        }

        // ② 给"已到货"的门店发送通知（含需求量、已配送量、建议要货数量）
        const notifPairs = arrived_pairs || [];
        if (notifPairs.length > 0) {
          const BATCH = 20;
          let transitPool: any = null;
          try {
            transitPool = await getPool();
            for (let i = 0; i < notifPairs.length; i += BATCH) {
              const batch = notifPairs.slice(i, i + BATCH);
              // 查询需求信息
              const notifDemandMap: Record<string, Record<string, number>> = {};
              const notifTransitMap: Record<string, Record<string, number>> = {};
              const batchCodes = [...new Set(batch.map((p: any) => p.product_code))];
              if (batchCodes.length > 0) {
                const { data: demandData } = await supabase
                  .from("reports")
                  .select("product_code, store_id, demand_quantity")
                  .eq("order_type", "缺货订购")
                  .in("product_code", batchCodes);
                if (demandData) {
                  for (const d of demandData) {
                    if (!notifDemandMap[d.product_code]) notifDemandMap[d.product_code] = {};
                    notifDemandMap[d.product_code][d.store_id] = (notifDemandMap[d.product_code][d.store_id] || 0) + (d.demand_quantity || 0);
                  }
                }
              }
              // 查询 SQL Server 配送量（单次批量查询）
              try {
                const transitPairs = batch.map((p: any) => ({
                  product_code: p.product_code, store_name: p.store_name,
                  krec: STORE_KREC_MAP[p.store_name] || ''
                })).filter((t: any) => t.krec);
                if (transitPairs.length > 0) {
                  const codesForTransit = [...new Set(transitPairs.map((t: any) => t.product_code))];
                  const krecs = [...new Set(transitPairs.map((t: any) => t.krec))];
                  const codeParams: Record<string, any> = {};
                  const codePlaceholders = codesForTransit.map((c: string, idx: number) => {
                    const p = `c${idx}`;
                    codeParams[p] = c;
                    return `@${p}`;
                  }).join(',');
                  const precMap: Record<string, string> = {};
                  if (codePlaceholders) {
                    const vpReq = transitPool.request();
                    Object.entries(codeParams).forEach(([k, v]) => vpReq.input(k, sql.NVarChar(50), v));
                    const vpRes = await vpReq.query(`
                      SELECT usercode, rec FROM ZHYYLS.dbo.Vptype WITH(NOLOCK)
                      WHERE usercode IN (${codePlaceholders})
                    `);
                    (vpRes.recordset || []).forEach((r: any) => { precMap[r.usercode] = r.rec; });
                  }
                  const recs = Object.values(precMap).filter(Boolean);
                  if (recs.length > 0 && krecs.length > 0) {
                    const transitReq = transitPool.request();
                    const recPlaceholders = recs.map((r: string, idx: number) => {
                      const p = `r${idx}`;
                      transitReq.input(p, sql.NVarChar, r);
                      return `@${p}`;
                    }).join(',');
                    const krecPlaceholders = krecs.map((k: string, idx: number) => {
                      const p = `k${idx}`;
                      transitReq.input(p, sql.NVarChar(5), k);
                      return `@${p}`;
                    }).join(',');
                    const tRes = await transitReq.query(`
                      SELECT vs.PRec as prec, vs.InKRec as krec, ISNULL(SUM(ABS(vs.Qty)), 0) as transit_qty
                      FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
                      WHERE vs.OutKRec = '3'
                        AND vs.PRec IN (${recPlaceholders})
                        AND vs.InKRec IN (${krecPlaceholders})
                        AND (vs.Comment IS NULL OR vs.Comment NOT LIKE '%调货出库单%')
                      GROUP BY vs.PRec, vs.InKRec
                    `);
                    const precToCode: Record<string, string> = {};
                    Object.entries(precMap).forEach(([code, rec]) => { precToCode[rec] = code; });
                    const krecToStore: Record<string, string> = {};
                    transitPairs.forEach((tp: any) => { krecToStore[tp.krec] = tp.store_name; });
                    (tRes.recordset || []).forEach((r: any) => {
                      const code = precToCode[r.prec];
                      const storeName = krecToStore[r.krec];
                      if (code && storeName) {
                        if (!notifTransitMap[code]) notifTransitMap[code] = {};
                        notifTransitMap[code][storeName] = Number(r.transit_qty);
                      }
                    });
                  }
                }
              } catch (_) { /* 配送量查询失败不阻断 */ }
              const upserts = batch.map(p => {
                const sid = storeNameToId[p.store_name];
                if (!sid) return Promise.resolve(0);
                const demand = notifDemandMap[p.product_code]?.[sid] || 0;
                const transit = notifTransitMap[p.product_code]?.[p.store_name] || 0;
                const suggest = Math.max(0, demand - transit);
                let msg: string;
                if (demand > 0) {
                  if (transit > 0) {
                    msg = `${p.product_code} 仓库有货可配送（需求${demand}，已配${transit}，建议再要${suggest}）`;
                  } else {
                    msg = `${p.product_code} 仓库有货可配送（本店需求${demand}）`;
                  }
                } else {
                  msg = `${p.product_code} 已到货（仓库可配送）`;
                }
                return supabase.from("store_notifications").upsert({
                  store_id: sid,
                  product_code: p.product_code,
                  message: msg,
                  created_at: new Date().toISOString(),
                  is_read: false
                }, { onConflict: 'store_id,product_code' })
                  .then(r => r.error ? 0 : 1)
                  .catch(() => 0);
              });
              const results = await Promise.all(upserts);
              notifCount += results.reduce((a: number, b: number) => a + b, 0);
            }
          } finally {
            if (transitPool) releasePool(transitPool);
          }
        }

        console.log(`[apply_status_sync] 更新 ${updatedCount} 条 reports, 发送 ${notifCount} 条通知`);
        result = { success: true, updated: updatedCount, notified: notifCount };
        break;
      }

      case "second_check": {
        // 二次校验：检查所有"已到货（自动）"商品，库存=0 的回退
        const pool = await getPool();
        try {
          await runSecondCheck(pool, supabase);
          result = { success: true, second_check: 'done' };
        } catch (e) {
          console.error("[second_check] 失败:", e);
          result = { success: false, error: String(e) };
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "get_status_change_log": {
        // 查询状态变更日志（从 StatusChangeLog 表读取）
        const { log_product_code, top } = params;
        const pool = await getPool();
        try {
          const logs = await pool.request()
            .input("商品编码", sql.NVarChar, validateInput(log_product_code || "", "商品编码", 50) || null)
            .input("Top", sql.Int, Math.min(top || 100, 500))
            .query(`
              SELECT TOP (@Top) 商品编码, 原状态, 新状态, 操作人, 备注, 变更时间
              FROM dbo.StatusChangeLog
              WHERE (@商品编码 IS NULL OR 商品编码 = @商品编码)
              ORDER BY 变更时间 DESC
            `);
          result = logs.recordset;
        } catch (e) {
          console.error("查询状态变更日志失败:", e);
          result = [];
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "backfill_status_time": {
        // 从 RQZT StatusChangeLog 回填 Supabase reports 的 status_changed_at
        try {
          const { data: needBackfill } = await supabase
            .from("reports")
            .select("product_code, store_id, replenish_status, status_remark")
            .in("replenish_status", ["已完成", "厂家断货", "已到货", "已配送"])
            .neq("status_remark", "手动")
            .eq("order_type", "缺货订购")
            .limit(1000);

          if (!needBackfill || needBackfill.length === 0) {
            result = { backfilled: 0, message: "无待回填记录" };
            break;
          }

          const pool = await getPool();
          let backfilled = 0, autoCount = 0, manualCount = 0;
          try {
            for (const r of needBackfill) {
              try {
                // 查 RQZT StatusChangeLog 最新变更记录
                const logRes = await pool.request()
                  .input("code", sql.NVarChar(50), r.product_code)
                  .query(`
                    SELECT TOP 1 变更时间, 备注, 操作人
                    FROM dbo.StatusChangeLog
                    WHERE 商品编码 = @code AND 新状态 IN ('已完成', '厂家断货', '已到货')
                    ORDER BY 变更时间 DESC
                  `);
                const changeTime = logRes.recordset?.[0]?.变更时间;
                const remark = logRes.recordset?.[0]?.备注 || '';
                const operator = logRes.recordset?.[0]?.操作人 || '';
                if (changeTime) {
                  // SQL Server 存储中国本地时间（UTC+8），改为 UTC ISO 再保存
                  const dt = new Date(changeTime);
                  const utcTime = new Date(dt.getTime() - 8 * 3600000);
                  const isAuto = remark.includes('自动完成(RQZT)') || remark.includes('自动完成') || remark.includes('RQZT');
                  const statusRemark = isAuto ? '自动' : '手动';
                  const changedBy = isAuto ? '系统自动' : (operator || '手动');
                  await supabase.from("reports").update({
                    status_changed_at: utcTime.toISOString(),
                    status_remark: statusRemark,
                    status_changed_by: changedBy
                  })
                    .eq("product_code", r.product_code)
                    .eq("store_id", r.store_id)
                    .eq("order_type", "缺货订购");
                  backfilled++;
                  if (isAuto) autoCount++; else manualCount++;
                }
              } catch {} // 单条失败跳过
            }
            result = { backfilled, autoCount, manualCount, message: `已回填 ${backfilled} 条（自动${autoCount}条，手动${manualCount}条）` };
          } finally { releasePool(pool); }
        } catch (e) {
          console.error("[backfill_status_time] 失败:", e);
          result = { backfilled: 0, error: String(e) };
        }
        break;
      }

      case "get_status_log": {
        // 查询订货状态变更日志（从 Feedback 表读取）
        const { log_product_code, top } = params;
        const pool = await getPool();
        try {
          const logs = await pool.request()
            .input("商品编码", sql.NVarChar, validateInput(log_product_code || "", "商品编码", 50) || null)
            .input("Top", sql.Int, Math.min(top || 50, 200))
            .query(`
              SELECT TOP (@Top) 
                商品编码, 实际订货数量, 补货状态, 订货时间, 到货确认时间, 操作人, 备注
              FROM dbo.Shortage_OrderFeedback
              WHERE (@商品编码 IS NULL OR 商品编码 = @商品编码)
              ORDER BY ISNULL(到货确认时间, 订货时间) DESC
            `);
          result = logs.recordset;
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "sync_product_cache": {
        // 同步商品基础信息到 Supabase（含拼音助记码）
        // 修复：ProductCache_RQZT 表在 RQZT 数据库中，不在 ZHYYLS 中
        const poolRQZT = await getPool();
        try {
          console.log('正在从 RQZT.ProductCache_RQZT 获取完整商品列表...');
          
          const productsResult = await poolRQZT.request()
            .query(`SELECT
                    product_code,
                    product_name,
                    spec as product_spec,
                    manufacturer,
                    pinyin_code
                    FROM dbo.ProductCache_RQZT WITH (NOLOCK)
                    ORDER BY product_code`);
          
          console.log(`✅ 从 RQZT 缓存表获取到 ${productsResult.recordset.length} 个商品`);
          
          // 构建商品列表
          const productMap = new Map();
          productsResult.recordset.forEach(p => {
            const productCode = (p.product_code || '').trim();
            
            if (productCode !== '' && !productMap.has(productCode)) {
              productMap.set(productCode, {
                product_code: productCode,
                product_name: p.product_name || '',
                product_spec: p.product_spec || '',
                manufacturer: p.manufacturer || '',
                pinyin_code: (p.pinyin_code || '').trim().toLowerCase(),
              });
            }
          });
          
          const productList = Array.from(productMap.values());
          console.log(`✅ 有效商品数量: ${productList.length}（去重后）`);
          
          // 分批 UPSERT（有则更新，无则插入），消除 DELETE→INSERT 之间的数据空窗期
          console.log('正在 UPSERT 商品缓存...');
          const batchSize = 200;
          for (let i = 0; i < productList.length; i += batchSize) {
            const batch = productList.slice(i, i + batchSize);
            console.log(`UPSERT 第 ${Math.floor(i/batchSize) + 1} 批，共 ${batch.length} 个商品`);
            
            const { error: upsertError } = await supabase
              .from("product_cache")
              .upsert(batch, { onConflict: 'product_code' });
              
            if (upsertError) {
              console.error('UPSERT 数据失败:', upsertError);
              throw upsertError;
            }
          }

          // 清理不在新列表中的过期商品（先查已有再求差集，避免 NOT IN 大数组超限）
          const newCodeSet = new Set(productList.map(p => p.product_code));
          try {
            const { data: existingRows, error: fetchErr } = await supabase
              .from("product_cache")
              .select("product_code");
            if (!fetchErr && existingRows) {
              const staleCodes: string[] = [];
              for (const row of existingRows) {
                if (!newCodeSet.has(row.product_code)) {
                  staleCodes.push(row.product_code);
                }
              }
              if (staleCodes.length > 0) {
                console.log(`清理 ${staleCodes.length} 个过期商品...`);
                // 分批删除（Supabase in 过滤器数组太大会导致 URL 超长）
                for (let i = 0; i < staleCodes.length; i += batchSize) {
                  const chunk = staleCodes.slice(i, i + batchSize);
                  const { error: delErr } = await supabase
                    .from("product_cache")
                    .delete()
                    .in("product_code", chunk);
                  if (delErr) console.warn(`⚠ 清理过期商品第 ${Math.floor(i/batchSize)+1} 批失败:`, delErr);
                }
              }
            }
          } catch (staleErr) {
            console.warn('⚠ 清理过期商品缓存失败（非关键）:', staleErr);
          }
          
          console.log(`✅ 商品缓存同步完成！共 ${productList.length} 个商品`);
          result = { synced: productList.length };
        } catch (err) {
          console.error('❌ 商品缓存同步异常:', err);
          throw err;
        } finally {
          releasePool(poolRQZT);
        }
        break;
      }

      case "get_sync_log":
      case "sync_cache":
      case "sync_integration": {
        const pool = await getPool();
        try {
          if (action === "sync_cache") {
            // 标准同步模式
            const sync = await pool.request().execute("usp_Sync_AllShortageCache");
            try { await supabase.from("sync_log_table").insert([{ sync_time: new Date().toISOString(), sync_type: "standard", status: "success", detail: "标准同步完成" }]); } catch(e) {}
            result = sync.recordsets;
          } else if (action === "sync_integration") {
            // 整合同步模式: ZHYYLS实时 + SPFXB派生（推荐）
            // 直接使用标准同步存储过程（整合版不存在）
            const sync = await pool.request().execute("usp_Sync_AllShortageCache");
            try { await supabase.from("sync_log_table").insert([{ sync_time: new Date().toISOString(), sync_type: "integration", status: "success", detail: "整合同步完成" }]); } catch(e) {}
            result = sync.recordsets;
          } else {
            // 获取同步日志
            const log = await pool.request().input("Top", sql.Int, 50).execute("usp_GetSyncLog");
            result = log.recordsets;
          }
        } finally {
          releasePool(pool);
        }
        break;
      }
      
      case "sync_realtime_only": {
        // 仅同步 ZHYYLS 实时数据（不依赖 SPFXB）
        const pool = await getPool();
        try {
          const sync = await pool.request().execute("usp_Sync_Shortage_ZHYYLS_Only");
          try { await supabase.from("sync_log_table").insert([{ sync_time: new Date().toISOString(), sync_type: "realtime_only", status: "success", detail: "实时数据同步完成" }]); } catch(e) {}
          result = sync.recordsets;
        } finally {
          releasePool(pool);
        }
        break;
      }

      // ========== P0优化：增量同步库存数据到 Supabase ==========
      case "sync_inventory_incremental": {
        // P0方案1 + P1方案5：增量同步库存数据到 Supabase
        // 根据 last_updated 时间戳，只同步变化的数据
        const since = params?.since || null;  // ISO 格式时间戳
        const pool = await getPool();
        try {
          let query = `
            SELECT 
              LTRIM(RTRIM(ISNULL(商品编码, ''))) as product_code,
              LTRIM(RTRIM(ISNULL(门店编码, ''))) as store_id,
              LTRIM(RTRIM(ISNULL(门店名称, ''))) as store_name,
              ISNULL(库存数量, 0) as store_stock,
              ISNULL(在途数量, 0) as in_transit,
              ISNULL(门店库存汇总, 0) as store_total,
              ISNULL(配送中心库存数量, 0) as dc_stock,
              ISNULL(前30天销售数量, 0) as sales_30days,
              ISNULL(前90天销售数量, 0) as sales_90days,
              ISNULL(月均销售数量, 0) as monthly_sales,
              ISNULL(标准库存数量确认, 0) as standard_stock,
              ISNULL(门店计划, 0) as store_plan,
              LTRIM(RTRIM(ISNULL(标记, ''))) as flag,
              CASE WHEN 标记 IN ('A','B','C','D','E') THEN 'A-E类' ELSE '其他类' END as category,
              GETDATE() as last_updated
            FROM dbo.SPFXB_Result WITH (NOLOCK)
            WHERE 商品编码 IS NOT NULL AND LTRIM(RTRIM(商品编码)) <> ''
          `;
          
          // 如果指定了 since 参数，只查询更新的数据
          if (since) {
            query = `
              SELECT 
                LTRIM(RTRIM(ISNULL(商品编码, ''))) as product_code,
                LTRIM(RTRIM(ISNULL(门店编码, ''))) as store_id,
                LTRIM(RTRIM(ISNULL(门店名称, ''))) as store_name,
                ISNULL(库存数量, 0) as store_stock,
                ISNULL(在途数量, 0) as in_transit,
                ISNULL(门店库存汇总, 0) as store_total,
                ISNULL(配送中心库存数量, 0) as dc_stock,
                ISNULL(前30天销售数量, 0) as sales_30days,
                ISNULL(前90天销售数量, 0) as sales_90days,
                ISNULL(月均销售数量, 0) as monthly_sales,
                ISNULL(标准库存数量确认, 0) as standard_stock,
                ISNULL(门店计划, 0) as store_plan,
                LTRIM(RTRIM(ISNULL(标记, ''))) as flag,
                CASE WHEN 标记 IN ('A','B','C','D','E') THEN 'A-E类' ELSE '其他类' END as category,
                GETDATE() as last_updated
              FROM dbo.SPFXB_Result WITH (NOLOCK)
              WHERE 商品编码 IS NOT NULL AND LTRIM(RTRIM(商品编码)) <> ''
                AND (库存数量 > 0 OR 在途数量 > 0 OR 门店库存汇总 > 0)
            `;
            console.log(`[增量同步] 仅同步有库存/在途的数据`);
          }
          
          const resultSet = await pool.request().query(query);
          const records = resultSet.recordset || [];
          
          if (records.length === 0) {
            result = { synced: 0, message: '没有需要同步的数据' };
            break;
          }
          
          // 批量插入/更新到 Supabase（upsert）
          const batchSize = 200;
          let totalSynced = 0;
          
          for (let i = 0; i < records.length; i += batchSize) {
            const batch = records.slice(i, i + batchSize).map((r: any) => ({
              product_code: r.product_code,
              store_id: r.store_id,
              store_name: r.store_name,
              store_stock: r.store_stock,
              in_transit: r.in_transit,
              store_total: r.store_total,
              dc_stock: r.dc_stock,
              sales_30days: r.sales_30days,
              sales_90days: r.sales_90days,
              monthly_sales: r.monthly_sales,
              standard_stock: r.standard_stock,
              store_plan: r.store_plan,
              flag: r.flag,
              category: r.category,
              last_updated: new Date().toISOString()
            }));
            
            const { error: upsertError } = await supabase
              .from("shortage_storestock_cache")
              .upsert(batch, { 
                onConflict: 'product_code,store_id',
                ignoreDuplicates: false 
              });
            
            if (upsertError) {
              console.error(`[增量同步] 第${Math.floor(i/batchSize) + 1}批插入失败:`, upsertError);
            } else {
              totalSynced += batch.length;
            }
          }
          
          // 更新同步元数据
          const syncMeta = {
            sync_type: 'inventory_incremental',
            last_sync: new Date().toISOString(),
            records_synced: totalSynced,
            since: since || 'full',
            status: 'success'
          };
          
          await supabase
            .from("sync_metadata")
            .upsert([syncMeta], { onConflict: 'sync_type' });
          
          // 记录日志
          await supabase.from("sync_log_table").insert([{ 
            sync_time: new Date().toISOString(), 
            sync_type: "inventory_incremental", 
            status: "success", 
            detail: `增量同步 ${totalSynced} 条库存数据` 
          }]);
          
          result = { synced: totalSynced, message: `增量同步完成，共 ${totalSynced} 条记录` };
          console.log(`✅ 增量同步完成，共 ${totalSynced} 条记录`);
        } catch (err) {
          console.error(`❌ 增量同步失败:`, err);
          await supabase.from("sync_log_table").insert([{ 
            sync_time: new Date().toISOString(), 
            sync_type: "inventory_incremental", 
            status: "error", 
            detail: `增量同步失败: ${String(err)}` 
          }]);
          throw err;
        } finally {
          releasePool(pool);
        }
        break;
      }

      // ========== P0优化：获取同步元数据（用于前端判断是否需要刷新）==========
      case "get_sync_metadata": {
        // 返回上次同步时间和同步状态
        const { data: metaData, error: metaError } = await supabase
          .from("sync_metadata")
          .select("*")
          .eq("sync_type", "inventory_incremental")
          .single();
        
        const { data: logData } = await supabase
          .from("sync_log_table")
          .select("*")
          .eq("sync_type", "inventory_incremental")
          .order("sync_time", { ascending: false })
          .limit(1);
        
        result = {
          last_sync: metaData?.last_sync || logData?.[0]?.sync_time || null,
          records_count: metaData?.records_synced || 0,
          status: logData?.[0]?.status || 'unknown',
          since: metaData?.since || null
        };
        break;
      }

      // ========== P0优化：全量同步库存数据到 Supabase（首次同步或重建缓存）==========
      case "sync_inventory_full": {
        // P0方案1：全量同步库存数据到 Supabase
        // 用于首次初始化或重建缓存
        const pool = await getPool();
        try {
          console.log(`[全量同步] 开始全量同步库存数据到 Supabase...`);
          
          const resultSet = await pool.request().query(`
            SELECT 
              LTRIM(RTRIM(ISNULL(商品编码, ''))) as product_code,
              LTRIM(RTRIM(ISNULL(门店编码, ''))) as store_id,
              LTRIM(RTRIM(ISNULL(门店名称, ''))) as store_name,
              ISNULL(库存数量, 0) as store_stock,
              ISNULL(在途数量, 0) as in_transit,
              ISNULL(门店库存汇总, 0) as store_total,
              ISNULL(配送中心库存数量, 0) as dc_stock,
              ISNULL(前30天销售数量, 0) as sales_30days,
              ISNULL(前90天销售数量, 0) as sales_90days,
              ISNULL(月均销售数量, 0) as monthly_sales,
              ISNULL(标准库存数量确认, 0) as standard_stock,
              ISNULL(门店计划, 0) as store_plan,
              LTRIM(RTRIM(ISNULL(标记, ''))) as flag,
              CASE WHEN 标记 IN ('A','B','C','D','E') THEN 'A-E类' ELSE '其他类' END as category,
              GETDATE() as last_updated
            FROM dbo.SPFXB_Result WITH (NOLOCK)
            WHERE 商品编码 IS NOT NULL AND LTRIM(RTRIM(商品编码)) <> ''
          `);
          
          const records = resultSet.recordset || [];
          console.log(`[全量同步] 从 SQL Server 获取 ${records.length} 条数据`);
          
          if (records.length === 0) {
            result = { synced: 0, message: '没有数据需要同步' };
            break;
          }
          
          // 清空旧缓存（全量同步需要重建）
          await supabase
            .from("shortage_storestock_cache")
            .delete()
            .neq('product_code', '');
          
          // 分批插入
          const batchSize = 200;
          let totalSynced = 0;
          
          for (let i = 0; i < records.length; i += batchSize) {
            const batch = records.slice(i, i + batchSize).map((r: any) => ({
              product_code: r.product_code,
              store_id: r.store_id,
              store_name: r.store_name,
              store_stock: r.store_stock,
              in_transit: r.in_transit,
              store_total: r.store_total,
              dc_stock: r.dc_stock,
              sales_30days: r.sales_30days,
              sales_90days: r.sales_90days,
              monthly_sales: r.monthly_sales,
              standard_stock: r.standard_stock,
              store_plan: r.store_plan,
              flag: r.flag,
              category: r.category,
              last_updated: new Date().toISOString()
            }));
            
            const { error: insertError } = await supabase
              .from("shortage_storestock_cache")
              .insert(batch);
            
            if (insertError) {
              console.error(`[全量同步] 第${Math.floor(i/batchSize) + 1}批插入失败:`, insertError);
            } else {
              totalSynced += batch.length;
              console.log(`[全量同步] 已同步 ${totalSynced}/${records.length} 条`);
            }
          }
          
          // 更新同步元数据
          await supabase
            .from("sync_metadata")
            .upsert([{
              sync_type: 'inventory_incremental',
              last_sync: new Date().toISOString(),
              records_synced: totalSynced,
              since: 'full',
              status: 'success'
            }], { onConflict: 'sync_type' });
          
          // 记录日志
          await supabase.from("sync_log_table").insert([{ 
            sync_time: new Date().toISOString(), 
            sync_type: "inventory_full", 
            status: "success", 
            detail: `全量同步 ${totalSynced} 条库存数据到 Supabase` 
          }]);
          
          result = { synced: totalSynced, message: `全量同步完成，共 ${totalSynced} 条记录` };
          console.log(`✅ 全量同步完成，共 ${totalSynced} 条记录`);
        } catch (err) {
          console.error(`❌ 全量同步失败:`, err);
          await supabase.from("sync_log_table").insert([{ 
            sync_time: new Date().toISOString(), 
            sync_type: "inventory_full", 
            status: "error", 
            detail: `全量同步失败: ${String(err)}` 
          }]);
          throw err;
        } finally {
          releasePool(pool);
        }
        break;
      }

      // ========== 员工设备绑定登录 ==========
      case "employee_login": {
        const { phone, password, device_id } = params;
        
        // 1. 验证手机号格式
        const validPhone = validateInput(phone, "手机号", 11);
        if (!/^\d{11}$/.test(validPhone)) {
          return new Response(JSON.stringify({ 
            success: false, error: "请输入正确的11位手机号" 
          }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        // 2. 查员工是否存在
        const { data: empData, error: empError } = await supabase
          .from("store_employees")
          .select("*")
          .eq("phone", validPhone)
          .eq("is_active", true)
          .limit(1);
        
        if (empError || !empData || empData.length === 0) {
          return new Response(JSON.stringify({ 
            success: false, error: "该手机号未注册为门店员工，请联系管理员" 
          }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        const employee = empData[0];
        
        // 2.5 登录限制：只有特定账号允许登录门店，其他仅用于上报人名册
        const EMPLOYEE_LOGIN_WHITELIST = ['15305479520'];
        const hasPhone = employee.phone && employee.phone.trim() !== '';
        if (!hasPhone || !EMPLOYEE_LOGIN_WHITELIST.includes(employee.phone.trim())) {
          return new Response(JSON.stringify({ 
            success: false, error: "该员工暂不支持登录，仅供上报人名册使用。请联系管理员。" 
          }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        // 3. 验证密码
        const storedPwd = employee.password || DEFAULT_EMPLOYEE_PASSWORD;
        if (password !== storedPwd) {
          return new Response(JSON.stringify({ 
            success: false, error: "密码错误，请检查后重试" 
          }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        // 4. 查该员工的所有设备绑定记录
        const { data: allDevices } = await supabase
          .from("device_bindings")
          .select("id, device_id, is_authorized, is_active")
          .eq("employee_id", employee.id)
          .eq("is_active", true);

        const validDeviceId = validateInput(device_id, "设备ID", 100);
        
        // 5. 检查例外账号（不限制设备）
        const isExempt = isExemptAccount(employee.phone);
        
        // 5. 检查该员工是否有其他设备正在使用（单设备登录限制）
        if (!isExempt) {
          const otherDevice = allDevices?.find(d => d.device_id !== validDeviceId && d.is_authorized);
          if (otherDevice) {
            return new Response(JSON.stringify({
              success: false, error: "该账号已在其他设备登录，请先退出原设备后再试"
            }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }

        // 6. 查当前设备的绑定状态
        const { data: currentDevice } = await supabase
          .from("device_bindings")
          .select("id, is_authorized")
          .eq("device_id", validDeviceId)
          .eq("is_active", true)
          .limit(1);

        // 7. 判断逻辑
        if (currentDevice && currentDevice.length > 0) {
          const device = currentDevice[0];
          if (!isExempt && !device.is_authorized) {
            // 设备未被管理员授权 → 拒绝
            return new Response(JSON.stringify({
              success: false, error: "该设备未被授权，请联系管理员授权后使用"
            }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          // 已授权设备 → 更新登录时间，允许登录
          await supabase.from("device_bindings").update({ last_login_at: new Date().toISOString() }).eq("id", device.id);
          result = { employee: employee, login_type: isExempt ? "exempt_employee" : "authorized_device" };
        } else {
          // 新设备 → 自动创建设备记录，等待管理员授权
          if (isExempt) {
            // 例外账号：自动授权
            await supabase.from("device_bindings").insert([{
              device_id: validDeviceId,
              employee_id: employee.id,
              is_authorized: true,
              is_active: true,
              first_login_at: new Date().toISOString(),
              last_login_at: new Date().toISOString()
            }]);
            result = { employee: employee, login_type: "exempt_employee" };
          } else {
            // 普通账号：需要授权
            await supabase.from("device_bindings").insert([{
              device_id: validDeviceId,
              employee_id: employee.id,
              is_authorized: false,
              is_active: true,
              first_login_at: new Date().toISOString()
            }]);
            return new Response(JSON.stringify({
              success: false, 
              error: "该设备未授权，请联系管理员授权后使用",
              pending_device_id: validDeviceId,
              pending_employee_id: employee.id
            }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
        break;
      }

      // ========== 门店主账号登录（设备授权限制）==========
      case "store_login": {
        const { username, password, device_id } = params;
        
        // 2. 验证账号密码（使用独立客户端，避免污染数据库查询客户端的认证状态）
        const validUsername = validateInput(username, "用户名", 50);
        const validPassword = validateInput(password, "密码", 100);

        // 限流检查（防止暴力破解）
        const deviceIdForRate = validateInput(device_id, "设备ID", 100) || 'unknown';
        const rateKey = validUsername + '_' + (deviceIdForRate.substring(0, 20));
        const rateCheck = checkLoginRateLimit(rateKey);
        if (!rateCheck.allowed) {
          return new Response(JSON.stringify({
            success: false, error: rateCheck.message
          }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        let { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({
          email: validUsername + '@wszh.com',
          password: validPassword
        });
        
        if (signInError) {
          console.log("[store_login] Auth密码验证失败, username:", validUsername, "error:", signInError.message);
          
          // 检查是否是员工账号（store_employees.password 可能已更新但 Auth 未同步）
          const { data: empCheck } = await authClient
            .from("store_employees")
            .select("id, phone, password")
            .eq("phone", validUsername)
            .eq("is_active", true)
            .limit(1);
          
          if (empCheck && empCheck.length > 0) {
            const emp = empCheck[0];
            const storedPwd = emp.password || DEFAULT_EMPLOYEE_PASSWORD;
            console.log("[store_login] 找到员工记录, phone:", emp.phone, "输入密码匹配:", validPassword === storedPwd);
            
            if (validPassword === storedPwd) {
              // 员工密码正确但 Auth 密码不匹配，自动修复 Auth 密码
              console.log("[store_login] 员工密码正确，尝试修复Auth密码...");
              try {
                const email = validUsername + '@wszh.com';
                const { data: userList } = await authClient.auth.admin.listUsers();
                const authUser = userList?.users?.find((u: any) => u.email === email);
                
                if (authUser) {
                  const { error: fixErr } = await authClient.auth.admin.updateUserById(
                    authUser.id, { password: validPassword }
                  );
                  if (fixErr) {
                    console.error("[store_login] Auth密码修复失败:", fixErr.message);
                  } else {
                    console.log("[store_login] Auth密码已修复，重新登录...");
                    // 重新尝试登录
                    const { data: retryData, error: retryErr } = await authClient.auth.signInWithPassword({
                      email: validUsername + '@wszh.com',
                      password: validPassword
                    });
                    if (!retryErr && retryData) {
                      console.log("[store_login] 修复后登录成功");
                      // 继续用修复后的数据
                      signInData = retryData;
                      signInError = null;
                    }
                  }
                } else {
                  // Auth 中无此员工用户，自动创建
                  console.warn("[store_login] Auth中无此用户，自动创建:", email);
                  try {
                    const { data: newUser, error: createErr } = await authClient.auth.admin.createUser({
                      email: email,
                      password: validPassword,
                      email_confirm: true
                    });
                    if (createErr) {
                      console.error("[store_login] 创建Auth用户失败:", createErr.message);
                    } else if (newUser && newUser.user) {
                      console.log("[store_login] Auth用户已创建:", newUser.user.id);
                      // 重新登录
                      const { data: retryData, error: retryErr } = await authClient.auth.signInWithPassword({
                        email: validUsername + '@wszh.com',
                        password: validPassword
                      });
                      if (!retryErr && retryData) {
                        console.log("[store_login] 新用户登录成功");
                        signInData = retryData;
                        signInError = null;
                      } else {
                        console.error("[store_login] 新用户登录失败:", retryErr?.message);
                      }
                    }
                  } catch (createErr) {
                    console.error("[store_login] 创建Auth用户异常:", createErr);
                  }
                }
              } catch (fixErr) {
                console.error("[store_login] Auth修复异常:", fixErr);
              }
            }
          }
          
          if (signInError) {
            recordLoginAttempt(rateKey, false);
            return new Response(JSON.stringify({
              success: false, error: "账号或密码错误"
            }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
        recordLoginAttempt(rateKey, true); // 登录成功，清除失败记录
        
        const userData = signInData!.user;
        console.log("[store_login] 用户登录成功, id:", userData.id, "username:", validUsername);
        
        // 2. 检查是否是 admin 子账号（使用全新客户端，避免 signInWithPassword 的 session 缓存影响 RLS）
        const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false }
        });
        console.log("[store_login] 尝试用 user_id 查询 admin_users...");
        let { data: adminData, error: adminError } = await adminClient
          .from("admin_users")
          .select("*")
          .eq("user_id", userData.id)
          .eq("is_active", true)
          .limit(1);
        console.log("[store_login] user_id 查询结果:", adminData ? adminData.length : 0, "条, error:", adminError ? adminError.message : 'none');

        // 备用：如果 user_id 不匹配，用 username 查询（创建时可能 user_id 不一致）
        if (!adminData || adminData.length === 0) {
          console.log("[store_login] user_id 查询失败，尝试用 username 查询...");
          const { data: adminDataByName, error: nameError } = await adminClient
            .from("admin_users")
            .select("*")
            .eq("username", validUsername)
            .eq("is_active", true)
            .limit(1);
          console.log("[store_login] username 查询结果:", adminDataByName ? adminDataByName.length : 0, "条, error:", nameError ? nameError.message : 'none');
          if (adminDataByName && adminDataByName.length > 0) {
            // 自动修复 user_id 不匹配
            console.log("[store_login] 找到用户，自动修复 user_id...");
            const { error: updateError } = await adminClient
              .from("admin_users")
              .update({ user_id: userData.id, updated_at: new Date().toISOString() })
              .eq("id", adminDataByName[0].id);
            console.log("[store_login] 修复 user_id 结果:", updateError ? updateError.message : 'success');
            adminData = adminDataByName;
          }
        }

        if (adminData && adminData.length > 0) {
          console.log("[store_login] 找到管理员用户，role:", adminData[0].role);
          const adminUser = adminData[0];
          const isSuperAdmin = adminUser.role === 'super_admin';
          result = {
            user: {
              id: userData.id,
              username: validUsername,
              role: isSuperAdmin ? 'super_admin' : 'admin',
              admin_role: adminUser.role,
              permissions: adminUser.permissions || {},
              name: adminUser.name || validUsername,
              store_id: null,
              store_name: '管理员',
              is_employee: false
            },
            session: signInData.session,
            debug: {
              found_by: adminUser.user_id === userData.id ? 'user_id' : 'username',
              admin_record_id: adminUser.id,
              admin_role: adminUser.role
            }
          };
          break;
        }
        
        // 如果没找到，打印调试信息
        console.log("[store_login] 未找到 admin_users 记录");
        console.log("[store_login] 查询条件: user_id =", userData.id, "OR username =", validUsername);

        // 3. 原 admin 账号兼容（未在 admin_users 表中但 username 是 admin）
        var isAdmin = validUsername === 'admin';
        if (isAdmin) {
          result = {
            user: {
              id: userData.id,
              username: validUsername,
              role: 'super_admin',
              admin_role: 'super_admin',
              permissions: {
                view_summary: true, edit_status: true, manage_order: true,
                manage_employees: true, manage_devices: true, manage_stores: true,
                manage_admins: true, sync_data: true, view_audit_log: true
              },
              name: '超级管理员',
              store_id: null,
              store_name: '管理员',
              is_employee: false
            },
            session: signInData.session
          };
          break;
        }
        
        // ========== 15305479520 完整豁免：不查也不写设备绑定表 ==========
        if (validUsername === '15305479520') {
          console.log('[store_login] 15305479520 豁免账号，跳过所有设备校验');
          // 直接组装 store 角色返回（USER_STORE_MAP → wszhyy02）
          const exemptStoreId = USER_STORE_MAP['15305479520'] || 'wszhyy02';
          result = {
            user: {
              id: userData.id,
              username: validUsername,
              role: 'store',
              store_id: exemptStoreId,
              store_name: STORE_NAME_MAP[exemptStoreId] || '02第二药店',
              is_employee: false
            },
            session: signInData.session
          };
          break;
        }

        // ========== 普通门店账号：设备绑定四规则（回到 5.9 模式）==========
        // 规则① 无任何绑定记录 → 自动绑定当前设备（is_authorized=true），放行
        // 规则② 有绑定且 device_id 匹配 → 放行
        // 规则③ 有绑定但 device_id 不匹配 → 拒绝
        // 规则④ 例外账号（admin_users 管理员、15305479520、username='admin'）已在上方 break
        const validDeviceId = validateInput(device_id, "设备ID", 100);
        
        console.log('[store_login] 普通门店账号设备校验:', validUsername, '设备:', validDeviceId);
        
        // 查询该门店所有已授权且活跃的设备绑定
        const { data: boundRecords, error: boundErr } = await adminClient
          .from("store_authorized_devices")
          .select("id, device_id, is_authorized, is_active")
          .eq("username", validUsername)
          .eq("is_authorized", true)
          .eq("is_active", true);
        
        if (boundErr) {
          console.error('[store_login] 查询绑定记录失败:', boundErr);
          return new Response(JSON.stringify({
            success: false, error: "设备绑定检查失败，请稍后重试"
          }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        const bound = boundRecords || [];
        const currentMatch = bound.find(d => d.device_id === validDeviceId);
        
        if (bound.length === 0) {
          // 规则① 无绑定记录 → 自动绑
          console.log('[store_login] 无绑定记录，自动绑定设备', validDeviceId);
          const { data: autoBound, error: autoErr } = await adminClient
            .from("store_authorized_devices")
            .insert([{
              device_id: validDeviceId,
              username: validUsername,
              is_authorized: true,
              is_active: true,
              authorized_at: new Date().toISOString(),
              last_login_at: new Date().toISOString()
            }])
            .select();
          if (autoErr) {
            console.error('[store_login] 自动绑定失败:', autoErr);
            return new Response(JSON.stringify({
              success: false, error: "设备绑定失败: " + autoErr.message
            }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          console.log('[store_login] 自动绑定成功:', autoBound?.[0]?.id);
        } else if (currentMatch) {
          // 规则② 同机放行，更新 last_login_at
          console.log('[store_login] 同机放行，更新登录时间');
          await adminClient
            .from("store_authorized_devices")
            .update({ last_login_at: new Date().toISOString() })
            .eq("id", currentMatch.id);
        } else {
          // 规则③ 异机拒绝
          console.log('[store_login] 异机拒绝，已绑定设备:', bound.map(d => d.device_id).join(','));
          return new Response(JSON.stringify({
            success: false,
            error: "该账号已在另一台电脑登录，请联系管理员解绑原设备后再试"
          }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        // ========== 修复 sub-account store_id ==========
        // 主账号（如 wszhyy02）登录时 validUsername 就是 store_id
        // sub-account（如"海蓝"）登录时，需要查 USER_STORE_MAP 或 store_authorized_devices 找到所属门店
        let realStoreId = validUsername;
        if (!/^wszhyy\d+$/.test(realStoreId)) {
          // 1. 尝试通过 USER_STORE_MAP（手机号映射）
          if (USER_STORE_MAP[realStoreId]) {
            realStoreId = USER_STORE_MAP[realStoreId];
          } else {
            // 2. 查 store_authorized_devices 找到该用户绑定的门店
            const { data: devData } = await adminClient
              .from("store_authorized_devices")
              .select("store_id")
              .eq("username", validUsername)
              .eq("is_authorized", true)
              .eq("is_active", true)
              .limit(1);
            if (devData && devData.length > 0 && devData[0].store_id) {
              realStoreId = devData[0].store_id;
            }
          }
        }

        result = {
          user: {
            id: userData.id,
            username: validUsername,
            role: 'store',
            store_id: realStoreId,
            store_name: STORE_NAME_MAP[realStoreId] || STORE_NAME_MAP[validUsername] || validUsername,
            is_employee: false
          },
          session: signInData.session
        };
        break;
      }

      // ========== 设备授权管理（管理员）==========
      case "authorize_device": {
        const { device_id, target_type, target_id, authorize } = params;
        // target_type: 'employee' 或 'store'
        // target_id: employee_id 或 username
        
        const validDeviceId = validateInput(device_id, "设备ID", 100);
        const validTargetType = validateInput(target_type, "类型", 20);
        const validTargetId = validateInput(target_id, "目标ID", 100);
        
        // 修复：统一使用 store_authorized_devices 表（所有设备记录都在此表）
        console.log("[authorize_device] 目标类型:", validTargetType, "目标ID:", validTargetId, "设备ID:", validDeviceId);
        
        // 授权前先清理该设备的所有其他账号的已授权记录（防止设备被多账号绑定）
        if (authorize) {
          console.log("[authorize_device] 清理设备 " + validDeviceId + " 的其他绑定记录");
          const { error: clearErr } = await supabase
            .from("store_authorized_devices")
            .update({ is_authorized: false, is_active: false })
            .eq("device_id", validDeviceId)
            .neq("username", validTargetId);
          
          if (clearErr) {
            console.warn("[authorize_device] 清理其他绑定失败:", clearErr);
          } else {
            console.log("[authorize_device] 已清理该设备的其他绑定记录");
          }
        }
        
        const { data: existing } = await supabase
          .from("store_authorized_devices")
          .select("id, is_authorized, username")
          .eq("device_id", validDeviceId)
          .eq("username", validTargetId)
          .limit(1);
        
        if (existing && existing.length > 0) {
          if (authorize) {
            await supabase
              .from("store_authorized_devices")
              .update({ is_authorized: true, is_active: true, authorized_at: new Date().toISOString() })
              .eq("id", existing[0].id);
          } else {
            // 拒绝：彻底删除该设备+账号的所有记录
            await supabase
              .from("store_authorized_devices")
              .delete()
              .eq("device_id", validDeviceId)
              .eq("username", validTargetId);
          }
        }
        
        result = { success: true, authorized: authorize };
        break;
      }

      // ========== 批量授权设备 ==========
      case "batch_authorize": {
        const { device_list, authorize } = params;
        // device_list: [{device_id, target_type, target_id}, ...]
        if (!Array.isArray(device_list) || device_list.length === 0) {
          return new Response(JSON.stringify({ success: false, error: "设备列表不能为空" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        let successCount = 0;
        let failCount = 0;
        
        for (const item of device_list) {
          try {
            const validDeviceId = validateInput(item.device_id, "设备ID", 100);
            const validTargetId = validateInput(item.target_id || item.username, "目标ID", 100);
            
            if (authorize) {
              // 清理同一设备的其他绑定
              await supabase
                .from("store_authorized_devices")
                .update({ is_authorized: false, is_active: false })
                .eq("device_id", validDeviceId)
                .neq("username", validTargetId);
              
              // 授权
              const { data: existing } = await supabase
                .from("store_authorized_devices")
                .select("id")
                .eq("device_id", validDeviceId)
                .eq("username", validTargetId)
                .eq("is_active", true)
                .limit(1);
              
              if (existing && existing.length > 0) {
                await supabase
                  .from("store_authorized_devices")
                  .update({ is_authorized: true, authorized_at: new Date().toISOString() })
                  .eq("id", existing[0].id);
              } else {
                await supabase.from("store_authorized_devices").insert([{
                  device_id: validDeviceId, username: validTargetId,
                  is_authorized: true, is_active: true,
                  authorized_at: new Date().toISOString()
                }]);
              }
            } else {
              // 批量拒绝：删除记录
              await supabase
                .from("store_authorized_devices")
                .delete()
                .eq("device_id", validDeviceId)
                .eq("username", validTargetId);
            }
            successCount++;
          } catch (e) {
            failCount++;
            console.error(`[batch_authorize] 处理失败:`, item, e);
          }
        }
        
        result = { success: true, authorized: authorize, success_count: successCount, fail_count: failCount };
        break;
      }

      case "get_pending_devices": {
        // 获取所有待授权的设备列表（管理员查看，只显示门店账号，员工不需要授权）
        
        // 员工设备不显示在待授权列表中（员工登录没有设备授权限制）
        let employeeDevices = [];
        
        // 门店账号待授权设备（查询所有门店）
        // 排除例外账号（admin 和 15305479520），这些账号不需要授权
        // 注意：不限制 is_active，因为清除授权后设备需要重新申请授权
        const { data: storePending, error: storeErr } = await supabase
          .from("store_authorized_devices")
          .select("*")
          .eq("is_authorized", false)
          .neq("username", "admin")
          .neq("username", "15305479520");
        
        if (storeErr) {
          console.error("[get_pending_devices] 门店设备查询失败:", storeErr);
          return new Response(JSON.stringify({ 
            success: false, 
            error: "查询失败：" + storeErr.message,
            employee_devices: employeeDevices,
            store_devices: []
          }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        // 为每个待授权设备查询冲突信息（同一设备是否被其他账号绑定）
        const pendingWithConflicts = [];
        if (storePending && storePending.length > 0) {
          for (const pending of storePending) {
            let conflictInfo = null;
            // 查询该设备是否有其他账号已授权
            const { data: conflicts } = await supabase
              .from("store_authorized_devices")
              .select("username, authorized_at")
              .eq("device_id", pending.device_id)
              .eq("is_authorized", true)
              .neq("username", pending.username)
              .limit(1);
            
            if (conflicts && conflicts.length > 0) {
              conflictInfo = {
                bound_to: conflicts[0].username,
                authorized_at: conflicts[0].authorized_at
              };
            }
            
            pendingWithConflicts.push({
              ...pending,
              conflict: conflictInfo
            });
          }
        }
        
        console.log("[get_pending_devices] 员工待授权:", employeeDevices.length, "门店待授权:", pendingWithConflicts.length);
        console.log("[get_pending_devices] 门店待授权详情:", JSON.stringify(pendingWithConflicts.slice(0, 3)));
        
        // 直接返回数据，不走 result
        return new Response(JSON.stringify({ 
          success: true, 
          data: {
            employee_devices: employeeDevices,
            store_devices: pendingWithConflicts
          }
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      case "get_authorized_devices": {
        // 获取已授权设备列表
        const { target_type, target_id } = params;
        const validTargetType = validateInput(target_type, "类型", 20);
        const validTargetId = validateInput(target_id, "目标ID", 100);
        
        console.log("[get_authorized_devices] 查询参数:", target_type, target_id);
        
        let devices = [];
        if (validTargetType === 'employee') {
          const { data, error } = await supabase
            .from("store_authorized_devices")
            .select("*")
            .eq("username", validTargetId)
            .eq("is_authorized", true)
            .eq("is_active", true)
            .neq("username", "15305479520");  // 豁免账号不显示
          
          devices = data || [];
        } else if (validTargetType === 'store') {
          const { data, error } = await supabase
            .from("store_authorized_devices")
            .select("*")
            .eq("username", validTargetId)
            .eq("is_authorized", true)
            .eq("is_active", true);
          
          devices = data || [];
        }
        
        // 调试：查询所有已授权设备（不限制账号）
        const { data: allAuthorized } = await supabase
          .from("store_authorized_devices")
          .select("username, device_id, is_authorized, is_active")
          .eq("is_authorized", true)
          .eq("is_active", true);
        console.log("[get_authorized_devices] 所有已授权设备总数:", allAuthorized?.length || 0);
        console.log("[get_authorized_devices] 所有已授权设备:", JSON.stringify(allAuthorized));
        
        result = devices;
        break;
      }
      
      case "debug_get_all_authorized": {
        const { data, error } = await supabase
          .from("store_authorized_devices")
          .select("username, device_id, is_authorized, is_active, created_at, authorized_at")
          .eq("is_authorized", true)
          .eq("is_active", true)
          .neq("username", "admin")
          .neq("username", "15305479520");
        
        result = data || [];
        break;
      }
      
      case "check_device_stores": {
        // 查询当前设备已绑定的门店列表（用于登录页锁死门店选择）
        const { device_id } = params;
        const validDeviceId = validateInput(device_id, "设备ID", 100);
        
        if (!validDeviceId) {
          result = { stores: [] };
          break;
        }
        
        // 查询该设备上所有已授权的门店
        const { data: boundStores, error: boundErr } = await supabase
          .from("store_authorized_devices")
          .select("username, store_id, is_authorized, is_active")
          .eq("device_id", validDeviceId)
          .eq("is_authorized", true);
        
        if (boundErr) {
          console.error("[check_device_stores] 查询失败:", boundErr);
          result = { stores: [] };
          break;
        }
        

        // 返回已绑定的门店列表
        const stores = (boundStores || []).map(d => {
          // 如果有 store_id 直接用，没有则尝试从映射表获取
          const storeId = d.store_id || USER_STORE_MAP[d.username] || d.username;
          return {
            username: storeId,  // 返回 store_id，让前端能匹配门店选项
            original_username: d.username,
            is_active: d.is_active
          };
        });
        
        console.log(`[check_device_stores] 设备 ${validDeviceId} 已绑定门店:`, JSON.stringify(stores));
        result = { stores };
        break;
      }

      case "clear_all_device_auth": {
        // 清除所有设备授权（强制所有设备重新申请授权）
        // 注意：仅管理员可调用此功能
        // 创建服务端客户端（使用 SERVICE KEY，绕过 RLS）
        const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false }
        });
        
        // 获取所有设备记录（除了例外账号）
        const { data: allDevices } = await adminClient
          .from("store_authorized_devices")
          .select("id, username, device_id, is_authorized")
          .neq("username", "admin")
          .neq("username", "15305479520");
        
        console.log("[clear_all_device_auth] 开始清除授权，现有设备数量:", allDevices?.length || 0);
        
        // 真正删除这些设备记录
        const { error: deleteError } = await adminClient
          .from("store_authorized_devices")
          .delete()
          .neq("username", "admin")  // 保留 admin 的授权
          .neq("username", "15305479520");  // 保留例外账号的授权
        
        if (deleteError) {
          console.error("[clear_all_device_auth] 删除失败:", deleteError);
        } else {
          console.log("[clear_all_device_auth] 已删除所有设备授权记录");
        }
        
        result = { cleared: true, device_count: allDevices?.length || 0 };
        break;
      }

      // ========== 用户主动退出登录 ==========
      case "logout_device": {
        // 用户退出当前设备登录（不取消授权，只清除活跃状态）
        const { target_type, target_id, device_id } = params;
        const validDeviceId = validateInput(device_id, "设备ID", 100);
        const validTargetType = validateInput(target_type, "类型", 20);
        const validTargetId = validateInput(target_id, "目标ID", 100);
        
        if (validTargetType === 'store') {
          // 仅标记为不活跃，保留 is_authorized 状态
          await supabase
            .from("store_authorized_devices")
            .update({ is_active: false, last_logout_at: new Date().toISOString() })
            .eq("username", validTargetId)
            .eq("device_id", validDeviceId);
        } else if (validTargetType === 'employee') {
          await supabase
            .from("device_bindings")
            .update({ is_active: false })
            .eq("employee_id", validTargetId)
            .eq("device_id", validDeviceId);
        }
        
        result = { logged_out: true };
        break;
      }

      case "revoke_device": {
        // 管理员撤销设备授权
        const { device_id, target_type, target_id } = params;
        const validDeviceId = validateInput(device_id, "设备ID", 100);
        const validTargetType = validateInput(target_type, "类型", 20);
        const validTargetId = validateInput(target_id, "目标ID", 100);
        
        // 修复：统一使用 store_authorized_devices 表
        if (validTargetType === 'employee' || validTargetType === 'store') {
          await supabase
            .from("store_authorized_devices")
            .update({ is_active: false, is_authorized: false })
            .eq("device_id", validDeviceId)
            .eq("username", validTargetId);
        }
        
        result = { revoked: true };
        break;
      }

      // ========== 员工管理（门店主账号调用）==========
      case "list_employees": {
        // 不传 store_id 则查询所有员工（管理后台用），传了则按门店筛选
        let query = supabase
          .from("store_employees")
          .select("*, device_bindings(device_id, is_active)")
          .order("created_at", { ascending: false });
        
        if (params.store_id) {
          query = query.eq("store_id", validateInput(params.store_id, "门店ID", 50));
        }
        
        const { data: emps, error } = await query;
        if (error) throw error;
        result = emps || [];
        break;
      }

      case "add_employee": {
        const { phone, name, store_id, store_name, created_by } = params;
        
        // 手机号可为空（空手机号=仅用于上报人名册，不可登录）
        var validPhone = '';
        if (phone && String(phone).trim() !== '') {
          const rawPhone = validateInput(phone, "手机号", 11);
          if (!/^\d{11}$/.test(rawPhone)) {
            return new Response(JSON.stringify({ success: false, error: "请输入正确的11位手机号" }), {
              status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }
          validPhone = rawPhone;
          
          // 检查重复（仅对有手机号的员工检查）
          const { data: existing } = await supabase
            .from("store_employees")
            .select("id")
            .eq("phone", validPhone)
            .limit(1);
          if (existing && existing.length > 0) {
            return new Response(JSON.stringify({ success: false, error: "该手机号已注册" }), {
              status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }
        }

        const { data: newEmp, error: addErr } = await supabase
          .from("store_employees")
          .insert([{
            phone: validPhone,
            name: validateInput(name || '', "姓名", 50),
            store_id: validateInput(store_id, "门店ID", 50),
            store_name: validateInput(store_name, "门店名称", 100),
            password: DEFAULT_EMPLOYEE_PASSWORD,  // 默认密码
            is_active: true,
            created_by: created_by
          }])
          .select();
        
        if (addErr) throw addErr;
        result = newEmp?.[0];
        break;
      }

      case "toggle_employee": {
        const { id, is_active } = params;
        const validId = validateInput(id, "员工ID", 100);
        const { data: updated } = await supabase
          .from("store_employees")
          .update({ is_active: is_active })
          .eq("id", validId)
          .select();
        result = updated;
        break;
      }

      case "update_employee_password": {
        // 修改员工密码（管理员操作）
        const { id, new_password } = params;
        const validId = validateInput(id, "员工ID", 100);
        const validPassword = validateInput(new_password, "新密码", 50);
        
        if (!validPassword || validPassword.length < 4) {
          return new Response(JSON.stringify({ success: false, error: "密码长度至少4位" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        // 先查员工手机号（用于同步更新 Auth 密码）
        const { data: empData } = await supabase
          .from("store_employees")
          .select("phone")
          .eq("id", validId)
          .single();
        
        const { data: updated, error: updateErr } = await supabase
          .from("store_employees")
          .update({ password: validPassword })
          .eq("id", validId)
          .select();
        
        if (updateErr) {
          return new Response(JSON.stringify({ success: false, error: "修改失败：" + updateErr.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        // 同步更新 Supabase Auth 密码（员工登录走 store_login，密码验证在 Auth 中）
        if (empData && empData.phone) {
          try {
            const email = empData.phone + '@wszh.com';
            console.log("[update_employee_password] 开始同步Auth密码, email:", email);
            
            // 方法1: 尝试用 supabase.auth.admin API
            let authUserId = null;
            try {
              const { data: userList, error: listErr } = await supabase.auth.admin.listUsers();
              if (listErr) {
                console.error("[update_employee_password] listUsers失败:", listErr.message);
              } else if (userList && userList.users) {
                const authUser = userList.users.find((u: any) => u.email === email);
                if (authUser) {
                  authUserId = authUser.id;
                  console.log("[update_employee_password] 通过listUsers找到Auth用户:", authUserId);
                }
              }
            } catch (e) {
              console.error("[update_employee_password] listUsers异常:", e);
            }
            
            // 方法2: 备用 - 通过 REST API 直接调用 Auth Admin
            if (!authUserId) {
              console.log("[update_employee_password] 尝试通过REST API查找用户...");
              const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
                headers: {
                  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                  'apikey': SUPABASE_SERVICE_KEY
                }
              });
              if (listRes.ok) {
                const listData = await listRes.json();
                if (listData && Array.isArray(listData.users)) {
                  const authUser = listData.users.find((u: any) => u.email === email);
                  if (authUser) {
                    authUserId = authUser.id;
                    console.log("[update_employee_password] 通过REST API找到Auth用户:", authUserId);
                  }
                }
              } else {
                console.error("[update_employee_password] REST API listUsers失败:", listRes.status);
              }
            }
            
            // 更新 Auth 密码
            if (authUserId) {
              // 方法1: supabase.auth.admin.updateUserById
              let updatedViaAdmin = false;
              try {
                const { error: authUpdateErr } = await supabase.auth.admin.updateUserById(
                  authUserId,
                  { password: validPassword }
                );
                if (authUpdateErr) {
                  console.error("[update_employee_password] updateUserById失败:", authUpdateErr.message);
                } else {
                  console.log("[update_employee_password] Auth密码已通过admin API更新:", email);
                  updatedViaAdmin = true;
                }
              } catch (e) {
                console.error("[update_employee_password] updateUserById异常:", e);
              }
              
              // 方法2: 备用 - REST API PUT
              if (!updatedViaAdmin) {
                console.log("[update_employee_password] 尝试通过REST API更新密码...");
                const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${authUserId}`, {
                  method: 'PUT',
                  headers: {
                    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                    'apikey': SUPABASE_SERVICE_KEY,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ password: validPassword })
                });
                if (updateRes.ok) {
                  console.log("[update_employee_password] Auth密码已通过REST API更新:", email);
                } else {
                  const errText = await updateRes.text();
                  console.error("[update_employee_password] REST API更新密码失败:", updateRes.status, errText);
                }
              }
            } else {
              console.warn("[update_employee_password] 未找到Auth用户:", email);
            }
          } catch (authErr) {
            console.error("[update_employee_password] Auth同步异常:", authErr);
          }
        }
        
        result = { success: true, updated: updated };
        break;
      }

      case "reset_employee_password": {
        // 重置员工密码为默认密码
        const { id } = params;
        const validId = validateInput(id, "员工ID", 100);
        
        // 先查员工手机号
        const { data: empData } = await supabase
          .from("store_employees")
          .select("phone")
          .eq("id", validId)
          .single();
        
        const { data: updated, error: updateErr } = await supabase
          .from("store_employees")
          .update({ password: DEFAULT_EMPLOYEE_PASSWORD })
          .eq("id", validId)
          .select();
        
        if (updateErr) {
          return new Response(JSON.stringify({ success: false, error: "重置失败：" + updateErr.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        // 同步更新 Supabase Auth 密码
        if (empData && empData.phone) {
          try {
            const email = empData.phone + '@wszh.com';
            const { data: userList } = await supabase.auth.admin.listUsers();
            const authUser = userList?.users?.find((u: any) => u.email === email);
            if (authUser) {
              await supabase.auth.admin.updateUserById(authUser.id, { password: DEFAULT_EMPLOYEE_PASSWORD });
              console.log("[reset_employee_password] Auth密码已同步重置:", email);
            }
          } catch (authErr) {
            console.error("[reset_employee_password] Auth同步异常:", authErr);
          }
        }
        
        result = { success: true, default_password: DEFAULT_EMPLOYEE_PASSWORD, updated: updated };
        break;
      }

      case "unbind_device": {
        const { device_id } = params;
        const validDeviceId = validateInput(device_id, "设备ID", 100);
        await supabase
          .from("device_bindings")
          .update({ is_active: false })
          .eq("device_id", validDeviceId);
        result = { unbound: true };
        break;
      }

      // ========== 获取上报数据（管理后台汇总）==========
      case "get_reports": {
        const { data: reports, error } = await supabase
          .from("reports")
          .select("*")
          .order("created_at", { ascending: false });
        
        if (error) throw error;
        
        // 补充缺失的商品名称（从 product_cache 查询）
        if (reports && reports.length > 0) {
          const emptyNameCodes = [...new Set(
            reports.filter((r: any) => !r.product_name && r.product_code).map((r: any) => r.product_code)
          )];
          
          if (emptyNameCodes.length > 0) {
            const { data: products } = await supabase
              .from("product_cache")
              .select("product_code, product_name, product_spec, manufacturer")
              .in("product_code", emptyNameCodes);
            
            if (products && products.length > 0) {
              const nameMap: Record<string, any> = {};
              products.forEach((p: any) => { nameMap[p.product_code] = p; });
              
              reports.forEach((r: any) => {
                if (!r.product_name && r.product_code && nameMap[r.product_code]) {
                  r.product_name = nameMap[r.product_code].product_name;
                  if (!r.specification) r.specification = nameMap[r.product_code].product_spec;
                  if (!r.manufacturer) r.manufacturer = nameMap[r.product_code].manufacturer;
                }
              });
            }
          }
        }
        
        result = reports || [];
        break;
      }

      case "insert_report": {
        const reportData = params as Record<string, unknown>;
        delete (reportData as Record<string, unknown>).action;
        
        // ========== 需求为 0 修复 Part 1: 后端 demand_quantity 校验（2026-11-07 新增）==========
        const rawDemand = reportData.demand_quantity;
        const demandQty = typeof rawDemand === 'number' ? rawDemand : Number(rawDemand);
        if (!Number.isFinite(demandQty) || demandQty <= 0) {
          return new Response(JSON.stringify({
            success: false,
            error: `需求数量必须大于 0（当前值: ${rawDemand}）`
          }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        (reportData as any).demand_quantity = demandQty; // 规范化
        
        const storeId = reportData.store_id as string;
        const productCode = reportData.product_code as string;
        
        // 重复上报检测（同门店+同商品，一周期只允许一次：存在未完成上报即拦截）
        if (storeId && productCode && reportData.order_type === '缺货订购') {
          const { data: existing } = await supabase
            .from("reports")
            .select("id, replenish_status, created_at, settled_at")
            .eq("store_id", storeId)
            .eq("product_code", productCode)
            .eq("order_type", "缺货订购")
            .neq("replenish_status", "已完成")
            .is("settled_at", null)
            .order("created_at", { ascending: false })
            .limit(1);

          if (existing && existing.length > 0) {
            const prev = existing[0];
            return new Response(JSON.stringify({
              success: false, 
              error: "该商品已于 " + formatDate(prev.created_at) + " 上报过，状态为「" + (prev.replenish_status || '待处理') + "」，本周期请勿重复上报"
            }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
        
        // A：补全商品基础信息——用 product_cache 的标准名称(FullName)覆盖，
        // 堵住门店端旧缓存带来的「品名(品牌)」后缀（如「阿莫西林胶囊（葵花）」）
        if (reportData.order_type === '缺货订购' && productCode) {
          try {
            const { data: pInfo } = await supabase
              .from("product_cache")
              .select("product_name, product_spec, manufacturer")
              .eq("product_code", productCode)
              .maybeSingle();
            if (pInfo) {
              if (pInfo.product_name) (reportData as any).product_name = pInfo.product_name;
              if (pInfo.product_spec) (reportData as any).specification = pInfo.product_spec;
              if (pInfo.manufacturer) (reportData as any).manufacturer = pInfo.manufacturer;
            }
          } catch (_) { /* 补全失败不阻断，保留门店原值 */ }
        }

        // v4.0：门店上报初始状态统一为待处理（同步采购计划时自动检测是否已完成）
        (reportData as any).replenish_status = "待处理";
        
        const { data: inserted, error } = await supabase
          .from("reports")
          .insert([reportData])
          .select();
        
        if (error) throw error;
        result = { inserted: true, data: inserted?.[0] };
        break;
      }

      case "get_my_reports": {
        // 获取门店自己的上报记录（用于历史记录页面）
        const { store_id } = params;
        const validStoreId = validateInput(store_id, "门店ID", 50);
        const { data: reports, error } = await supabase
          .from("reports")
          .select("*")
          .eq("store_id", validStoreId)
          .order("created_at", { ascending: false });
        
        if (error) throw error;
        
        // 关键：以 Supabase 为数据源，SQL Server 仅作为兜底
        // 原因：智能回退（已到货→待处理）只更新 Supabase，不更新 SQL Server，
        //      如果用 SQL Server 覆盖会导致门店看到旧的"已到货/已完成"状态，与管理后台不一致
        let finalReports = reports || [];
        if (finalReports.length > 0) {
          // 1. 优先使用 Supabase 已有的状态
          finalReports = finalReports.map(r => ({
            ...r,
            replenish_status: r.replenish_status || "待处理"
          }));
          
          // 2. [v3.20+ 完全废弃] SQL Server Shortage_OrderFeedback 兜底逻辑
          //    根因：Shortage_OrderFeedback 是商品级别的旧状态，不区分 report 级别的 FIFO 精确判定
          //    scheduled-task v3.20 FIFO 跑过后，report 级状态才是真值；
          //    而 SQL Server 商品级旧状态会把"正确的待处理"错误覆盖成商品级的"已订购"
          //    → 典型表现：门店端显示"已订购"，admin 后台显示"待处理"（同一条 report）
          //    修复：直接以 Supabase report 表状态为唯一数据源，彻底删除 SQL Server 兜底
          console.log("[get_my_reports] v3.20+ 跳过 SQL Server Shortage_OrderFeedback 兜底，使用 Supabase 精确状态");
        }
        
        result = finalReports;
        break;
      }

      case "list_stores": {
        // 获取所有门店列表（用于管理后台-门店管理）
        // 先查询所有门店账号（从 admin_users 表）
        const { data: adminUsers } = await supabase
          .from("admin_users")
          .select("username, is_active, role")
          .eq("role", "store")
          .order("username");
        
        // 再查询设备记录（用于获取登录时间）
        const { data: devices } = await supabase
          .from("store_authorized_devices")
          .select("username, is_active, last_login_at");
        
        console.log("[list_stores] admin_users 门店账号数量:", adminUsers?.length || 0);
        console.log("[list_stores] store_authorized_devices 设备记录数量:", devices?.length || 0);
        
        // 合并数据
        const storeMap: Record<string, { username: string; last_login_at: string | null; is_active: boolean }> = {};
        
        // 1. 添加所有门店账号（无论是否有设备记录）
        if (adminUsers) {
          for (const u of adminUsers) {
            storeMap[u.username] = { 
              username: u.username, 
              last_login_at: null, 
              is_active: u.is_active 
            };
          }
        }
        
        // 2. 更新登录时间（如果有设备记录）
        if (devices) {
          for (const d of devices) {
            const name = d.username;
            if (!name) continue;
            if (storeMap[name]) {
              // 如果有更晚的登录时间，更新
              if (d.last_login_at && (!storeMap[name].last_login_at || d.last_login_at > storeMap[name].last_login_at!)) {
                storeMap[name].last_login_at = d.last_login_at;
              }
              // 更新 is_active 为设备的状态（如果设备是 active）
              if (d.is_active) {
                storeMap[name].is_active = true;
              }
            }
          }
        }
        
        const resultArray = Object.values(storeMap).sort((a, b) => a.username.localeCompare(b.username));
        console.log("[list_stores] 最终返回门店数量:", resultArray.length);
        console.log("[list_stores] 最终返回门店列表:", JSON.stringify(resultArray));
        
        result = resultArray;
        break;
      }

      case "get_audit_log": {
        // 获取操作日志（同步日志 + 授权操作等）
        const limit = Math.min(params.limit || 50, 200);
        
        // 1. 获取同步日志
        const { data: syncLogs, error: syncError } = await supabase
          .from("sync_log_table")
          .select("*")
          .order("sync_time", { ascending: false })
          .limit(limit);
        
        if (syncError) throw syncError;

        // 2. 组合结果，统一格式
        const logs = (syncLogs || []).map(log => ({
          time: log.sync_time,
          user: log.sync_type || 'system',
          action: log.status === 'success' ? '数据同步' : '同步异常',
          detail: log.detail || ''
        }));

        result = logs;
        break;
      }

      // ========== 管理员子账号管理 ==========
      case "list_admin_users": {
        const { data, error } = await supabase
          .from("admin_users")
          .select("id, username, name, role, permissions, is_active, created_at, updated_at")
          .order("created_at", { ascending: false });
        if (error) throw error;
        result = data || [];
        break;
      }

      case "add_admin_user": {
        const { username, password, name, role, permissions, created_by } = params;
        const validUsername = validateInput(username, "用户名", 50);
        const validPassword = validateInput(password, "密码", 100);
        const validName = validateInput(name || username, "姓名", 50);
        const validRole = (role === 'super_admin' || role === 'admin' || role === 'viewer') ? role : 'viewer';

        if (!validUsername) throw new Error("用户名不能为空");
        if (!validPassword || validPassword.length < 6) throw new Error("密码至少6位");

        // 1. 在 auth.users 中创建用户
        const email = validUsername + '@wszh.com';
        console.log("[admin] 创建用户:", email);
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
          email: email,
          password: validPassword,
          email_confirm: true
        });
        if (authError) {
          console.error("[admin] 创建auth用户失败:", authError);
          throw new Error('创建用户失败: ' + authError.message);
        }
        if (!authData || !authData.user || !authData.user.id) {
          console.error("[admin] authData结构异常:", authData);
          throw new Error('创建用户失败: auth服务返回异常');
        }
        const newUserId = authData.user.id;
        console.log("[admin] auth用户创建成功, id:", newUserId);

        // 2. 在 admin_users 表中创建记录
        const insertPayload = {
          user_id: newUserId,
          username: validUsername,
          name: validName,
          role: validRole,
          permissions: permissions || {},
          is_active: true,
          created_by: created_by || null
        };
        console.log("[admin] 插入admin_users:", insertPayload);
        const { data: newAdmin, error: insertError } = await supabase
          .from("admin_users")
          .insert([insertPayload])
          .select()
          .single();
        if (insertError) {
          console.error("[admin] 插入admin_users失败:", insertError);
          // 回滚：删除已创建的 auth 用户
          try {
            await supabase.auth.admin.deleteUser(newUserId);
          } catch (delErr) {
            console.error("[admin] 回滚删除auth用户失败:", delErr);
          }
          throw new Error('创建管理员记录失败: ' + insertError.message + ' (可能admin_users表未创建)');
        }
        result = newAdmin;
        break;
      }

      case "update_admin_user": {
        const { id, name, role, permissions } = params;
        if (!id) throw new Error("缺少ID参数");
        const updateObj: Record<string, unknown> = {};
        if (name !== undefined) updateObj.name = name;
        if (role !== undefined) {
          updateObj.role = (role === 'super_admin' || role === 'admin' || role === 'viewer') ? role : 'viewer';
        }
        if (permissions !== undefined) updateObj.permissions = permissions;
        updateObj.updated_at = new Date().toISOString();

        const { data, error } = await supabase
          .from("admin_users")
          .update(updateObj)
          .eq("id", id)
          .select()
          .single();
        if (error) throw error;
        result = data;
        break;
      }

      case "toggle_admin_user": {
        const { id, is_active } = params;
        if (!id) throw new Error("缺少ID参数");
        const { data, error } = await supabase
          .from("admin_users")
          .update({ is_active: is_active, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();
        if (error) throw error;
        result = data;
        break;
      }

      case "delete_admin_user": {
        const { id } = params;
        if (!id) throw new Error("缺少ID参数");
        // 先查 user_id，然后删除 auth 用户
        const { data: adminRecord } = await supabase
          .from("admin_users")
          .select("user_id")
          .eq("id", id)
          .single();
        if (adminRecord && adminRecord.user_id) {
          await supabase.auth.admin.deleteUser(adminRecord.user_id);
        }
        const { error } = await supabase
          .from("admin_users")
          .delete()
          .eq("id", id);
        if (error) throw error;
        result = { success: true, message: "已删除" };
        break;
      }

      case "log_admin_action": {
        // 管理员操作日志（静默记录，不阻塞主流程）
        const { user: logUser, action: logAction, detail: logDetail } = params;
        console.log(`[admin_log] ${logUser} - ${logAction} ${logDetail || ''}`);
        result = { success: true };
        break;
      }

      case "get_approvals": {
        const { data: approvals, error } = await supabase
          .from("report_approvals")
          .select("*")
          .order("created_at", { ascending: false });
        if (error) throw error;
        result = approvals || [];
        break;
      }

      // ========== 门店通知中心 ==========
      case "get_store_notifications": {
        // 拉取本店通知 + 产品详情 + 需求数量 + 排除已完成
        const { store_id: nsid, only_unread, limit: nlimit } = params;
        if (!nsid) { result = { notifications: [], unread_count: 0 }; break; }
        let q = supabase
          .from("store_notifications")
          .select("*")
          .eq("store_id", nsid)
          .order("created_at", { ascending: false })
          .limit(Math.min(nlimit || 50, 100));
        if (only_unread) q = q.eq("is_read", false);
        const { data: notifs, error: nerr } = await q;
        if (nerr) throw nerr;
        const list = notifs || [];
        
        // 如果没有通知，直接返回
        if (list.length === 0) { result = { notifications: [], unread_count: 0 }; break; }
        
        // 收集所有 product_code
        const codes = [...new Set(list.map((n: any) => n.product_code).filter(Boolean))];
        
        // 批量查 product_cache 获取品名/规格/厂家
        const prodMap: Record<string, any> = {};
        if (codes.length > 0) {
          const { data: products } = await supabase
            .from("product_cache")
            .select("product_code, product_name, product_spec, manufacturer")
            .in("product_code", codes);
          (products || []).forEach((p: any) => { prodMap[p.product_code] = p; });
        }
        
        // 批量查 reports 获取需求数量 + 排除已完成
        const reportMap: Record<string, { demand_quantity: number, is_completed: boolean }> = {};
        if (codes.length > 0) {
          const { data: reportData } = await supabase
            .from("reports")
            .select("product_code, demand_quantity, replenish_status")
            .eq("store_id", nsid)
            .eq("order_type", "缺货订购")
            .in("product_code", codes);
          (reportData || []).forEach((r: any) => {
            const key = r.product_code;
            if (!reportMap[key] || r.replenish_status === '已完成') {
              reportMap[key] = {
                demand_quantity: r.demand_quantity || 0,
                is_completed: r.replenish_status === '已完成'
              };
            }
          });
        }
        
        // 过滤已完成 + 丰富数据
        const enriched = list
          .filter((n: any) => {
            const rd = reportMap[n.product_code];
            return !rd || !rd.is_completed; // 该商品还没完成才显示
          })
          .map((n: any) => {
            const p = prodMap[n.product_code] || {};
            const rd = reportMap[n.product_code] || { demand_quantity: 0 };
            return {
              id: n.id, store_id: n.store_id, product_code: n.product_code,
              message: n.message, is_read: n.is_read, created_at: n.created_at,
              product_name: (p.product_name || '').trim(),
              product_spec: (p.product_spec || '').trim(),
              manufacturer: (p.manufacturer || '').trim(),
              demand_qty: rd.demand_quantity
            };
          });

        // 去重：每个 product_code 只保留最新一条（list 已按 created_at desc 排序）
        const seen = new Set<string>();
        const deduped: any[] = [];
        for (const n of enriched) {
            if (!n.product_code || seen.has(n.product_code)) continue;
            seen.add(n.product_code);
            deduped.push(n);
        }
        if (enriched.length !== deduped.length) {
            console.log(`[NotifDedup] ${enriched.length} → ${deduped.length} 条`);
        }

        result = { notifications: deduped, unread_count: deduped.filter((n: any) => !n.is_read).length };
        break;
      }

      case "mark_notification_read": {
        // 标记已读：支持单条（id）、全部（all=true）、只标未读
        const { store_id: msid, id: mid, all: mall, only_unread: monly } = params;
        if (!msid) { result = { marked: 0 }; break; }
        let uq = supabase.from("store_notifications")
          .update({ is_read: true })
          .eq("store_id", msid);
        if (mid !== undefined && mid !== null) uq = uq.eq("id", mid);
        else if (mall || monly) uq = uq.eq("is_read", false);
        const { data, error: merr } = await uq.select("id");
        if (merr) throw merr;
        result = { marked: (data || []).length };
        break;
      }


      case "approve_report": {
        const { product_code: apc, status: aps, reason: apr, operator: apo } = params;
        const { error } = await supabase
          .from("report_approvals")
          .upsert({
            product_code: apc,
            status: aps,
            reason: apr || '',
            operator: apo || '管理员',
            updated_at: new Date().toISOString()
          }, { onConflict: 'product_code' });
        if (error) throw error;
        result = { success: true, message: `已${aps}` };
        break;
      }

      case "delete_new_product": {
        const { product_code: dpc, operator: dpo } = params;
        const { error } = await supabase
          .from("reports")
          .delete()
          .eq("product_code", dpc)
          .eq("order_type", "新品订购");
        if (error) throw error;
        result = { success: true, message: "已删除" };
        break;
      }

      // v5.8.1+ 健康检查 + 预热（页面加载时调用，提前初始化 Deno isolate + SQL 连接池）
      case "ping": {
        try {
          const pool = await getPool();
          releasePool(pool);
          result = { pong: true, version: "5.8.1", warmed: true };
        } catch (e) {
          result = { pong: false, version: "5.8.1", error: String(e) };
        }
        break;
      }

      // 【临时】查 SQL Server 存储过程定义（诊断用，用完删除）
      case "debug_sproc": {
        const sproc_name = params?.name as string;
        const pool = await getPool();
        try {
          const q = `
            SELECT 
              OBJECT_DEFINITION(OBJECT_ID('dbo.${sproc_name.replace(/'/g, "''")}')) AS definition,
              OBJECT_NAME(OBJECT_ID('dbo.${sproc_name.replace(/'/g, "''")}')) AS name,
              SCHEMA_NAME(OBJECT_SCHEMA_ID(OBJECT_ID('dbo.${sproc_name.replace(/'/g, "''")}'))) AS schema_name
          `;
          const r = await pool.request().query(q);
          if (r.recordset?.length > 0) {
            result = { success: true, name: r.recordset[0].name, schema: r.recordset[0].schema_name, definition: r.recordset[0].definition };
          } else {
            result = { success: false, error: '存储过程不存在' };
          }
        } finally { releasePool(pool); }
        break;
      }

      // ========== 只读试算：配送口径升级 v2（纯 SQL 聚合，一次搞定）==========
      // 统计所有 replenish_status='已完成' 的 reports，按配送口径重新算一遍
      // 只读，不 UPDATE
      case "debug_delivery_audit": {
        try {
        const pool = await getPool();
        try {
          // 1. 从 Supabase 拉所有 replenish_status='已完成' 的 reports
          const { data: completedReports, error } = await supabase
            .from("reports")
            .select("id, product_code, store_id, store_name, demand_quantity, created_at, replenish_status, status_remark")
            .eq("replenish_status", "已完成")
            .eq("order_type", "缺货订购")
            .gt("demand_quantity", 0)
            .order("created_at", { ascending: false });
          
          if (error) { result = { success: false, error: 'Supabase查询失败: ' + error.message }; break; }
          
          const total = completedReports?.length || 0;
          if (total === 0) { result = { success: true, summary: { total_completed_reports: 0, to_upgrade: 0, to_stay: 0 } }; break; }
          
          // 2. 构建 Supabase→SQL Server 的映射
          //    每条 report → (prec, krec, since_bj, demand, report_id, store_name)
          //    prec = Vptype.rec（商品在 SQL Server 的主键）
          //    krec = 门店在 SQL Server 的主键
          type AuditRow = { prec: number; krec: string; since: string; demand: number; report_id: string; store_name: string; product_code: string };
          const auditRows: AuditRow[] = [];
          
          for (const r of (completedReports || [])) {
            if (!r.product_code || !r.store_name) continue;
            const krec = STORE_KREC_MAP[r.store_name];
            if (!krec) continue;
            const created = new Date(r.created_at);
            const bjMs = created.getTime() + 8 * 3600 * 1000;
            const bjDate = new Date(bjMs);
            const since = `${bjDate.getUTCFullYear()}-${String(bjDate.getUTCMonth()+1).padStart(2,'0')}-${String(bjDate.getUTCDate()).padStart(2,'0')}`;
            auditRows.push({
              prec: 0, // 先占位，后面查
              krec: krec,
              since: since,
              demand: Number(r.demand_quantity) || 0,
              report_id: r.id,
              store_name: r.store_name,
              product_code: r.product_code
            });
          }
          
          // 3. 查所有商品编码对应的 prec（Vptype.rec）
          const codes = [...new Set(auditRows.map(a => a.product_code))];
          const precMap: Record<string, number> = {};
          for (let i = 0; i < codes.length; i += 400) {
            const batch = codes.slice(i, i + 500);
            const req = pool.request();
            const ph = batch.map((c, idx) => { req.input(`c${idx}`, sql.NVarChar(50), c); return `@c${idx}`; }).join(',');
            const res = await req.query(`SELECT usercode, rec FROM ZHYYLS.dbo.Vptype WITH(NOLOCK) WHERE usercode IN (${ph})`);
            (res.recordset || []).forEach((r: any) => { precMap[r.usercode] = Number(r.rec); });
          }
          // 回填 prec
          for (const a of auditRows) { a.prec = precMap[a.product_code] || 0; }
          const mappedRows = auditRows.filter(a => a.prec > 0);
          
          // 4. 构建一条大 SQL：创建 #AUDIT 临时表 + JOIN 配送中心出库单算配送量
          //    分批插入（每批 400 行 × 4 参数 = 1600 < 2100）
          let fullRes: any[] = [];
          const BATCH_SIZE = 400;
          for (let i = 0; i < mappedRows.length; i += BATCH_SIZE) {
            const batch = mappedRows.slice(i, i + BATCH_SIZE);
            const req = pool.request();
            const vals: string[] = [];
            batch.forEach((a, idx) => {
              req.input(`p${idx}`, sql.Int, a.prec);
              req.input(`k${idx}`, sql.NVarChar(10), a.krec);
              req.input(`s${idx}`, sql.VarChar(10), a.since);
              req.input(`d${idx}`, sql.Int, a.demand);
              vals.push(`(@p${idx}, @k${idx}, @s${idx}, @d${idx})`);
            });
            const q = `
              CREATE TABLE #AUDIT (prec INT, krec NVARCHAR(10), since VARCHAR(10), demand INT);
              INSERT INTO #AUDIT (prec, krec, since, demand) VALUES ${vals.join(',')};
              SELECT a.prec, a.krec, a.since, a.demand,
                     ISNULL(SUM(ABS(v.Qty)), 0) as delivered_qty
              FROM #AUDIT a
              LEFT JOIN ZHYYLS.dbo.vBuySendSumDetail v WITH(NOLOCK)
                ON v.PRec = a.prec AND v.InKRec = a.krec AND v.OutKRec = '3'
                AND v.BillDate >= a.since
                AND (v.Comment IS NULL OR v.Comment NOT LIKE '%调货出库单%')
              GROUP BY a.prec, a.krec, a.since, a.demand;
              DROP TABLE #AUDIT;
            `;
            const res = await req.query(q);
            fullRes = fullRes.concat(res.recordset || []);
          }
          
          // 5. 匹配回 report（用 prec+krec+since+demand 四元组，同一个 report 是唯一的）
          //    但要注意：同 (prec, krec) 可能有多个不同 since 的 report
          //    所以用 (prec, krec, since, demand) 匹配
          const resultMap = new Map<string, number>();
          for (const row of fullRes) {
            const key = `${row.prec}|${row.krec}|${row.since}|${row.demand}`;
            resultMap.set(key, Number(row.delivered_qty));
          }
          
          const toUpgrade: Array<any> = []; // 配送≥需求
          const toStay: Array<any> = [];   // 配送<需求
          
          for (const a of mappedRows) {
            const key = `${a.prec}|${a.krec}|${a.since}|${a.demand}`;
            const delivered = resultMap.get(key) ?? 0;
            const row = {
              store_name: a.store_name,
              product_code: a.product_code,
              demand: a.demand,
              delivered: delivered,
              since: a.since,
              report_id: a.report_id
            };
            if (delivered >= a.demand && a.demand > 0) {
              toUpgrade.push(row);
            } else {
              toStay.push(row);
            }
          }
          
          // 6. 返回结果
          result = {
            success: true,
            summary: {
              total_completed_reports: total,
              mapped_to_prec_krec: mappedRows.length,
              skipped_no_prec: auditRows.length - mappedRows.length,
              to_upgrade: toUpgrade.length,
              to_stay: toStay.length,
              anchor_logic: '配送中心出库单(vBuySendSumDetail OutKRec=3→InKRec=门店KRec 排除调货出库单 BillDate>=created_at北京时间)',
              delivered_sql: `SELECT ISNULL(SUM(ABS(v.Qty)),0) FROM ZHYYLS.dbo.vBuySendSumDetail v WHERE v.PRec=@prec AND v.InKRec=@krec AND v.OutKRec='3' AND v.BillDate>=@since AND (v.Comment IS NULL OR v.Comment NOT LIKE '%调货出库单%')`
            },
            sample_upgrade: toUpgrade.slice(0, 5).map(r => ({
              store_name: r.store_name, product_code: r.product_code,
              demand: r.demand, delivered: r.delivered, since: r.since,
              before: '已完成（显示为已入库）', after: '已配送（显示为已完成）'
            })),
            sample_stay: toStay.slice(0, 3).map(r => ({
              store_name: r.store_name, product_code: r.product_code,
              demand: r.demand, delivered: r.delivered, since: r.since,
              reason: '配送量不足'
            }))
          };
        } catch (innerErr: any) {
          result = { success: false, error: '内部异常: ' + (innerErr?.message || String(innerErr)) + '\n' + (innerErr?.stack || '') };
        } finally { try { releasePool(pool); } catch(_) {} }
        } catch (outerErr: any) {
          result = { success: false, error: '外部异常: ' + (outerErr?.message || String(outerErr)) };
        }
        break;
      }
      // ========== 写操作：配送口径升级（自动判定 replenish_status='已配送'）==========
      // 条件：配送中心出库单(vBuySendSumDetail) 配送量 ≥ 需求数量
      // 只读 ZHYYLS，只写 Supabase reports 表
      // 支持分页：reqBody.max_records（默认 200）、reqBody.offset（默认 0）
      // 返回 has_more / next_offset 供调用方循环
      case "upgrade_to_delivered": {
        try {
        const pool = await getPool();
        try {
          // 兼容两种调用方：定时任务（扁平 body）和前端（body.params）
          const _p = params || {};
          const MAX_RECORDS = Math.min(
            Math.max(1, Number(_p.max_records ?? reqBody?.max_records) || 200),
            500  // 硬上限，防止爆
          );
          const OFFSET = Math.max(0, Number(_p.offset ?? reqBody?.offset) || 0);

          // 1. 从 Supabase 分页拉 replenish_status='已完成' 的 reports
          const { data: completedReports, error } = await supabase
            .from("reports")
            .select("id, product_code, store_id, store_name, demand_quantity, created_at, replenish_status, status_remark")
            .eq("replenish_status", "已完成")
            .eq("order_type", "缺货订购")
            .gt("demand_quantity", 0)
            .order("created_at", { ascending: false })
            .range(OFFSET, OFFSET + MAX_RECORDS - 1);
          
          if (error) { result = { success: false, error: 'Supabase查询失败: ' + error.message }; break; }
          
          const total = completedReports?.length || 0;
          if (total === 0) {
            result = { success: true, upgraded: 0, message: '无可升级的已完成记录', has_more: false, next_offset: OFFSET };
            break;
          }
          
          // 2. 构建 Supabase→SQL Server 的映射
          type UpgradeRow = { prec: number; krec: string; since: string; demand: number; report_id: string; store_name: string; product_code: string };
          const upgradeRows: UpgradeRow[] = [];
          
          for (const r of (completedReports || [])) {
            if (!r.product_code || !r.store_name) continue;
            const krec = STORE_KREC_MAP[r.store_name];
            if (!krec) continue;
            const created = new Date(r.created_at);
            const bjMs = created.getTime() + 8 * 3600 * 1000;
            const bjDate = new Date(bjMs);
            const since = `${bjDate.getUTCFullYear()}-${String(bjDate.getUTCMonth()+1).padStart(2,'0')}-${String(bjDate.getUTCDate()).padStart(2,'0')}`;
            upgradeRows.push({
              prec: 0,
              krec: krec,
              since: since,
              demand: Number(r.demand_quantity) || 0,
              report_id: r.id,
              store_name: r.store_name,
              product_code: r.product_code
            });
          }
          
          // 3. 查所有商品编码对应的 prec
          const codes = [...new Set(upgradeRows.map(a => a.product_code))];
          const precMap: Record<string, number> = {};
          for (let i = 0; i < codes.length; i += 400) {
            const batch = codes.slice(i, i + 500);
            const req = pool.request();
            const ph = batch.map((c, idx) => { req.input(`c${idx}`, sql.NVarChar(50), c); return `@c${idx}`; }).join(',');
            const res = await req.query(`SELECT usercode, rec FROM ZHYYLS.dbo.Vptype WITH(NOLOCK) WHERE usercode IN (${ph})`);
            (res.recordset || []).forEach((r: any) => { precMap[r.usercode] = Number(r.rec); });
          }
          for (const a of upgradeRows) { a.prec = precMap[a.product_code] || 0; }
          const mappedRows = upgradeRows.filter(a => a.prec > 0);
          
          // 4. 分批查配送量
          let fullRes: any[] = [];
          const BATCH_SIZE = 400;
          for (let i = 0; i < mappedRows.length; i += BATCH_SIZE) {
            const batch = mappedRows.slice(i, i + BATCH_SIZE);
            const req = pool.request();
            const vals: string[] = [];
            batch.forEach((a, idx) => {
              req.input(`p${idx}`, sql.Int, a.prec);
              req.input(`k${idx}`, sql.NVarChar(10), a.krec);
              req.input(`s${idx}`, sql.VarChar(10), a.since);
              req.input(`d${idx}`, sql.Int, a.demand);
              vals.push(`(@p${idx}, @k${idx}, @s${idx}, @d${idx})`);
            });
            const q = `
              CREATE TABLE #AUDIT (prec INT, krec NVARCHAR(10), since VARCHAR(10), demand INT);
              INSERT INTO #AUDIT (prec, krec, since, demand) VALUES ${vals.join(',')};
              SELECT a.prec, a.krec, a.since, a.demand,
                     ISNULL(SUM(ABS(v.Qty)), 0) as delivered_qty
              FROM #AUDIT a
              LEFT JOIN ZHYYLS.dbo.vBuySendSumDetail v WITH(NOLOCK)
                ON v.PRec = a.prec AND v.InKRec = a.krec AND v.OutKRec = '3'
                AND v.BillDate >= a.since
                AND (v.Comment IS NULL OR v.Comment NOT LIKE '%调货出库单%')
              GROUP BY a.prec, a.krec, a.since, a.demand;
              DROP TABLE #AUDIT;
            `;
            const res = await req.query(q);
            fullRes = fullRes.concat(res.recordset || []);
          }
          
          // 5. 匹配回 report，找出该升级的
          const resultMap = new Map<string, number>();
          for (const row of fullRes) {
            const key = `${row.prec}|${row.krec}|${row.since}|${row.demand}`;
            resultMap.set(key, Number(row.delivered_qty));
          }
          
          const toUpgrade: string[] = [];
          const toStay: Array<any> = [];
          
          for (const a of mappedRows) {
            const key = `${a.prec}|${a.krec}|${a.since}|${a.demand}`;
            const delivered = resultMap.get(key) ?? 0;
            if (delivered >= a.demand && a.demand > 0) {
              toUpgrade.push(a.report_id);
            } else {
              toStay.push({ store: a.store_name, code: a.product_code, demand: a.demand, delivered, report_id: a.report_id });
            }
          }
          
          // 6. 执行批量 UPDATE（只写 Supabase）
          let upgraded = 0;
          if (toUpgrade.length > 0) {
            const UPGRADE_BATCH = 500;
            for (let i = 0; i < toUpgrade.length; i += UPGRADE_BATCH) {
              const batchIds = toUpgrade.slice(i, i + UPGRADE_BATCH);
              const { error: uErr } = await supabase
                .from("reports")
                .update({
                  replenish_status: "已配送",
                  status_changed_by: "系统自动",
                  status_remark: "自动升级为已配送（配送≥需求）"
                })
                .in("id", batchIds);
              if (uErr) {
                result = { success: false, error: 'UPDATE失败: ' + uErr.message };
                break;
              }
              upgraded += batchIds.length;
            }
          }
          
          // 7. 返回结果（含分页游标）
          // has_more: 本页拉满了 MAX_RECORDS，理论上后面还有
          const has_more = total >= MAX_RECORDS;
          const next_offset = OFFSET + total;
          result = {
            success: true,
            total_completed: total,
            mapped: mappedRows.length,
            skipped_no_prec: upgradeRows.length - mappedRows.length,
            to_upgrade: toUpgrade.length,
            actually_upgraded: upgraded,
            to_stay: toStay.length,
            sample_stay: toStay.slice(0, 5),
            // 分页控制（给循环调用方用）
            has_more,
            next_offset,
            page_offset: OFFSET,
            page_size: MAX_RECORDS
          };
        } catch (innerErr: any) {
          result = { success: false, error: '内部异常: ' + (innerErr?.message || String(innerErr)) };
        } finally { try { releasePool(pool); } catch(_) {} }
        } catch (outerErr: any) {
          result = { success: false, error: '外部异常: ' + (outerErr?.message || String(outerErr)) };
        }
        break;
      }
      // ========== DEBUG: 查单/多商品采购入库明细（vBuySendSumDetail）==========
      case "debug_purchase_trace": {
        const codesRaw = params?.codes as string[] | string | undefined;
        const codes = Array.isArray(codesRaw) ? codesRaw : (codesRaw ? [codesRaw] : []);
        if (codes.length === 0) { result = { success: false, error: 'codes 必填' }; break; }
        const pool = await getPool();
        try {
          const codesList = codes.map(c => `N'${(c || '').replace(/'/g, "''")}'`).join(',');
          const q = `
            SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
            FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
            JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
            WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesList})
            ORDER BY v.usercode, vs.BillDate
          `;
          const res = await pool.request().query(q);
          const records = (res.recordset || []).map((r: any) => ({
            product_code: (r.usercode || '').trim(),
            bill_date: r.BillDate,
            qty: Number(r.qty || 0)
          }));
          // 按 product_code 分组汇总
          const byCode: Record<string, Array<any>> = {};
          let totalByCode: Record<string, number> = {};
          for (const rec of records) {
            if (!byCode[rec.product_code]) { byCode[rec.product_code] = []; totalByCode[rec.product_code] = 0; }
            byCode[rec.product_code].push(rec);
            totalByCode[rec.product_code] += rec.qty;
          }
          result = { success: true, codes, records, byCode, totalByCode };
        } catch (e: any) {
          result = { success: false, error: e?.message || String(e) };
        } finally { releasePool(pool); }
        break;
      }
      // ========== DEBUG: 回退指定 ID 到待处理（临时用）==========
      case "debug_reset_ids": {
        const idsRaw = params?.ids;
        const ids = Array.isArray(idsRaw) ? idsRaw : [];
        if (ids.length === 0) { result = { success: false, error: 'ids 必填' }; break; }
        const { error } = await supabase.from("reports").update({
          replenish_status: '待处理',
          status_remark: null,
          status_changed_at: new Date().toISOString(),
          status_changed_by: '系统自动(回退FIFO错判)'
        }).in('id', ids);
        if (error) { result = { success: false, error: error.message }; break; }
        result = { success: true, reset_count: ids.length, ids };
        break;
      }
      // ========== DEBUG: 公开版批量重跑 FIFO（手动触发一次）==========
      case "debug_bulk_detect": {
        try {
          const pool = await getPool();
          const res = await preciseAutoDetectStatusV2(pool, supabase);
          result = { success: true, ...res };
        } catch (e: any) {
          result = { success: false, error: e?.message || String(e), stack: e?.stack };
        }
        break;
      }
      // ========== DEBUG: 精确版——按当前 status 分类统计 FIFO 影响范围 ==========
      // 与 debug_fifo_full_compare 不同：这里把每条的"旧口径扣的采购单明细"也列出来
      case "debug_fifo_precise_compare": {
        const supabaseCl = supabase;
        const pool = await getPool();
        try {
          const targetStatus = params?.status;  // null=全量, 传入字符串=只拉某状态
          let q = supabaseCl.from("reports")
            .select("id, product_code, store_name, demand_quantity, created_at, replenish_status, product_name")
            .eq("order_type", "缺货订购").gt("demand_quantity", 0);
          if (targetStatus) q = q.eq("replenish_status", targetStatus);
          const { data: allReports, error: qErr } = await q.limit(2000);
          if (qErr) throw qErr;

          const codes = [...new Set((allReports || []).map(r => r.product_code).filter(Boolean))];
          const codesList = codes.map(c => `N'${(c || '').replace(/'/g, "''")}'`).join(',');
          const purchaseRes = await pool.request().query(`
            SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
            FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
            JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
            WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesList})
          `);
          let purchaseByCode: Record<string, Array<{ date: any; qty: number }>> = {};
          for (const row of purchaseRes.recordset || []) {
            const r = row as any;
            if (!purchaseByCode[r.usercode]) purchaseByCode[r.usercode] = [];
            purchaseByCode[r.usercode].push({ date: r.BillDate, qty: Number(r.qty || 0) });
          }

          // 旧 FIFO：与原代码完全一致（历史池 > + 当天池 ==），返回每条完成 report 消耗的采购单明细
          function oldFifoDetail(purchaseSorted: any[], sortedReports: any[]): { done: string[]; consumed: Record<string, string[]> } {
            if (sortedReports.length === 0) return { done: [], consumed: {} };
            const earliestAnchorBj = toBjDate(sortedReports[0].created_at);
            const hist = purchaseSorted.filter(p => p.bill_date_bj > earliestAnchorBj).map(p => ({ ...p, remain: p.qty }));
            const same = purchaseSorted.filter(p => p.bill_date_bj === earliestAnchorBj).map(p => ({ ...p, remain: p.qty }));
            let histRemain = hist.reduce((s, e) => s + e.remain, 0);
            let sameRemain = same.reduce((s, e) => s + e.remain, 0);
            const consumed: Record<string, string[]> = {};
            const allDone: string[] = [];
            for (const r of sortedReports) {
              const demand = Number(r.demand_quantity) || 0;
              if (histRemain >= demand) {
                let need = demand; const used: string[] = [];
                for (const e of hist) { if (need <= 0) break; const take = Math.min(e.remain, need); if (take > 0) used.push(`${e.bill_date_bj}×${take}`); e.remain -= take; histRemain -= take; need -= take; }
                allDone.push(r.id); consumed[r.id] = used;
              } else if (histRemain + sameRemain >= demand) {
                let need = demand; const used: string[] = [];
                for (const e of hist) { if (need <= 0) break; const take = Math.min(e.remain, need); if (take > 0) used.push(`${e.bill_date_bj}×${take}`); e.remain -= take; histRemain -= take; need -= take; }
                for (const e of same) { if (need <= 0) break; const take = Math.min(e.remain, need); if (take > 0) used.push(`${e.bill_date_bj}×${take}`); e.remain -= take; sameRemain -= take; need -= take; }
                allDone.push(r.id); consumed[r.id] = used;
              } else break;
            }
            return { done: allDone, consumed };
          }

          // 新 FIFO：每条独立 anchor
          function newFifoDetail(purchaseSorted: any[], sortedReports: any[]): string[] {
            if (sortedReports.length === 0) return [];
            const entries = purchaseSorted.map(p => ({ bill_date_bj: p.bill_date_bj, remain: p.qty }));
            const done: string[] = [];
            for (const r of sortedReports) {
              const d = Number(r.demand_quantity) || 0;
              const myAnchor = toBjDate(r.created_at);
              let eligibleRemain = 0;
              for (const e of entries) if (e.bill_date_bj >= myAnchor) eligibleRemain += e.remain;
              if (eligibleRemain >= d) {
                let need = d;
                for (const e of entries) { if (need <= 0) break; if (e.bill_date_bj >= myAnchor) { const take = Math.min(e.remain, need); e.remain -= take; need -= take; } }
                done.push(r.id);
              } else break;
            }
            return done;
          }

          const byCode: Record<string, any[]> = {};
          for (const r of (allReports || [])) { if (!byCode[r.product_code]) byCode[r.product_code] = []; byCode[r.product_code].push(r); }

          let s_completed = 0, s_delivered = 0, s_pending = 0, s_other = 0;
          let affected_completed = 0, affected_delivered = 0, affected_pending_wrong = 0;
          const zombieList: any[] = [];
          const affectedDetail: any[] = [];

          for (const code of codes) {
            const sorted = [...(byCode[code] || [])].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            if (sorted.length === 0) continue;
            const purchaseRows = purchaseByCode[code] || [];
            const purchaseSorted = purchaseRows.map(p => ({ bill_date_bj: toBjDate(p.date), qty: Number(p.qty || 0) })).sort((a, b) => a.bill_date_bj.localeCompare(b.bill_date_bj));

            const old = oldFifoDetail(purchaseSorted, sorted);
            const newDone = new Set(newFifoDetail(purchaseSorted, sorted));
            const oldDoneSet = new Set(old.done);

            // 僵尸 pending：最早那条 report 在新口径下都没法满足
            const earliest = sorted[0];
            const earliestAnchorBj = toBjDate(earliest.created_at);
            let earliestEligible = 0;
            for (const p of purchaseSorted) if (p.bill_date_bj >= earliestAnchorBj) earliestEligible += p.qty;
            if (earliestEligible < Number(earliest.demand_quantity)) {
              zombieList.push({ id: earliest.id, code, demand: earliest.demand_quantity, earliest_anchor_bj: earliestAnchorBj, eligible_pool_new: earliestEligible, current_status: earliest.replenish_status, store: earliest.store_name });
            }

            for (const r of sorted) {
              // 分类统计当前 status
              const cur = r.replenish_status;
              if (cur === '已完成') s_completed++;
              else if (cur === '已配送') s_delivered++;
              else if (cur === '待处理') s_pending++;
              else s_other++;

              const wasOldFifoDone = oldDoneSet.has(r.id);
              const isNewFifoDone = newDone.has(r.id);

              // 影响：旧口径判定为完成（已完成/已配送）但新口径不满足 → 应退回
              if (wasOldFifoDone && !isNewFifoDone) {
                const myAnchor = toBjDate(r.created_at);
                let myEligiblePool = 0;
                for (const p of purchaseSorted) if (p.bill_date_bj >= myAnchor) myEligiblePool += p.qty;

                if (cur === '已完成') affected_completed++;
                else if (cur === '已配送') affected_delivered++;
                else affected_pending_wrong++;

                if (affectedDetail.length < 20) {
                  affectedDetail.push({
                    id: r.id, product_code: code, product_name: r.product_name, store: r.store_name,
                    created_at_bj: myAnchor, demand: r.demand_quantity,
                    current_status: cur,
                    old_anchor_used_bj: earliestAnchorBj,
                    consumed_by_old: old.consumed[r.id] || [],
                    eligible_pool_new: myEligiblePool,
                    eligible_pool_new_detail: purchaseSorted.filter(p => p.bill_date_bj >= myAnchor).map(p => `${p.bill_date_bj}×${p.qty}`)
                  });
                }
              }
            }
          }

          result = {
            success: true,
            summary_by_status: {
              total: allReports?.length || 0,
              db_已完成: s_completed,
              db_已配送: s_delivered,
              db_待处理: s_pending,
              db_其他: s_other,
              affected_已完成: affected_completed,
              affected_已配送: affected_delivered,
              affected_待处理中被错误判过: affected_pending_wrong,
              affected_总计: affected_completed + affected_delivered + affected_pending_wrong,
              zombie_pending_count: zombieList.length
            },
            affected_detail_20: affectedDetail,
            zombie_samples: zombieList.slice(0, 20)
          };
        } catch (e: any) {
          result = { success: false, error: e?.message || String(e), stack: e?.stack };
        } finally { releasePool(pool); }
        break;
      }
      // ========== DEBUG: 全量 FIFO 新旧口径对比（只读，用于预演回退范围）==========
      case "debug_fifo_full_compare": {
        const supabaseCl = supabase;
        const pool = await getPool();
        try {
          // 拉全量 reports（无论状态）
          const { data: allReports, error: qErr } = await supabaseCl
            .from("reports")
            .select("id, product_code, store_name, demand_quantity, created_at, replenish_status")
            .eq("order_type", "缺货订购")
            .gt("demand_quantity", 0)
            .order("product_code, created_at", { ascending: true });
          if (qErr) throw qErr;

          const codes = [...new Set((allReports || []).map(r => r.product_code).filter(Boolean))];
          const codesList = codes.map(c => `N'${(c || '').replace(/'/g, "''")}'`).join(',');
          const purchaseRes = await pool.request().query(`
            SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
            FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
            JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
            WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesList})
          `);
          let purchaseByCode: Record<string, Array<{ date: any; qty: number }>> = {};
          for (const row of purchaseRes.recordset || []) {
            const r = row as any;
            if (!purchaseByCode[r.usercode]) purchaseByCode[r.usercode] = [];
            purchaseByCode[r.usercode].push({ date: r.BillDate, qty: Number(r.qty || 0) });
          }

          function oldFifo(purchaseSorted: any[], sortedReports: any[]): string[] {
            if (sortedReports.length === 0) return [];
            const earliestAnchorBj = toBjDate(sortedReports[0].created_at);
            let total = 0;
            for (const p of purchaseSorted) { if (p.bill_date_bj > earliestAnchorBj) total += p.qty; }
            const done: string[] = []; let rem = total;
            for (const r of sortedReports) { const d = Number(r.demand_quantity) || 0; if (rem >= d) { rem -= d; done.push(r.id); } else break; }
            return done;
          }
          function newFifo(purchaseSorted: any[], sortedReports: any[]): string[] {
            if (sortedReports.length === 0) return [];
            const entries = purchaseSorted.map(p => ({ bill_date_bj: p.bill_date_bj, remain: p.qty }));
            const done: string[] = [];
            for (const r of sortedReports) {
              const d = Number(r.demand_quantity) || 0;
              const myAnchor = toBjDate(r.created_at);
              let eligibleRemain = 0;
              for (const e of entries) if (e.bill_date_bj >= myAnchor) eligibleRemain += e.remain;
              if (eligibleRemain >= d) {
                let need = d;
                for (const e of entries) { if (need <= 0) break; if (e.bill_date_bj >= myAnchor) { const take = Math.min(e.remain, need); e.remain -= take; need -= take; } }
                done.push(r.id);
              } else break;
            }
            return done;
          }

          const byCode: Record<string, any[]> = {};
          for (const r of (allReports || [])) { if (!byCode[r.product_code]) byCode[r.product_code] = []; byCode[r.product_code].push(r); }

          let globalAffected = 0, globalOldDone = 0, globalNewDone = 0;
          const affectedById: any[] = [];
          for (const code of codes) {
            const sorted = [...(byCode[code] || [])].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            if (sorted.length === 0) continue;
            const purchaseRows = purchaseByCode[code] || [];
            const purchaseSorted = purchaseRows.map(p => ({ bill_date_bj: toBjDate(p.date), qty: Number(p.qty || 0) })).sort((a, b) => a.bill_date_bj.localeCompare(b.bill_date_bj));
            const oldDone = oldFifo(purchaseSorted, sorted);
            const newDone = newFifo(purchaseSorted, sorted);
            globalOldDone += oldDone.length; globalNewDone += newDone.length;
            const oldSet = new Set(oldDone); const newSet = new Set(newDone);
            for (const r of sorted) {
              if (oldSet.has(r.id) && !newSet.has(r.id)) {
                globalAffected++;
                const myAnchor = toBjDate(r.created_at);
                affectedById.push({
                  id: r.id, product_code: code, store: r.store_name,
                  created_at_bj: myAnchor, demand: r.demand_quantity,
                  current_status: r.replenish_status
                });
              }
            }
          }
          result = {
            success: true,
            summary: {
              total_products: codes.length,
              total_reports: allReports?.length || 0,
              old_done_total: globalOldDone,
              new_done_total: globalNewDone,
              old_only_total: globalAffected,
              new_only_total: globalNewDone - (globalOldDone - globalAffected)
            },
            affected: affectedById,
            affected_samples_20: affectedById.slice(0, 20)
          };
        } catch (e: any) {
          result = { success: false, error: e?.message || String(e), stack: e?.stack };
        } finally { releasePool(pool); }
        break;
      }
      // ========== DEBUG: 完整 FIFO 重算（用真实数据，绕过已完成状态过滤）==========
      case "debug_fifo_recompute": {
        const codesRaw = params?.codes as string[] | string | undefined;
        const codes = Array.isArray(codesRaw) ? codesRaw : (codesRaw ? [codesRaw] : []);
        if (codes.length === 0) { result = { success: false, error: 'codes 必填' }; break; }
        const pool = await getPool();
        const supabaseCl = supabase;
        try {
          // 拉指定商品的所有 reports（无论状态）
          const { data: allReports, error: qErr } = await supabaseCl
            .from("reports")
            .select("id, product_code, store_name, demand_quantity, created_at, replenish_status")
            .eq("order_type", "缺货订购")
            .in("product_code", codes)
            .gt("demand_quantity", 0)
            .order("created_at", { ascending: true });
          if (qErr) throw qErr;

          // 查采购入库
          const codesList = codes.map(c => `N'${(c || '').replace(/'/g, "''")}'`).join(',');
          const purchaseRes = await pool.request().query(`
            SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
            FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
            JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
            WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesList})
          `);
          let purchaseByCode: Record<string, Array<{ date: any; qty: number }>> = {};
          for (const row of purchaseRes.recordset || []) {
            const r = row as any;
            if (!purchaseByCode[r.usercode]) purchaseByCode[r.usercode] = [];
            purchaseByCode[r.usercode].push({ date: r.BillDate, qty: Number(r.qty || 0) });
          }

          // ========== 旧口径：商品级最早 anchor ==========
          function oldFifo(purchaseSorted: Array<{ bill_date_bj: string; qty: number }>, sortedReports: any[]): string[] {
            if (sortedReports.length === 0) return [];
            const earliestAnchorBj = toBjDate(sortedReports[0].created_at);
            let histRemain = 0, sameRemain = 0;
            for (const p of purchaseSorted) {
              if (p.bill_date_bj > earliestAnchorBj) histRemain += p.qty;
              else if (p.bill_date_bj === earliestAnchorBj) sameRemain += p.qty;
            }
            const done: string[] = [];
            for (const r of sortedReports) {
              const demand = Number(r.demand_quantity) || 0;
              if (histRemain >= demand) { histRemain -= demand; done.push(r.id); }
              else if (histRemain + sameRemain >= demand) {
                const left = demand - histRemain; histRemain = 0; sameRemain -= left; done.push(r.id);
              } else break;
            }
            return done;
          }

          // ========== 新口径：每条 report 自己的 anchor ==========
          function newFifo(purchaseSorted: Array<{ bill_date_bj: string; qty: number }>, sortedReports: any[]): string[] {
            if (sortedReports.length === 0) return [];
            const entries = purchaseSorted.map(p => ({ bill_date_bj: p.bill_date_bj, remain: p.qty }));
            const done: string[] = [];
            for (const r of sortedReports) {
              const demand = Number(r.demand_quantity) || 0;
              const myAnchor = toBjDate(r.created_at);
              let eligibleRemain = 0;
              for (const e of entries) if (e.bill_date_bj >= myAnchor) eligibleRemain += e.remain;
              if (eligibleRemain >= demand) {
                let need = demand;
                for (const e of entries) {
                  if (need <= 0) break;
                  if (e.bill_date_bj >= myAnchor) { const take = Math.min(e.remain, need); e.remain -= take; need -= take; }
                }
                done.push(r.id);
              } else break;
            }
            return done;
          }

          const byCode: Record<string, any[]> = {};
          for (const r of (allReports || [])) {
            if (!byCode[r.product_code]) byCode[r.product_code] = [];
            byCode[r.product_code].push(r);
          }

          const trace: any[] = [];
          let globalAffected = 0;
          const affectedSamples: any[] = [];

          for (const code of codes) {
            const sorted = [...(byCode[code] || [])].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            if (sorted.length === 0) continue;
            const earliestAnchorBj = toBjDate(sorted[0].created_at);
            const latestAnchorBj = toBjDate(sorted[sorted.length - 1].created_at);
            const purchaseRows = purchaseByCode[code] || [];
            const purchaseSorted = purchaseRows
              .map(p => ({ bill_date_bj: toBjDate(p.date), qty: Number(p.qty || 0) }))
              .sort((a, b) => a.bill_date_bj.localeCompare(b.bill_date_bj));

            const oldDone = oldFifo(purchaseSorted, sorted);
            const newDone = newFifo(purchaseSorted, sorted);
            const oldSet = new Set(oldDone);
            const newSet = new Set(newDone);

            // 差异：old=true 但 new=false → 应退回
            const oldOnly: any[] = [];
            for (const r of sorted) {
              const wasOldDone = oldSet.has(r.id);
              const isNewDone = newSet.has(r.id);
              const myAnchor = toBjDate(r.created_at);
              // 算这条 report 在新口径下可用的采购（bill_date >= myAnchor）
              let myEligiblePool = 0;
              const myUsedPurchases: any[] = [];
              for (const p of purchaseSorted) {
                if (p.bill_date_bj >= myAnchor) { myEligiblePool += p.qty; myUsedPurchases.push(p); }
              }
              if (wasOldDone && !isNewDone) {
                oldOnly.push({
                  id: r.id, store: r.store_name, created_at_bj: myAnchor, demand: r.demand_quantity,
                  current_status: r.replenish_status,
                  eligible_pool_bj_new: myUsedPurchases.map(p => `${p.bill_date_bj}×${p.qty}`).join(', ') || '(无)',
                  eligible_pool_total: myEligiblePool,
                  old_anchor_used_bj: earliestAnchorBj,
                  old_eligible_pool: purchaseSorted.filter(p => p.bill_date_bj >= earliestAnchorBj).reduce((s, p) => s + p.qty, 0)
                });
              }
            }

            globalAffected += oldOnly.length;
            if (oldOnly.length > 0 && affectedSamples.length < 20) {
              affectedSamples.push(...oldOnly.slice(0, 20 - affectedSamples.length).map(o => ({ code, ...o })));
            }

            trace.push({
              code,
              earliest_anchor_bj: earliestAnchorBj,
              latest_anchor_bj: latestAnchorBj,
              total_reports: sorted.length,
              purchase_count: purchaseRows.length,
              purchase_total_qty: purchaseSorted.reduce((s, p) => s + p.qty, 0),
              purchase_last_bj: purchaseSorted.length > 0 ? purchaseSorted[purchaseSorted.length - 1].bill_date_bj : 'N/A',
              old_done_count: oldDone.length,
              new_done_count: newDone.length,
              old_only_count: oldOnly.length,
              old_only: oldOnly,
              purchase_list: purchaseSorted.map(p => `${p.bill_date_bj}×${p.qty}`)
            });
          }

          result = {
            success: true,
            summary: { total_products: codes.length, global_affected_reports: globalAffected },
            trace,
            affected_samples_20: affectedSamples
          };
        } catch (e: any) {
          result = { success: false, error: e?.message || String(e), stack: e?.stack };
        } finally { releasePool(pool); }
        break;
      }
      case "debug_sql": {
        const pool = await getPool();
        try {
          // 1. 确认当前连接的默认数据库
          const dbCheck = await pool.request().query(`SELECT DB_NAME() AS current_db, @@SERVERNAME AS server_name`);
          const db = dbCheck.recordset?.[0]?.current_db || 'unknown';
          const svr = dbCheck.recordset?.[0]?.server_name || 'unknown';
          
          // 2. 查默认库 dbo.SPFXB_Result 的行数
          let rqztCount = -1;
          try {
            const c = await pool.request().query(`SELECT COUNT(*) AS cnt FROM dbo.SPFXB_Result WITH (NOLOCK)`);
            rqztCount = c.recordset?.[0]?.cnt ?? -1;
          } catch (_e) { rqztCount = -1; }
          
          // 3. 查 ZHYYLS.dbo.SPFXB_Result 的行数（跨库）
          let zhyylsCount = -1;
          try {
            const c = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ZHYYLS.dbo.SPFXB_Result WITH (NOLOCK)`);
            zhyylsCount = c.recordset?.[0]?.cnt ?? -1;
          } catch (_e) { zhyylsCount = -1; }
          
          // 4. 查默认库里所有含 SPFXB 的对象名
          let spfxObjs: any[] = [];
          try {
            const o = await pool.request().query(`SELECT [name], type_desc FROM sys.objects WHERE [name] LIKE '%SPFXB%' ORDER BY type_desc`);
            spfxObjs = o.recordset || [];
          } catch (_e) {}
          
          result = { 
            success: true,
            db_name: db,
            server_name: svr,
            rqzt_spfx_count: rqztCount,
            zhyyls_spfx_count: zhyylsCount,
            spfx_objects: spfxObjs
          };
        } finally { releasePool(pool); }
        break;
      }

      // v5.8.1+ 定时同步配送缓存表（仅供内部 cron / 管理员调用）
      case "sync_cache": {
        // 1. 鉴权：仅允许携带正确 SYNC_CACHE_SECRET 的请求
        const SYNC_SECRET = Deno.env.get("SYNC_CACHE_SECRET");
        if (!SYNC_SECRET || !params.secret || params.secret !== SYNC_SECRET) {
          result = { success: false, error: "unauthorized" };
          break;
        }
        // 2. 限流：1 分钟窗口内最多 5 次
        const now = Date.now();
        if (now - syncRateLimit.windowStart > SYNC_RATE_WINDOW_MS) {
          syncRateLimit.windowStart = now;
          syncRateLimit.reqCount = 0;
        }
        syncRateLimit.reqCount += 1;
        if (syncRateLimit.reqCount > SYNC_RATE_MAX_ALLOW) {
          result = { success: false, error: "请求限流，请1分钟后重试" };
          break;
        }
        // 3. 执行同步
        try {
          const pool = await getPool();
          try {
            const exist = await pool.request().query(`
              SELECT OBJECT_ID('dbo.SendBill_Cache') AS id
            `);
            if (!exist.recordset?.[0]?.id) {
              result = { success: false, error: "SendBill_Cache 表不存在" };
              break;
            }
            await pool.request().query("EXEC dbo.usp_SyncSendBillCache;");
            const cnt = await pool.request().query("SELECT COUNT(*) AS cnt FROM dbo.SendBill_Cache WITH(NOLOCK)");
            result = { success: true, rows: cnt.recordset?.[0]?.cnt || 0 };
          } finally { releasePool(pool); }
        } catch (e) {
          result = { success: false, error: String(e) };
        }
        break;
      }

      // ========== FIFO 对齐对比（只读，内部直接跑两套逻辑）==========
      // 拉全量 pending reports + 批量采购，在 Edge Function 内部跑 scheduled-task 旧逻辑 vs 新共享 runFIFO
      case "fifo_diff_check": {
        const pool = await getPool();
        try {
          // ① 分页拉 pending reports
          let allItems: any[] = [];
          let from = 0;
          const PS = 1000;
          while (true) {
            const { data: page } = await supabase
              .from("reports")
              .select("id, product_code, demand_quantity, created_at, replenish_status, store_name, status_changed_at")
              .eq("order_type", "缺货订购")
              .not("product_code", "is", null)
              .gt("demand_quantity", 0)
              .neq("replenish_status", "已完成")
              .neq("replenish_status", "厂家断货")
              .neq("replenish_status", "已关闭")
              .order("created_at", { ascending: false })
              .range(from, from + PS - 1);
            if (!page || page.length === 0) break;
            allItems = allItems.concat(page);
            if (page.length < PS) break;
            from += PS;
          }

          // ② 批量拉采购
          const codes = [...new Set(allItems.map(r => r.product_code).filter(Boolean))];
          const codesList = codes.map(c => `N'${c.replace(/'/g, "''")}'`).join(',');
          let purchaseByCode: Record<string, any[]> = {};
          const pres = await pool.request().query(`
            SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
            FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
            JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
            WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesList})
          `);
          for (const row of pres.recordset) {
            const r: any = row;
            const code = (r.usercode || '').trim();
            if (!purchaseByCode[code]) purchaseByCode[code] = [];
            purchaseByCode[code].push({ date: r.BillDate, qty: Number(r.qty || 0) });
          }

          // ====== 旧版 scheduled-task 逻辑（UTC 毫秒宽松）======
          const oldResults = new Set<string>();
          const itemsByCodeOld: Record<string, any[]> = {};
          for (const r of allItems) { if (!itemsByCodeOld[r.product_code]) itemsByCodeOld[r.product_code] = []; itemsByCodeOld[r.product_code].push(r); }
          for (const code of Object.keys(itemsByCodeOld)) {
            itemsByCodeOld[code].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
          }
          for (const code of Object.keys(itemsByCodeOld)) {
            const myReports = itemsByCodeOld[code];
            if (myReports.length === 0) continue;
            const earliestTs = new Date(myReports[0].created_at).getTime();
            const rows = purchaseByCode[code] || [];
            let remaining = 0;
            for (const p of rows) {
              // 旧版：SQL Server datetime → new Date() → UTC 毫秒
              const pTs = new Date(p.date).getTime();
              if (pTs >= earliestTs) remaining += Number(p.qty || 0); // 宽松：>=
            }
            for (const r of myReports) {
              const demand = Number(r.demand_quantity);
              if (remaining >= demand) { oldResults.add(r.id); remaining -= demand; } else break;
            }
          }

          // ====== 新版共享 runFIFO（北京时间严格）======
          const { runFIFO: _run } = await import("../_shared/fifo.ts");
          const fifoRes = _run(allItems.map(r => ({ id: r.id, product_code: r.product_code, demand_quantity: r.demand_quantity, created_at: r.created_at })), purchaseByCode, false);
          const newResults = new Set(fifoRes.toCompleteIds);

          // ====== 逐行 diff ======
          const diffs: any[] = [];
          let oldCount = 0, newCount = 0, both = 0;
          const allIds = [...new Set([...oldResults, ...newResults, ...allItems.map(r => r.id)])];
          for (const id of allIds) {
            const old = oldResults.has(id);
            const nw = newResults.has(id);
            if (old) oldCount++;
            if (nw) newCount++;
            if (old && nw) both++;
            if (old !== nw) {
              const r = allItems.find(x => x.id === id);
              diffs.push({
                id, product_code: r?.product_code, store_name: r?.store_name,
                demand: r?.demand_quantity, created_at: r?.created_at,
                earliest_ts_ms: itemsByCodeOld[r?.product_code || '']?.[0] ? new Date(itemsByCodeOld[r?.product_code || ''][0].created_at).getTime() : 0,
                old_done: old, new_done: nw
              });
            }
          }

          result = {
            success: true,
            summary: { pending_count: allItems.length, codes: codes.length, old_done: oldCount, new_done: newCount, both_agree: both, diff_count: diffs.length },
            diffs: diffs.slice(0, 50),
            purchase_pools: fifoRes.details
          };
        } catch (e: any) {
          console.error("[fifo_diff_check] 错误:", e);
          result = { success: false, error: e?.message || String(e) };
        } finally {
          releasePool(pool);
        }
        break;
      }

      // ========== 批量拉原始采购明细（只读，用于 FIFO 对齐对比）==========
      case "batch_purchase_check": {
        const { codes } = params;
        if (!codes || !Array.isArray(codes) || codes.length === 0) {
          return new Response(JSON.stringify({ success: false, error: "codes 必填且是数组" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        const pool = await getPool();
        const purchaseByCode: Record<string, any[]> = {};
        try {
          const codesList = codes.map(c => `N'${String(c).replace(/'/g, "''")}'`).join(',');
          const res = await pool.request().query(`
            SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
            FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
            JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
            WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesList})
          `);
          for (const row of res.recordset) {
            const r: any = row;
            const code = (r.usercode || '').trim();
            if (!purchaseByCode[code]) purchaseByCode[code] = [];
            purchaseByCode[code].push({
              date: r.BillDate ? new Date(r.BillDate).toISOString().substring(0, 10) : null,
              date_raw: r.BillDate,
              qty: Number(r.qty || 0)
            });
          }
          result = { success: true, purchaseByCode, codes_count: codes.length };
        } catch (e: any) {
          result = { success: false, error: e?.message || String(e) };
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "get_summary": {
        // ★ 2026-11-10 优化：支持 active_only 模式（首屏只查非终态 reports）
        // 88.5% 的 reports 是终态（已完成/已配送/已关闭/厂家断货），不需要在首屏返回全量
        // active_only=true 时：
        //   - 只查非终态 reports（用于 shortage_by_product 聚合 + 主表）
        //   - 额外返回 completed_summary（轻量版终态报告，每条约 200字节，只有核心字段）
        //   - plan / supplierLookup / poolRemainingMap / warehouseStockMap / approvals 仍然全量返回
        // 这样首屏响应体从 1.5MB → ~460KB，后端序列化 + 网络传输省 60%
        const activeOnly = params?.active_only === true;
        const TERMINAL_STATUSES = ['已完成', '厂家断货', '已关闭', '已配送'];

        async function fetchAllReports(ot: string, terminalFilter?: 'active' | 'terminal') {
          const out: any[] = [];
          const PAGE = 1000;
          let from = 0;
          while (true) {
            let q: any = supabase
              .from("reports")
              .select("*")
              .eq("order_type", ot)
              .gt("demand_quantity", 0);
            if (terminalFilter === 'active') {
              // ★ 2026-11-10 修复：Supabase JS v2 的 .not('in', [...]) 不生效，
              // 改成链式 .neq() 实现 AND 逻辑（status != 已完成 AND status != 厂家断货 AND ...）
              // 这比 .not('replenish_status', 'in', TERMINAL_STATUSES) 更可靠
              for (const s of TERMINAL_STATUSES) {
                q = q.neq('replenish_status', s);
              }
            } else if (terminalFilter === 'terminal') {
              q = q.in('replenish_status', TERMINAL_STATUSES);
            }
            const res = await q.order("created_at", { ascending: false }).range(from, from + PAGE - 1);
            if (res.error) { console.warn(`[fetchAllReports ${ot} ${terminalFilter}] Supabase error:`, res.error); break; }
            const rows = res.data || [];
            out.push(...rows);
            if (rows.length < PAGE) break;
            from += PAGE;
          }
          return out;
        }

        let reports: any[];
        let completedSummary: any[] = [];
        if (activeOnly) {
          // 首屏模式：只查非终态
          reports = await fetchAllReports("缺货订购", 'active');
          let newActive: any[] = [];
          try { newActive = await fetchAllReports("新品订购", 'active'); } catch (_) {}
          reports = [...(reports || []), ...newActive];

          // 轻量终态摘要：每条只带 cbp 聚合必需的字段
          // 完整 fields: id, product_code, product_name, specification, manufacturer, store_id, store_name,
          //             demand_quantity, replenish_status, status_changed_at, status_remark, status_changed_by,
          //             created_at, reporter_id, reporter_name, reporter_phone, current_stock, in_transit
          // 轻量 fields: 上面 - reporter 三件套 + product_name/spec/manufacturer（靠 plan/supplier 补）
          // 预计每条从 ~800字节 → ~200字节，1543条从 1.2MB → 300KB
          const term缺货 = await fetchAllReports("缺货订购", 'terminal');
          let term新品: any[] = [];
          try { term新品 = await fetchAllReports("新品订购", 'terminal'); } catch (_) {}
          const allTerminal = [...term缺货, ...term新品];
          completedSummary = allTerminal.map((r: any) => ({
            id: r.id,
            product_code: r.product_code,
            store_id: r.store_id,
            store_name: r.store_name,
            demand_quantity: r.demand_quantity,
            replenish_status: r.replenish_status,
            status_changed_at: r.status_changed_at,
            status_remark: r.status_remark,
            status_changed_by: r.status_changed_by,
            created_at: r.created_at,
            order_type: r.order_type
          }));
        } else {
          // 正常模式（手动刷新/不传参数）：全量返回
          reports = await fetchAllReports("缺货订购");
          let newTypeReports: any[] = [];
          try { newTypeReports = await fetchAllReports("新品订购"); } catch (_) {}
          reports = [...(reports || []), ...newTypeReports];
        }

        let planRecords: any[] = [];
        let supplierLookup: Record<string, string> = {};

        try {
          const pool = await getPool();
          try {
            // ====== ★ 2026-11-10 v3.21 并行化：提前算好 SQL 查询需要的 codes（纯内存，零耗时） ======
            // 这些 codes 都只依赖已在内存的 reports / completedSummary，不需要等 SQL 查询结果
            const pendingCodes = [...new Set(
              reports
                .filter(r => r.order_type === '缺货订购'
                  && !['已完成', '厂家断货', '已关闭', '已配送'].includes(r.replenish_status || ''))
                .map(r => (r.product_code || '').trim())
                .filter(Boolean)
            )];
            // ★ 2026-11-10 修复：改前 summaryCodes 包含 planRecords 独有的 codes，
            // 但 taskB 必须等 taskA 完成后才能拿 planRecords。
            // 先只算 reports + completedSummary 的 codes，等 planRecords 出来后补独有的
            const summaryCodesLite = [...new Set([
              ...reports.map(r => (r.product_code || '').trim()),
              ...completedSummary.map(r => (r.product_code || '').trim())
            ].filter(Boolean))];
            console.log(`[v3.21-debug] summaryCodesLite=${summaryCodesLite.length} pendingCodes=${pendingCodes.length} reports=${reports.length} completedSummary=${completedSummary.length}`);

            // ====== ★ 三查询并行：Promise.all([usp+supplier, warehouse, FIFO]) ======
            // usp+supplier 之间有依赖（supplier 要 planRecords 的 codes），但和另外两个完全独立
            // warehouse 和 FIFO 的 codes 已提前算好，零依赖
            const _normSupCode = (code: string) => (code || '').trim().toUpperCase().replace(/^0+/, '');

            // --- 任务 A：usp_GetPurchasePlanWithFeedback + 供货商 + 补货状态汇总 ---
            const taskA = (async () => {
              try {
                const req = pool.request()
                  .input("关键字", sql.NVarChar, null)
                  .input("状态筛选", sql.NVarChar, null)
                  .input("仅缺货", sql.Bit, 1)
                  .input("Top", sql.Int, 500);
                const pResult = await req.execute("usp_GetPurchasePlanWithFeedback");
                const records = (pResult.recordsets?.[0] || pResult.recordset || []).map(r => ({
                  "商品编码": r.商品编码 || "",
                  "商品名称": r.商品名称 || "",
                  "规格": r.规格 || "",
                  "生产企业": r.生产企业 || "",
                  "库存数量": r.库存数量 || 0,
                  "在途数量": r.在途数量 || 0,
                  "门店库存汇总": r.门店库存汇总 || 0,
                  "配送中心库存数量": r.配送中心库存数量 || 0,
                  "前30天销售数量": r.前30天销售数量 || 0,
                  "前90天销售数量": r.前90天销售数量 || 0,
                  "月均销售数量": r.月均销售数量 || 0,
                  "标准库存数量": r.标准库存数量 || 0,
                  "门店计划": r.门店计划 || 0,
                  "建议订货数量": r.建议订货数量 || 0,
                  "标记": r.标记 || "",
                  "类别": r.类别 || "",
                  "门店名称": r.门店名称 || "",
                  "补货状态": r.补货状态 || "",
                  "实际订货数量": r.实际订货数量 || 0,
                  "供货商": r.供货商 || r.供应商 || "",
                  "仓库库存": r.仓库库存 || r.配送中心库存数量 || 0,
                }));

                // 供货商查询（Vptype.comment），串行在 usp 之后（依赖 planRecords codes）
                if (records.length > 0) {
                  try {
                    const rawCodes = [...new Set(records.map(r => (r["商品编码"] || '').trim().toUpperCase()).filter(c => c))];
                    const normCodes = [...new Set(rawCodes.map(c => _normSupCode(c)).filter(c => c))];
                    const allCodes = [...new Set([...rawCodes, ...normCodes])];
                    if (allCodes.length > 0) {
                      const CODE_BATCH = 500;
                      for (let i = 0; i < allCodes.length; i += CODE_BATCH) {
                        const batch = allCodes.slice(i, i + CODE_BATCH);
                        const suppReq = pool.request();
                        const suppIn: string[] = [];
                        batch.forEach((c, j) => { suppReq.input(`s${j}`, sql.NVarChar(50), c); suppIn.push(`@s${j}`); });
                        const suppResult = await suppReq.query(
                          `SELECT LTRIM(RTRIM(ISNULL(usercode, ''))) as 商品编码, LTRIM(RTRIM(ISNULL(comment, ''))) as 供货商 FROM ZHYYLS.dbo.Vptype WITH (NOLOCK) WHERE usercode IN (${suppIn.join(',')}) AND comment IS NOT NULL AND comment != ''`
                        );
                        (suppResult.recordset || []).forEach((raw: any) => {
                          const rawCode = (raw.商品编码 || '').trim().toUpperCase();
                          const norm = _normSupCode(rawCode);
                          if (rawCode && !supplierLookup[rawCode]) supplierLookup[rawCode] = raw.供货商 || '';
                          if (norm && !supplierLookup[norm]) supplierLookup[norm] = raw.供货商 || '';
                        });
                      }
                    }
                    let matchedCount = 0;
                    const finalRecords = records.map(r => {
                      const rawKey = (r["商品编码"] || '').trim().toUpperCase();
                      const normKey = _normSupCode(rawKey);
                      const sup = supplierLookup[rawKey] || supplierLookup[normKey] || '';
                      if (sup) matchedCount++;
                      return { ...r, 供货商: sup };
                    });
                    console.log(`[供货商] 查询匹配 ${matchedCount}/${finalRecords.length}`);
                    return finalRecords;
                  } catch (e) {
                    console.error('获取供货商信息失败:', e);
                    return records;
                  }
                }
                return records;
              } catch (e) {
                console.error('[get_summary] usp_GetPurchasePlanWithFeedback 失败:', e);
                return [];
              }
            })();

            // --- 任务 B：仓库实时库存（dc_stock 快照，用 GoodsStocks 和 get_warehouse_stock 一致） ---
            const taskB = (async (): Promise<Record<string, number>> => {
              if (summaryCodesLite.length === 0) return {};
              try {
                const BATCH = 500;
                const whMap: Record<string, number> = {};
                for (let i = 0; i < summaryCodesLite.length; i += BATCH) {
                  const batch = summaryCodesLite.slice(i, i + BATCH);
                  const req = pool.request();
                  const codeIn: string[] = [];
                  batch.forEach((c, j) => { req.input(`c${j}`, sql.NVarChar(50), c); codeIn.push(`@c${j}`); });
                  const res = await req.query(`
                    SELECT v.usercode, ISNULL(SUM(gs.qty), 0) as wh_qty
                    FROM ZHYYLS.dbo.Vptype v WITH(NOLOCK)
                    LEFT JOIN ZHYYLS.dbo.GoodsStocks gs WITH(NOLOCK) ON gs.prec = v.rec AND gs.krec = '3'
                    WHERE v.usercode IN (${codeIn.join(',')})
                    GROUP BY v.usercode
                  `);
                  (res.recordset || []).forEach((row: any) => { whMap[row.usercode] = row.wh_qty || 0; });
                }
                console.log(`[warehouseStockMap] GoodsStocks 查询 ${summaryCodesLite.length} 个商品，命中 ${Object.keys(whMap).length}`);
                return whMap;
              } catch (e) { console.warn('[get_summary] warehouseStockMap 查询失败:', e); return {}; }
            })();

            // --- 任务 C：FIFO 剩余采购池（采购入库明细，后续内存算 poolRemainingMap） ---
            const taskC = (async () => {
              if (pendingCodes.length === 0) return null;
              try {
                const req = pool.request();
                const codesBatch = pendingCodes.map(c => `N'${c.replace(/'/g, "''")}'`).join(',');
                return await req.query(`
                  SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
                  FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
                  JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
                  WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesBatch})
                `);
              } catch (e) { console.warn('[get_summary] FIFO purchase 查询失败:', e); return null; }
            })();

            // ====== 等待三查询全部完成 ======
            const [planRecordsRaw, whMap, purchaseRes] = await Promise.all([taskA, taskB, taskC]);
            planRecords = planRecordsRaw;

            // ====== 补货状态从 Supabase reports 汇总（v3.20+ 加固，纯内存） ======
            if (planRecords.length > 0 && reports.length > 0) {
              const isTerminal = (s: string) => ['已完成', '厂家断货', '已关闭', '已配送'].includes(s || '');
              const supStatusMap: Record<string, string> = {};
              for (const r of reports) {
                const code = (r.product_code || '').trim();
                if (!code || supStatusMap[code]) continue;
                const s = r.replenish_status || '待处理';
                if (!isTerminal(s)) supStatusMap[code] = s;
              }
              for (const r of reports) {
                const code = (r.product_code || '').trim();
                if (!code || supStatusMap[code]) continue;
                supStatusMap[code] = r.replenish_status || '待处理';
              }
              planRecords = planRecords.map(r => ({
                ...r,
                "补货状态": supStatusMap[(r["商品编码"] || '').trim()] || r["补货状态"] || '待处理'
              }));
            }

            // ====== 初始化 result ======
            result = { reports, completed_summary: completedSummary, plan: [planRecords], supplierLookup };

            // ★ warehouseStockMap：无条件挂（即使是空对象也要挂）
            (result as any).warehouseStockMap = whMap || {};

            // ====== FIFO poolRemainingMap（纯内存计算，purchaseRes 已拿到） ======
            if (purchaseRes && pendingCodes.length > 0) {
              const purchaseByCode: Record<string, Array<{ date: string; qty: number }>> = {};
              (purchaseRes.recordset || []).forEach((row: any) => {
                if (!purchaseByCode[row.usercode]) purchaseByCode[row.usercode] = [];
                purchaseByCode[row.usercode].push({ date: row.BillDate, qty: Number(row.qty || 0) });
              });

              const poolRemainingMap: Record<string, number> = {};
              const effectivePurchaseMap: Record<string, number> = {};
              for (const code of pendingCodes) {
                const myReports = reports
                  .filter(r => (r.product_code || '').trim() === code
                    && r.order_type === '缺货订购'
                    && !['已完成', '厂家断货', '已关闭', '已配送'].includes(r.replenish_status || '')
                    && Number(r.demand_quantity) > 0)
                  .sort((a: any, b: any) =>
                    new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

                if (myReports.length === 0) { poolRemainingMap[code] = 0; effectivePurchaseMap[code] = 0; continue; }

                const earliestAnchorBj = toBjDate(myReports[0].created_at);
                const purchaseRows = purchaseByCode[code] || [];
                let effectivePurchase = 0;
                for (const p of purchaseRows) {
                  if (isPurchaseEligible(toBjDate(p.date), earliestAnchorBj)) effectivePurchase += p.qty;
                }
                effectivePurchaseMap[code] = effectivePurchase;

                let remainingPurchase = effectivePurchase;
                for (const r of myReports) {
                  const demand = Number(r.demand_quantity);
                  if (remainingPurchase >= demand) {
                    remainingPurchase -= demand;
                  } else {
                    break;
                  }
                }
                poolRemainingMap[code] = remainingPurchase;
              }
              (result as any).poolRemainingMap = poolRemainingMap;
              (result as any).effectivePurchaseMap = effectivePurchaseMap;
              console.log(`[poolRemainingMap] 计算 ${pendingCodes.length} 个待处理商品，同时返回 effectivePurchaseMap`);
            }

          } finally {
            releasePool(pool);
          }
        } catch (e) {
          console.error('[get_summary] SQL Server 查询失败，只返回 reports:', e);
          // ★ 2026-11-10 修复：如果 SQL 整个 try 块崩了，result 可能还没初始化
          // 给个兜底值，不让下面的 approvals 挂属性时报 undefined 错误
          if (!result) result = { reports, completed_summary: completedSummary, plan: [], supplierLookup: {} };
        }

        // 注意：result 已在上面 Line 6681 初始化过，warehouseStockMap 和 poolRemainingMap 也已挂上去
        // 这里千万不要再 result = {...} 覆盖，否则两个 Map 全部丢失！

        try {
          // ② 新品审批列表（纯 Supabase 查询，极快）
          const { data: approvals } = await supabase
            .from("report_approvals")
            .select("*")
            .order("created_at", { ascending: false });
          (result as any).approvals = approvals || [];
        } catch (e) { console.warn('[get_summary] approvals 合并查询失败:', e); }

        try {
          // ③ 配送待办角标（只需要数量，完整列表前端仍可调 get_delivery_todo）
          const { data: completedReports } = await supabase
            .from("reports")
            .select("product_code")
            .eq("order_type", "缺货订购")
            .eq("replenish_status", "已完成")
            .not("product_code", "is", null);
          (result as any).deliveryTodoCount = (completedReports || []).length;
        } catch (e) { console.warn('[get_summary] deliveryTodo 合并查询失败:', e); }
        break;
      }

      case "get_realtime_stock": {
        // 单独查询 ZHYYLS 实时库存/已配送（供前端异步刷新）
        // 接受 items: [{product_code, store_id, since}]（前端 summaryData 的最新数据）
        // 也兼容旧格式 product_codes（向后兼容）
        const parsed = params as {
          items?: Array<{ product_code: string; store_id: string; since?: string }>;
          product_codes?: string[];
        };
        const batchItems = parsed.items || [];
        const storeKrecForStock: Record<string, string> = {
          'wszhyy02': '5', 'wszhyy03': '6', 'wszhyy04': '7',
          'wszhyy06': '9', 'wszhyy08': '66', 'wszhyy09': '11',
          'wszhyy14': '36', 'wszhyy16': '50', 'wszhyy17': '13', 'wszhyy21': '63',
        };
        const krecToStoreId: Record<string, string> = {};
        for (const [s, k] of Object.entries(storeKrecForStock)) krecToStoreId[k] = s;

        const realtimeStockMap: Record<string, number> = {};
        const realtimeTransitMap: Record<string, number> = {};
        const stockPairs: Array<{ code: string; krec: string; since: string }> = [];
        const seen = new Set<string>();

        if (batchItems.length > 0) {
          // 新路径：前端直接传 (product_code, store_id, since)，不用再查 Supabase
          for (const it of batchItems) {
            if (!it.product_code || !it.store_id) continue;
            const krec = storeKrecForStock[it.store_id] || '';
            if (!krec) continue;
            const pk = `${it.product_code}||${krec}`;
            if (!seen.has(pk)) {
              seen.add(pk);
              stockPairs.push({ code: it.product_code, krec, since: it.since || '2020-01-01' });
            }
          }
        } else if (parsed.product_codes && parsed.product_codes.length > 0) {
          // 旧路径：从 Supabase 反查（向后兼容）
          const { data: rtReports } = await supabase
            .from("reports")
            .select("product_code, store_id, created_at")
            .in("product_code", parsed.product_codes)
            .eq("order_type", "缺货订购");
          for (const r of rtReports || []) {
            if (!r.product_code || !r.store_id) continue;
            const krec = storeKrecForStock[r.store_id] || '';
            if (!krec) continue;
            const pk = `${r.product_code}||${krec}`;
            if (!seen.has(pk)) {
              seen.add(pk);
              const d = toBjDate(r.created_at) || '2020-01-01';
              stockPairs.push({ code: r.product_code, krec, since: d });
            }
          }
        }

        if (!stockPairs.length) {
          result = { realtimeStockMap: {}, realtimeTransitMap: {} };
          break;
        }

        if (stockPairs.length > 0) {
          try {
            const stockPool = await getPool();
            try {
              // 1. 实时库存
              const BATCH = 50;
              for (let i = 0; i < stockPairs.length; i += BATCH) {
                const batch = stockPairs.slice(i, i + BATCH);
                const req = stockPool.request();
                const vals: string[] = [];
                batch.forEach((sp, j) => {
                  req.input(`c${j}`, sql.NVarChar(50), sp.code);
                  req.input(`k${j}`, sql.NVarChar(10), sp.krec);
                  vals.push(`(@c${j}, @k${j})`);
                });
                const zhRes = await req.query(`
                  CREATE TABLE #ZHS (code NVARCHAR(50), krec NVARCHAR(10));
                  INSERT INTO #ZHS (code, krec) VALUES ${vals.join(',')};
                  SELECT z.code, z.krec, ISNULL(SUM(gs.qty), 0) as st_qty
                  FROM #ZHS z
                  JOIN ZHYYLS.dbo.Vptype v ON v.usercode = z.code
                  LEFT JOIN ZHYYLS.dbo.GoodsStocks gs ON gs.prec = v.rec AND gs.krec = z.krec
                  GROUP BY z.code, z.krec;
                  DROP TABLE #ZHS;
                `);
                (zhRes.recordset || []).forEach((row: any) => {
                  const sid = krecToStoreId[row.krec];
                  if (sid) realtimeStockMap[`${row.code}||${sid}`] = row.st_qty || 0;
                });
              }

              // 2. 已配送
              const precMap: Record<string, number> = {};
              const precToCode: Record<number, string> = {};
              const allCodes = [...new Set(stockPairs.map(sp => sp.code))];
              const CB = 200;
              for (let i = 0; i < allCodes.length; i += CB) {
                const batch = allCodes.slice(i, i + CB);
                const precReq = stockPool.request();
                const precIn: string[] = [];
                batch.forEach((c, j) => { precReq.input(`c${j}`, sql.NVarChar(50), c); precIn.push(`@c${j}`); });
                const precRes = await precReq.query(`SELECT rec, usercode FROM ZHYYLS.dbo.Vptype WITH (NOLOCK) WHERE usercode IN (${precIn.join(',')})`);
                (precRes.recordset || []).forEach((r: any) => { precMap[r.usercode] = r.rec; precToCode[r.rec] = r.usercode; });
              }
              const TB = 50;
              for (let i = 0; i < stockPairs.length; i += TB) {
                const batch = stockPairs.slice(i, i + TB);
                const req = stockPool.request();
                const vals: string[] = [];
                batch.forEach((sp, j) => {
                  req.input(`p${j}`, sql.Int, precMap[sp.code] || 0);
                  req.input(`k${j}`, sql.NVarChar(10), sp.krec);
                  req.input(`s${j}`, sql.VarChar(10), sp.since);
                  vals.push(`(@p${j}, @k${j}, @s${j})`);
                });
                const zhRes = await req.query(`
                  CREATE TABLE #ZHT (prec INT, krec NVARCHAR(10), since VARCHAR(10));
                  INSERT INTO #ZHT (prec, krec, since) VALUES ${vals.join(',')};
                  SELECT z.prec, z.krec, ISNULL(SUM(ABS(v.Qty)), 0) as total_qty
                  FROM #ZHT z
                  JOIN ZHYYLS.dbo.vBuySendSumDetail v WITH (NOLOCK)
                    ON v.PRec = z.prec AND v.InKRec = z.krec
                    AND v.OutKRec = '3'
                    AND v.BillDate >= z.since
                    AND (v.Comment IS NULL OR v.Comment NOT LIKE '%调货出库单%')
                  GROUP BY z.prec, z.krec;
                  DROP TABLE #ZHT;
                `);
                (zhRes.recordset || []).forEach((row: any) => {
                  const sid = krecToStoreId[String(row.krec)];
                  const code = precToCode[row.prec];
                  if (sid && code && row.total_qty > 0) realtimeTransitMap[`${code}||${sid}`] = Number(row.total_qty);
                });
              }
            } finally { releasePool(stockPool); }
          } catch (e) {
            console.warn('[get_realtime_stock] 查询失败:', e);
          }
        }
        result = { realtimeStockMap, realtimeTransitMap };
        break;
      }

      case "get_warehouse_stock": {
        // 查询商品在配送中心仓库的实时库存（krec='3'）
        const { product_codes: whCodes } = params as { product_codes?: string[] };
        if (!whCodes || !Array.isArray(whCodes) || whCodes.length === 0) {
          result = { warehouseStockMap: {} };
          break;
        }
        const warehouseStockMap: Record<string, number> = {};
        try {
          const whPool = await getPool();
          try {
            const BATCH = 500;
            for (let i = 0; i < whCodes.length; i += BATCH) {
              const batch = whCodes.slice(i, i + BATCH);
              const req = whPool.request();
              const codeIn: string[] = [];
              batch.forEach((c, j) => { req.input(`c${j}`, sql.NVarChar(50), c); codeIn.push(`@c${j}`); });
              const res = await req.query(`
                SELECT v.usercode, ISNULL(SUM(gs.qty), 0) as wh_qty
                FROM ZHYYLS.dbo.Vptype v WITH (NOLOCK)
                LEFT JOIN ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK) ON gs.prec = v.rec AND gs.krec = '3'
                WHERE v.usercode IN (${codeIn.join(',')})
                GROUP BY v.usercode
              `);
              (res.recordset || []).forEach((row: any) => {
                warehouseStockMap[row.usercode] = row.wh_qty || 0;
              });
            }
          } finally { releasePool(whPool); }
        } catch (e) {
          console.warn('[get_warehouse_stock] 查询失败:', e);
        }
        result = { warehouseStockMap };
        break;
      }

      // ========== 历史记录批量配送查询（按每条记录的上报日期作为 since）==========
      case "get_history_transit_batch": {
        const { items } = params as {
          items: Array<{ product_code: string; store_name: string; since: string }>;
        };
        if (!items || items.length === 0) {
          result = { transitMap: {} };
          break;
        }
        const transitMap: Record<string, number> = {};
        try {
          const pool = await getPool();
          try {
            const storeKrec: Record<string, string> = {
              '02第二药店':'5','03第三药店':'6','04第四药店':'7',
              '06常口店':'9','08第八药店':'66','09第九药店':'11',
              '14第十四药店':'36','16凤凰山药店':'50','17益丰店':'13','21富源店':'63',
            };
            // 1. 收集唯一的 product_code 和最小 since
            const codeSet = new Set<string>();
            let minSince = '9999-99-99';
            items.forEach(it => {
              if (it.product_code) codeSet.add(it.product_code);
              if (it.since && it.since < minSince) minSince = it.since;
            });
            if (codeSet.size === 0) break;

            // 2. 批量查询 product_code → prec 映射
            const codes = Array.from(codeSet);
            const codeIn: string[] = [];
            const precReq = pool.request();
            codes.forEach((c, i) => { precReq.input(`c${i}`, sql.NVarChar(50), c); codeIn.push(`@c${i}`); });
            const precQuery = await precReq.query(`SELECT usercode, rec FROM ZHYYLS.dbo.Vptype WITH(NOLOCK) WHERE usercode IN (${codeIn.join(',')})`);
            const codeToPrec: Record<string, number> = {};
            (precQuery.recordset || []).forEach((r: any) => { codeToPrec[r.usercode] = r.rec; });
            const validPrecs = Object.values(codeToPrec).filter(p => p != null);
            if (validPrecs.length === 0) break;

            // 3. 一次性查询所有 (Prec, BillDate) 数据
            const precIn: string[] = [];
            const dataReq = pool.request();
            validPrecs.forEach((p, i) => { dataReq.input(`p${i}`, sql.Int, p); precIn.push(`@p${i}`); });
            dataReq.input('since', sql.VarChar(10), minSince);
            const dataRes = await dataReq.query(`
              SELECT vs.PRec, vs.InKRec, vs.BillDate, ABS(vs.Qty) as qty
              FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH (NOLOCK)
              WHERE vs.PRec IN (${precIn.join(',')}) AND vs.OutKRec = '3'
                AND vs.BillDate >= @since
                AND (vs.Comment IS NULL OR vs.Comment NOT LIKE '%调货出库单%')
            `);

            // 4. 在 JS 中按 (Prec, InKRec, since) 聚合
            const precToCode: Record<number, string> = {};
            Object.entries(codeToPrec).forEach(([code, prec]) => { precToCode[prec] = code; });
            const rows = dataRes.recordset || [];
            items.forEach(it => {
              if (!it.product_code || !it.store_name || !it.since) return;
              const prec = codeToPrec[it.product_code];
              const inKrec = storeKrec[it.store_name];
              if (!prec || !inKrec) return;
              const key = it.product_code + '||' + it.since;
              if (transitMap[key] !== undefined) return; // 已有（重复 item）
              let sum = 0;
              for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                if (r.PRec === prec && String(r.InKRec) === inKrec && r.BillDate >= it.since) {
                  sum += r.qty || 0;
                }
              }
              transitMap[key] = sum;
            });
          } finally { releasePool(pool); }
        } catch (e) {
          console.warn('[get_history_transit_batch] 查询失败:', e);
        }
        result = { transitMap };
        break;
      }

      // ========== 实时配送量查询（需求明细用）==========
      // v5.9.0+ 支持批量：product_codes + all_items → 一次 SQL 查全部商品
      case "get_realtime_transit": {
        const batchMode = !!(params as any).product_codes;
        if (batchMode) {
          // ===== 批量模式：一次 SQL 查所有商品的所有门店配送 =====
          // 前端传 { product_codes: ['020643',...], all_items: [{product_code, store_name, since},...] }
          const { product_codes, all_items } = params as {
            product_codes: string[];
            all_items: Array<{ product_code: string; store_name: string; since: string }>;
          };
          const resultMap: Record<string, Record<string, number>> = {};
          try {
            if (!product_codes?.length || !all_items?.length) break;
            const storeKrec: Record<string, string> = {
              '02第二药店':'5','03第三药店':'6','04第四药店':'7',
              '06常口店':'9','08第八药店':'66','09第九药店':'11',
              '14第十四药店':'36','16凤凰山药店':'50','17益丰店':'13','21富源店':'63',
            };
            const pool = await getPool();
            try {
              const codesList = product_codes.map(c => `N'${c.replace(/'/g, "''")}'`).join(',');
              // 所有 since 里最小的那个（SQL 层面先用它粗过滤，再 JS 里精过滤）
              const minSince = all_items.reduce((m, it) => !m || it.since < m ? it.since : m, '9999-12-31');
              const req = pool.request();
              req.input('minSince', sql.VarChar(10), minSince);
              const res = await req.query(`
                SELECT v.usercode as code, vs.InKRec as krec, vs.BillDate as bill_date, ABS(vs.Qty) as qty
                FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH (NOLOCK)
                JOIN ZHYYLS.dbo.Vptype v WITH (NOLOCK) ON v.rec = vs.PRec
                WHERE vs.OutKRec = '3'
                  AND vs.BillDate >= @minSince
                  AND (vs.Comment IS NULL OR vs.Comment NOT LIKE '%调货出库单%')
                  AND v.usercode IN (${codesList})
              `);
              // 内存处理：按 (code, krec) 分组，再按每个门店自己的 since 过滤
              for (const it of all_items) {
                resultMap[it.product_code] = resultMap[it.product_code] || {};
                const krec = storeKrec[it.store_name];
                if (!krec) continue;
                let sum = 0;
                for (const row of res.recordset) {
                  const r = row as any;
                  if (r.code === it.product_code && String(r.krec) === krec) {
                    if (new Date(r.bill_date).getTime() >= new Date(it.since).getTime()) {
                      sum += Number(r.qty || 0);
                    }
                  }
                }
                resultMap[it.product_code][it.store_name] = sum;
              }
            } finally { releasePool(pool); }
          } catch (e) { console.warn('[get_realtime_transit 批量] 查询失败:', e); }
          result = { batchResult: resultMap };
          break;
        }

        // ===== 原单商品模式（保留给明细弹窗用）=====
        const { product_code, items } = params as {
          product_code: string;
          items: Array<{ store_name: string; since: string }>;
        };
        if (!product_code || !items || items.length === 0) {
          result = { transitMap: {} };
          break;
        }
        const transitMap: Record<string, number> = {};
        try {
          // v5.8.1+ 内存缓存：同 (product, store, since) 60s 内不查 SQL
          // 缓解 vBuySendSumDetail 底层 SendBill 无索引导致的 10-30s Table Scan
          const now = Date.now();
          const cacheMiss: Array<{ store_name: string; since: string }> = [];
          for (const it of items) {
            const ck = `${product_code}|${it.store_name}|${it.since}`;
            const ce = transitCache.get(ck);
            if (ce && (now - ce.ts) < TRANSIT_CACHE_TTL) {
              transitMap[it.store_name] = (transitMap[it.store_name] || 0) + ce.value;
            } else {
              cacheMiss.push(it);
            }
          }
          if (cacheMiss.length === 0) {
            result = { transitMap };
            break; // 全部缓存命中，不查 SQL
          }
          // 有缓存未命中的项，按每个门店自己的 since 分别查
          // 修复：之前用 minSince 错误地让所有门店共用最早的日期，导致报告前配送被计入
          const pool = await getPool();
          try {
            const storeKrec: Record<string, string> = {
              '02第二药店':'5','03第三药店':'6','04第四药店':'7',
              '06常口店':'9','08第八药店':'66','09第九药店':'11',
              '14第十四药店':'36','16凤凰山药店':'50','17益丰店':'13','21富源店':'63',
            };
            // 过滤出有 krec 的项
            const validMiss = cacheMiss.filter(it => storeKrec[it.store_name]);
            if (validMiss.length === 0) break;

            const precQuery = await pool.request()
              .input('code', sql.NVarChar(50), product_code)
              .query(`SELECT rec FROM ZHYYLS.dbo.Vptype WHERE usercode = @code`);
            const prec = precQuery.recordset?.[0]?.rec;
            if (!prec) break;

            // 用 temp table 传入 (krec, since) 配对，按每个门店自己的 since 过滤
            const tempValues: string[] = [];
            const req = pool.request();
            req.input('prec', sql.Int, prec);
            validMiss.forEach((it, i) => {
              req.input(`k${i}`, sql.VarChar(10), storeKrec[it.store_name]);
              req.input(`s${i}`, sql.VarChar(10), it.since);
              tempValues.push(`(@k${i}, @s${i})`);
            });
            const res = await req.query(`
                SELECT t.krec, ISNULL(SUM(ABS(vs.Qty)), 0) as transit_qty
                FROM (VALUES ${tempValues.join(',')}) AS t(krec, since)
                CROSS APPLY (
                    SELECT vs.Qty
                    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH (NOLOCK)
                    WHERE vs.PRec = @prec AND vs.OutKRec = '3'
                      AND vs.InKRec = t.krec
                      AND vs.BillDate >= t.since
                      AND (vs.Comment IS NULL OR vs.Comment NOT LIKE '%调货出库单%')
                ) vs
                GROUP BY t.krec
              `);
            const krecToStore: Record<string, string> = {};
            Object.entries(storeKrec).forEach(([name, k]) => { krecToStore[k] = name; });
            const qtyByKrec: Record<string, number> = {};
            (res.recordset || []).forEach((row: any) => {
              qtyByKrec[String(row.krec)] = Number(row.transit_qty) || 0;
            });
            // 回填缓存 + transitMap
            for (const it of validMiss) {
              const krec = storeKrec[it.store_name];
              const qty = qtyByKrec[krec] || 0;
              const ck = `${product_code}|${it.store_name}|${it.since}`;
              transitCache.set(ck, { value: qty, ts: Date.now() });
              transitMap[it.store_name] = (transitMap[it.store_name] || 0) + qty;
            }
          } finally { releasePool(pool); }
        } catch (e) {
          console.warn('[get_realtime_transit] 查询失败:', e);
        }
        result = { transitMap };
        break;
      }

      case "get_suppliers": {
        // 单独查询供货商（ZHYYLS Vptype.comment），失败不阻塞主列表
        const { product_codes: suppCodes } = params as { product_codes?: string[] };
        if (!suppCodes || !Array.isArray(suppCodes) || suppCodes.length === 0) {
          result = { supplierLookup: {} };
          break;
        }
        const supplierLookup: Record<string, string> = {};
        function normalizeSupplierCode(code: string) {
          return (code || '').trim().toUpperCase().replace(/^0+/, '');
        }
        try {
          const pool = await getPool();
          try {
            const rawCodes = [...new Set(suppCodes.filter(Boolean))];
            const normCodes = [...new Set(rawCodes.map(c => normalizeSupplierCode(c)).filter(c => c))];
            const allCodes = [...new Set([...rawCodes, ...normCodes])];
            const CODE_BATCH = 500;
            for (let i = 0; i < allCodes.length; i += CODE_BATCH) {
              const batch = allCodes.slice(i, i + CODE_BATCH);
              const req = pool.request();
              const codeIn: string[] = [];
              batch.forEach((c, j) => { req.input(`c${j}`, sql.NVarChar(50), c); codeIn.push(`@c${j}`); });
              const res = await req.query(
                `SELECT LTRIM(RTRIM(ISNULL(usercode, ''))) as code, LTRIM(RTRIM(ISNULL(comment, ''))) as supplier FROM ZHYYLS.dbo.Vptype WITH (NOLOCK) WHERE usercode IN (${codeIn.join(',')}) AND comment IS NOT NULL AND comment != ''`
              );
              (res.recordset || []).forEach((r: any) => {
                const code = (r.code || '').trim().toUpperCase();
                const norm = normalizeSupplierCode(code);
                if (code && !supplierLookup[code]) supplierLookup[code] = r.supplier || '';
                if (norm && !supplierLookup[norm]) supplierLookup[norm] = r.supplier || '';
              });
            }
            console.log(`[get_suppliers] 查询 ${allCodes.length} 个编码，命中 ${Object.keys(supplierLookup).length} 条`);
          } finally { releasePool(pool); }
        } catch (e) {
          console.error('[get_suppliers] 查询失败:', e);
        }
        result = { supplierLookup };
        break;
      }

      case "check_order_status": {
        // 检测入库/配送状态：按商品上报日期后查采购入库和配送记录（批量临时表）
        const { product_codes, store_pos_names, demands } = params;
        if (!product_codes || !Array.isArray(product_codes) || product_codes.length === 0) {
          result = { buyMap: {}, sendMap: {}, stuckMap: {} };
          break;
        }
        const storeKrec: Record<string, string> = {
          '02第二药店': '5', '03第三药店': '6', '04第四药店': '7',
          '06常口店': '9', '08第八药店': '66', '09第九药店': '11',
          '14第十四药店': '36', '16凤凰山药店': '50', '17益丰店': '13', '21富源店': '63',
        };
        const storeIdToName: Record<string, string> = {
          'wszhyy02': '02第二药店', 'wszhyy03': '03第三药店', 'wszhyy04': '04第四药店',
          'wszhyy06': '06常口店', 'wszhyy08': '08第八药店', 'wszhyy09': '09第九药店',
          'wszhyy14': '14第十四药店', 'wszhyy16': '16凤凰山药店', 'wszhyy17': '17益丰店', 'wszhyy21': '21富源店',
        };
        try {
          const pool = await getPool();
          try {
            // 1. 从 Supabase 获取每个商品+门店的最早上报日期
            const { data: reportDates } = await supabase
              .from("reports")
              .select("product_code, store_id, created_at")
              .in("product_code", product_codes)
              .eq("order_type", "缺货订购");
            const sinceStoreMap: Record<string, Record<string, string>> = {};
            (reportDates || []).forEach((r: any) => {
              if (!r.product_code || !r.created_at || !r.store_id) return;
              const d = toBjDate(r.created_at);
              if (!sinceStoreMap[r.product_code]) sinceStoreMap[r.product_code] = {};
              if (!sinceStoreMap[r.product_code][r.store_id] || d < sinceStoreMap[r.product_code][r.store_id]) {
                sinceStoreMap[r.product_code][r.store_id] = d;
              }
            });

            // 2. 批量查 PRec
            const precMap: Record<string, number> = {};
            const CODE_BATCH = 200;
            for (let i = 0; i < product_codes.length; i += CODE_BATCH) {
              const batch = product_codes.slice(i, i + CODE_BATCH);
              const precReq = pool.request();
              const precIn: string[] = [];
              batch.forEach((c, j) => { precReq.input(`c${j}`, sql.NVarChar(50), c); precIn.push(`@c${j}`); });
              const precRes = await precReq.query(`SELECT rec, usercode FROM ZHYYLS.dbo.Vptype WITH (NOLOCK) WHERE usercode IN (${precIn.join(',')})`);
              (precRes.recordset || []).forEach((r: any) => { precMap[r.usercode] = r.rec; });
            }

            const storeNames = (store_pos_names || {}) as Record<string, string[]>;
            const demandMap = (demands || {}) as Record<string, Record<string, number>>;
            const buyMap: Record<string, string> = {};
            const sendMap: Record<string, string> = {};
            const TB = 50;

            // 3. buyMap：仓库实时库存 > 0 OR 上报日期后采购入库 > 0
            // 3a) 仓库实时库存
            const whReq = pool.request();
            const whIn: string[] = [];
            product_codes.forEach((c: any, i: number) => {
              whReq.input(`w${i}`, sql.NVarChar(50), validateInput(c, "商品编码", 50));
              whIn.push(`@w${i}`);
            });
            const whRes = whIn.length > 0
              ? await whReq.query(`
                  SELECT v.usercode, ISNULL(SUM(gs.qty), 0) as wh_qty
                  FROM ZHYYLS.dbo.Vptype v WITH (NOLOCK)
                  JOIN ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK) ON gs.prec = v.rec AND gs.krec = '3'
                  WHERE v.usercode IN (${whIn.join(',')})
                  GROUP BY v.usercode
                `)
              : { recordset: [] };
            (whRes.recordset || []).forEach((r: any) => {
              if (r.wh_qty > 0) buyMap[r.usercode] = 'Y';
            });

            // 3b) 上报日期后采购入库（按该商品当前活动门店的最早日期）
            const buyPairs: Array<{ prec: number; since: string; code: string }> = [];
            for (const code of product_codes) {
              const prec = precMap[code];
              if (!prec) continue;
              const activeStores = Object.keys(sinceStoreMap[code] || {});
              if (activeStores.length === 0) continue;
              const since = activeStores.reduce((min, sid) => {
                const d = sinceStoreMap[code][sid];
                return !min || d < min ? d : min;
              }, '' as string);
              if (since) buyPairs.push({ prec, since, code });
            }
            for (let i = 0; i < buyPairs.length; i += TB) {
              const batch = buyPairs.slice(i, i + TB);
              const req = pool.request();
              const vals: string[] = [];
              batch.forEach((bp, j) => {
                req.input(`p${j}`, sql.Int, bp.prec);
                req.input(`s${j}`, sql.VarChar(10), bp.since);
                vals.push(`(@p${j}, @s${j})`);
              });
              const res = await req.query(`
                CREATE TABLE #ZHT_Buy (prec INT, since VARCHAR(10));
                INSERT INTO #ZHT_Buy (prec, since) VALUES ${vals.join(',')};
                SELECT z.prec, ISNULL(SUM(ABS(v.Qty)), 0) as total_qty
                FROM #ZHT_Buy z
                JOIN ZHYYLS.dbo.vBuySendSumDetail v WITH (NOLOCK)
                  ON v.PRec = z.prec AND v.BillDate >= z.since
                WHERE v.BillType = 34 AND v.InKRec = '3'
                GROUP BY z.prec;
                DROP TABLE #ZHT_Buy;
              `);
              (res.recordset || []).forEach((row: any) => {
                if (row.total_qty > 0) {
                  const pair = buyPairs.find(p => p.prec === row.prec);
                  if (pair) buyMap[pair.code] = 'Y';
                }
              });
            }

            // 4. sendMap：每个上报门店（门店实时库存 > 0 OR 上报日期后配送总量 > 0）
            const sendPairs: Array<{ prec: number; krec: string; since: string; code: string; storeName: string }> = [];
            for (const code of product_codes) {
              const prec = precMap[code];
              if (!prec) continue;
              const storeDemands = demandMap[code] || {};
              for (const [storeId, qty] of Object.entries(storeDemands)) {
                const storeName = storeIdToName[storeId] || '';
                const k = storeKrec[storeName];
                const since = sinceStoreMap[code]?.[storeId];
                if (k && since) sendPairs.push({ prec, krec: k, since, code, storeName });
              }
            }
            const stockMap: Record<string, boolean> = {};
            const transitMap2: Record<string, boolean> = {};

            // 4a) 门店实时库存
            for (let i = 0; i < sendPairs.length; i += TB) {
              const batch = sendPairs.slice(i, i + TB);
              const req = pool.request();
              const vals: string[] = [];
              batch.forEach((sp, j) => {
                req.input(`c${j}`, sql.NVarChar(50), sp.code);
                req.input(`k${j}`, sql.NVarChar(10), sp.krec);
                vals.push(`(@c${j}, @k${j})`);
              });
              const res = await req.query(`
                CREATE TABLE #ZHT_Stock (code NVARCHAR(50), krec NVARCHAR(10));
                INSERT INTO #ZHT_Stock (code, krec) VALUES ${vals.join(',')};
                SELECT z.code, z.krec, ISNULL(SUM(gs.qty), 0) as st_qty
                FROM #ZHT_Stock z
                JOIN ZHYYLS.dbo.Vptype v ON v.usercode = z.code
                LEFT JOIN ZHYYLS.dbo.GoodsStocks gs ON gs.prec = v.rec AND gs.krec = z.krec
                GROUP BY z.code, z.krec;
                DROP TABLE #ZHT_Stock;
              `);
              (res.recordset || []).forEach((row: any) => {
                const pair = sendPairs.find(p => p.code === row.code && p.krec === String(row.krec));
                if (pair && row.st_qty > 0) stockMap[`${pair.code}||${pair.storeName}`] = true;
              });
            }

            // 4b) 上报日期后配送（仓库→门店，排除调拨）
            for (let i = 0; i < sendPairs.length; i += TB) {
              const batch = sendPairs.slice(i, i + TB);
              const req = pool.request();
              const vals: string[] = [];
              batch.forEach((sp, j) => {
                req.input(`p${j}`, sql.Int, sp.prec);
                req.input(`k${j}`, sql.NVarChar(10), sp.krec);
                req.input(`s${j}`, sql.VarChar(10), sp.since);
                vals.push(`(@p${j}, @k${j}, @s${j})`);
              });
              const res = await req.query(`
                CREATE TABLE #ZHT_Send (prec INT, krec NVARCHAR(10), since VARCHAR(10));
                INSERT INTO #ZHT_Send (prec, krec, since) VALUES ${vals.join(',')};
                SELECT z.prec, z.krec, ISNULL(SUM(ABS(v.Qty)), 0) as total_qty
                FROM #ZHT_Send z
                JOIN ZHYYLS.dbo.vBuySendSumDetail v WITH (NOLOCK)
                  ON v.PRec = z.prec AND v.InKRec = z.krec
                WHERE v.OutKRec = '3'
                  AND v.BillDate >= z.since
                  AND (v.Comment IS NULL OR v.Comment NOT LIKE '%调货出库单%')
                GROUP BY z.prec, z.krec;
                DROP TABLE #ZHT_Send;
              `);
              (res.recordset || []).forEach((row: any) => {
                const pair = sendPairs.find(p => p.prec === row.prec && p.krec === String(row.krec));
                if (pair && row.total_qty > 0) transitMap2[`${pair.code}||${pair.storeName}`] = true;
              });
            }

            // 4c) 汇总 sendMap：所有上报门店都满足
            for (const code of product_codes) {
              const storeDemands = demandMap[code] || {};
              const names = Object.keys(storeDemands).map(sid => storeIdToName[sid]).filter(Boolean);
              if (names.length === 0) continue;
              // 至少有一个上报门店满足（库存>0 或 配送>0）即视为该商品已配送
              let anySatisfied = false;
              for (const sn of names) {
                if (stockMap[`${code}||${sn}`] || transitMap2[`${code}||${sn}`]) {
                  anySatisfied = true;
                  break;
                }
              }
              if (anySatisfied) sendMap[code] = 'Y';
            }

            // 5. stuckMap：已入库但未配送
            const stuckMap: Record<string, string> = {};
            for (const code of product_codes) {
              if (buyMap[code] && !sendMap[code]) stuckMap[code] = 'Y';
            }
            result = { buyMap, sendMap, stuckMap };
          } finally { releasePool(pool); }
        } catch (e) {
          console.error('check_order_status 查询失败:', e);
          result = { buyMap: {}, sendMap: {}, stuckMap: {} };
        }
        break;
      }

      case "restore_reports": {
        // 智能恢复：只恢复备份中存在的记录，保留备份后新增的记录
        const { backup_reports } = params as { backup_reports: any[] };
        if (!backup_reports || !Array.isArray(backup_reports) || backup_reports.length === 0) {
          result = { restored: 0, kept: 0, message: "备份数据为空" };
          break;
        }
        
        // 1. 获取当前所有记录
        const { data: currentAll, error: fetchErr } = await supabase
          .from("reports")
          .select("id")
          .order("created_at", { ascending: false })
          .limit(10000);
        
        if (fetchErr) throw fetchErr;
        
        const backupIdSet = new Set(backup_reports.map(r => r.id).filter(Boolean));
        const currentBefore = (currentAll || []).length;
        
        // 2. 删除当前库中与备份重叠的记录（恢复它们到备份状态）
        const idsToDelete = backup_reports.map(r => r.id).filter(Boolean);
        let deletedCount = 0;
        if (idsToDelete.length > 0) {
          const batchSize = 500;
          for (let i = 0; i < idsToDelete.length; i += batchSize) {
            const batch = idsToDelete.slice(i, i + batchSize);
            const { error: delErr } = await supabase.from("reports").delete().in("id", batch);
            if (!delErr) deletedCount += batch.length;
          }
        }
        
        // 3. 重新插入备份记录（恢复原始状态）
        let insertedCount = 0;
        const insertBatchSize = 200;
        for (let i = 0; i < backup_reports.length; i += insertBatchSize) {
          const batch = backup_reports.slice(i, i + insertBatchSize);
          const { error: insErr } = await supabase.from("reports").insert(batch);
          if (!insErr) insertedCount += batch.length;
        }
        
        // 4. 统计：新增记录 = 当前总数（备份已插入） - 备份插入数 - （原始 - 删除重叠）
        // 新增 = 当前剩余（即当前库中不在备份id范围的记录）
        const { data: afterAll } = await supabase
          .from("reports")
          .select("id")
          .order("created_at", { ascending: false })
          .limit(10000);
        const afterTotal = (afterAll || []).length;
        const keptNew = afterTotal - insertedCount;
        
        result = { 
          restored: insertedCount, 
          deleted: deletedCount, 
          kept_new: keptNew,
          total: afterTotal,
          message: `已恢复 ${insertedCount} 条，保留新增 ${keptNew} 条，共 ${afterTotal} 条`
        };
        break;
      }

      default:
        return new Response(JSON.stringify({ error: "无效的操作" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const responseBody: any = { success: true, data: result };
    if (result && result.debug) {
      responseBody.debug = result.debug;
      delete result.debug;
    }
    if (lastRefreshTime) {
      responseBody.last_refresh = lastRefreshTime;
    }
    return new Response(JSON.stringify(responseBody), {
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    console.error("Edge Function 错误:", err);
    return new Response(JSON.stringify({ error: friendlyError(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  }
});
