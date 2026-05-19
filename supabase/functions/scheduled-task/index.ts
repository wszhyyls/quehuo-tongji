// Supabase Edge Function - 定时任务
// v3.12: 定时自动同步采购计划和商品缓存
// 使用方式：
// 1. Supabase Cron: 调用 cron.job 调度
// 2. 手动触发: POST /functions/v1/scheduled-task { "action": "full_sync" }

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import sql from "https://esm.sh/mssql@9";

// ========== 环境变量配置 ==========
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SQL_SERVER_HOST = Deno.env.get("SQL_SERVER_HOST")!;
const SQL_SERVER_PORT = parseInt(Deno.env.get("SQL_SERVER_PORT") || "1290");
const SQL_SERVER_USER = Deno.env.get("SQL_SERVER_USER")!;
const SQL_SERVER_PWD = Deno.env.get("SQL_SERVER_PASSWORD")!;
const SQL_SERVER_DB = Deno.env.get("SQL_SERVER_DATABASE") || "RQZT";

const sqlConfig = {
  server: SQL_SERVER_HOST,
  port: SQL_SERVER_PORT,
  user: SQL_SERVER_USER,
  password: SQL_SERVER_PWD,
  database: SQL_SERVER_DB,
  connectionTimeout: 30000,
  requestTimeout: 60000,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
};

// ========== SQL 连接池 ==========
interface PoolCache {
  pool: sql.ConnectionPool;
  lastUsed: number;
  inUse: boolean;
}

const poolCache: Map<string, PoolCache> = new Map();

async function getPool(dbName: string = SQL_SERVER_DB): Promise<sql.ConnectionPool> {
  const cacheKey = dbName;
  const now = Date.now();
  
  for (const [key, cache] of poolCache.entries()) {
    if (now - cache.lastUsed > 300000 && !cache.inUse) {
      try { await cache.pool.close(); } catch (e) {}
      poolCache.delete(key);
    }
  }
  
  const existing = poolCache.get(cacheKey);
  if (existing && !existing.inUse && now - existing.lastUsed < 300000) {
    existing.inUse = true;
    existing.lastUsed = now;
    return existing.pool;
  }
  
  if (poolCache.size >= 5) {
    for (const [key, cache] of poolCache.entries()) {
      if (!cache.inUse) {
        try { await cache.pool.close(); } catch (e) {}
        poolCache.delete(key);
        break;
      }
    }
  }
  
  const config = dbName === SQL_SERVER_DB ? sqlConfig : { ...sqlConfig, database: dbName };
  try {
    const pool = await sql.connect(config);
    poolCache.set(cacheKey, { pool, lastUsed: now, inUse: true });
    return pool;
  } catch (err) {
    console.error(`连接SQL Server失败 (${dbName}):`, err);
    throw err;
  }
}

function releasePool(pool: sql.ConnectionPool, dbName: string = SQL_SERVER_DB) {
  const cache = poolCache.get(dbName);
  if (cache && cache.pool === pool) {
    cache.inUse = false;
    cache.lastUsed = Date.now();
  }
}

// ========== 定时任务实现 ==========

// 同步商品缓存到 Supabase
async function syncProductCache(): Promise<{ success: boolean; message: string; count?: number; error?: string }> {
  console.log('[定时任务] 开始同步商品缓存...');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const pool = await getPool();
  
  try {
    // 从 SQL Server 获取全量商品
    const result = await pool.request().query(`
      SELECT 
        p.USERCODE as product_code,
        p.NAME as product_name,
        p.SPEC as product_spec,
        p.MANUFACTURER as manufacturer,
        LOWER(ISNULL(p.CODE1, '')) as pinyin_code,
        p.TYPEID as category_id,
        p.UNIT as unit,
        p.PRICE as price,
        p.VPTYPE as vp_type
      FROM dbo.Vptype p
      WHERE p.TYPEId IS NOT NULL AND LTRIM(RTRIM(p.TYPEId)) <> ''
      ORDER BY p.NAME
    `);
    
    const products = result.recordset || [];
    console.log(`[定时任务] 获取商品 ${products.length} 条`);
    
    // 先清空旧缓存
    const { error: deleteError } = await supabase.from('product_cache').delete().neq('product_code', '___never_match___');
    if (deleteError) {
      console.error('[定时任务] 清空商品缓存失败:', deleteError);
    }
    
    // 分批插入（每批200条）
    const batchSize = 200;
    let totalInserted = 0;
    
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const { error: insertError } = await supabase.from('product_cache').insert(batch);
      
      if (insertError) {
        console.error(`[定时任务] 插入商品批次 ${i / batchSize + 1} 失败:`, insertError);
      } else {
        totalInserted += batch.length;
        console.log(`[定时任务] 已插入 ${totalInserted}/${products.length} 条`);
      }
    }
    
    console.log(`[定时任务] 商品缓存同步完成: ${totalInserted} 条`);
    return { success: true, message: '商品缓存同步完成', count: totalInserted };
    
  } catch (err) {
    console.error('[定时任务] 商品缓存同步失败:', err);
    return { success: false, message: '商品缓存同步失败', error: String(err) };
  } finally {
    releasePool(pool);
  }
}

// 同步采购计划（执行存储过程）
async function syncPurchasePlan(): Promise<{ success: boolean; message: string; error?: string }> {
  console.log('[定时任务] 开始同步采购计划...');
  const pool = await getPool();
  
  try {
    // 执行同步存储过程
    const syncResult = await pool.request().execute('usp_Sync_AllShortageCache');
    console.log('[定时任务] 采购计划同步存储过程执行完成');
    
    // 自动检测订货状态
    const detectResult = await pool.request().execute('usp_AutoDetectOrderStatus_Feedback');
    console.log('[定时任务] 订货状态自动检测完成');
    
    return { success: true, message: '采购计划同步完成' };
    
  } catch (err) {
    console.error('[定时任务] 采购计划同步失败:', err);
    return { success: false, message: '采购计划同步失败', error: String(err) };
  } finally {
    releasePool(pool);
  }
}

// 完整同步（商品缓存 + 采购计划）
async function fullSync(): Promise<{ success: boolean; productSync: any; planSync: any }> {
  console.log('[定时任务] 开始完整同步...');
  const productResult = await syncProductCache();
  const planResult = await syncPurchasePlan();
  
  return {
    success: productResult.success && planResult.success,
    productSync: productResult,
    planSync: planResult
  };
}

// 获取定时任务执行日志
async function getTaskLogs(): Promise<any[]> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const pool = await getPool();
  
  try {
    const result = await pool.request()
      .input("Top", sql.Int, 50)
      .execute('usp_GetSyncLog');
    return result.recordset || [];
  } catch (err) {
    console.error('[定时任务] 获取日志失败:', err);
    return [];
  } finally {
    releasePool(pool);
  }
}

// ========== CORS 头 ==========
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = [
    "https://wszhyy.pages.dev",
    "http://localhost:8780",
    "http://localhost:3000",
  ];
  const validOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  
  return {
    "Access-Control-Allow-Origin": validOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

// ========== 健康检查 ==========
async function healthCheck(): Promise<{ status: string; pools: number; timestamp: string }> {
  return {
    status: 'healthy',
    pools: poolCache.size,
    timestamp: new Date().toISOString()
  };
}

// ========== HTTP Server ==========
serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  
  try {
    let reqBody;
    try {
      reqBody = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "请使用 POST + JSON 格式调用" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    
    const { action } = reqBody;
    let result: any;
    
    switch (action) {
      case "full_sync": {
        // 完整同步：商品缓存 + 采购计划
        result = await fullSync();
        break;
      }
      
      case "sync_product": {
        // 仅同步商品缓存
        result = await syncProductCache();
        break;
      }
      
      case "sync_plan": {
        // 仅同步采购计划
        result = await syncPurchasePlan();
        break;
      }
      
      case "get_logs": {
        // 获取执行日志
        result = { success: true, data: await getTaskLogs() };
        break;
      }
      
      case "health": {
        // 健康检查
        result = await healthCheck();
        break;
      }
      
      default:
        return new Response(JSON.stringify({ 
          error: `未知操作: ${action}`,
          available_actions: ["full_sync", "sync_product", "sync_plan", "get_logs", "health"]
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
    
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
    
  } catch (err) {
    console.error('[定时任务] 错误:', err);
    return new Response(JSON.stringify({ 
      success: false, 
      error: String(err),
      hint: '检查 SQL Server 连接和存储过程是否可用'
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
