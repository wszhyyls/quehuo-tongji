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
const SQL_SERVER_PORT = parseInt(Deno.env.get("SQL_SERVER_PORT") || "1311");
const SQL_SERVER_USER = Deno.env.get("SQL_SERVER_USER")!;
const SQL_SERVER_PWD = Deno.env.get("SQL_SERVER_PASSWORD")!;
const SQL_SERVER_DB = Deno.env.get("SQL_SERVER_DATABASE") || "RQZT";

const sqlConfig = {
  server: SQL_SERVER_HOST,
  port: SQL_SERVER_PORT,
  user: SQL_SERVER_USER,
  password: SQL_SERVER_PWD,
  database: SQL_SERVER_DB,
  connectionTimeout: 60000,
  requestTimeout: 120000,
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
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const pool = await sql.connect(config);
      poolCache.set(cacheKey, { pool, lastUsed: now, inUse: true });
      if (attempt > 1) console.log(`[定时任务] 第${attempt}次重试连接成功`);
      return pool;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1000));
        console.warn(`[定时任务] 连接失败(尝试${attempt}/3)，重试中...`);
      }
    }
  }
  console.error(`[定时任务] 3次连接全部失败:`, lastErr);
  throw lastErr;
}

function releasePool(pool: sql.ConnectionPool, dbName: string = SQL_SERVER_DB) {
  const cache = poolCache.get(dbName);
  if (cache && cache.pool === pool) {
    cache.inUse = false;
    cache.lastUsed = Date.now();
  }
}

// ========== v5.2 精准自动检测：按门店匹配库存，批量UPDATE ==========
async function preciseAutoDetectStatus(
  pool: sql.ConnectionPool,
  supabaseClient: any
): Promise<{ detected: number; details: string[] }> {
  const details: string[] = [];
  
  try {
    const feedbackResult = await pool.request().query(`
      SELECT TOP 50 商品编码, 补货状态, ISNULL(实际订货数量, 0) as 订货数量
      FROM dbo.Shortage_OrderFeedback WITH (NOLOCK)
      WHERE 补货状态 NOT IN ('已完成', '厂家断货')
      ORDER BY CASE 补货状态 WHEN '已订购' THEN 0 ELSE 1 END, 订货时间 DESC
    `);
    const orderedItems: any[] = feedbackResult.recordset || [];
    if (orderedItems.length === 0) return { detected: 0, details: ['无待检测商品'] };
    
    const orderedCodes: string[] = orderedItems.map((r: any) => r.商品编码);
    details.push(`${orderedCodes.length}个待检测: ${orderedCodes.slice(0, 10).join(', ')}${orderedCodes.length > 10 ? '...' : ''}`);
    
    // 从 Supabase 获取门店映射
    const { data: reportRecords } = await supabaseClient
      .from("reports")
      .select("product_code, store_name")
      .in("product_code", orderedCodes)
      .order("created_at", { ascending: false })
      .limit(500);
    
    const productStoreMap: Record<string, string> = {};
    for (const r of (reportRecords || [])) {
      if (!productStoreMap[r.product_code] && r.store_name) productStoreMap[r.product_code] = r.store_name;
    }
    
    const noStoreCodes = orderedCodes.filter(c => !productStoreMap[c]);
    if (noStoreCodes.length > 0) {
      details.push(`⚠ 未找到门店: ${noStoreCodes.slice(0, 10).join(', ')}${noStoreCodes.length > 10 ? `...共${noStoreCodes.length}个` : ''}`);
    }
    
    const items: [string, string, number, string][] = [];
    orderedItems.forEach((item: any) => {
      const store = productStoreMap[item.商品编码];
      if (store) items.push([item.商品编码, store, item.订货数量, item.补货状态]);
    });
    details.push(`有门店: ${items.length}个 ${items.slice(0, 5).map(([c,s,q,st]) => `${c}@${s}(${st}×${q})`).join(', ')}${items.length > 5 ? '...' : ''}`);
    if (items.length === 0) return { detected: 0, details };
    
    // v5.4: RQZT跨库查 ZHYYLS 实时库存+在途（门店名→krec精确映射）
    const storeMap: Record<string,string> = {
      '02第二药店':'5','03第三药店':'6','04第四药店':'7','06常口店':'9',
      '09第九药店':'11','17益丰店':'13','14第十四药店':'36','16凤凰山药店':'50',
      '21富源店':'63','08第八药店':'66'
    };
    const storeToKrec = (n:string):string => storeMap[n] || '';
    const stockLookup: Record<string, { 门店库存: number; 在途: number }> = {};
    
    for (const [code, store] of items) {
      const krec = storeToKrec(store);
      if (!krec) continue;
      try {
        const req = pool.request();
        req.input("code", sql.NVarChar, code).input("krec", sql.NVarChar, krec);
        const stockR = await req.query(`
          SELECT ISNULL(SUM(gs.qty), 0) as 门店库存
          FROM ZHYYLS.dbo.Vptype v JOIN ZHYYLS.dbo.GoodsStocks gs ON gs.prec = v.rec
          WHERE v.usercode = @code AND gs.krec = @krec
        `);
        stockLookup[`${code}|||${store}`] = { 门店库存: (stockR.recordset?.[0] as any)?.门店库存 || 0, 在途: 0 };
      } catch (_e) {}
    }
    
    // 批量查在途
    try {
      const today = new Date().toISOString().substring(0,10);
      const d30 = new Date(Date.now()-30*86400000).toISOString().substring(0,10);
      const tr = await pool.request().query(`EXEC ZHYYLS.dbo.Gp_SendDoing 0,'','',0,0,0,'${d30}','${today}',0,0,0,2`);
      if (tr.recordset?.length) {
        const tm: Record<string,number>={}, recs:number[]=[];
        for (const r of tr.recordset) { if(r.PRec&&r.posid&&r.Qty){ const k=`${r.posid}|||${r.PRec}`; tm[k]=(tm[k]||0)+Number(r.Qty); recs.push(r.PRec); } }
        const pr=pool.request(); [...new Set(recs)].forEach((p,i)=>{pr.input(`p${i}`,sql.Int,p)});
        const pm:Record<number,string>={};
        const pi=[...new Set(recs)].map((_,i)=>`@p${i}`);
        if(pi.length){ (await pr.query(`SELECT rec,usercode FROM ZHYYLS.dbo.vPtype WHERE rec IN(${pi.join(',')})`)).recordset?.forEach((r:any)=>{pm[r.rec]=r.usercode}); }
        for(const [code,store] of items){let tq=0; const k=storeToKrec(store); if(k){ for(const[r,u]of Object.entries(pm)){if(u===code)tq+=tm[`${k}|||${r}`]||0}; if(stockLookup[`${code}|||${store}`])stockLookup[`${code}|||${store}`].在途=tq } }
      }
    } catch(_e){ details.push('⚠ 在途查询失败'); }
    
    const toComplete: string[] = [];
    
    // 按商品分组
    const productGroups: Record<string, { stores: string[]; qty: number }> = {};
    for (const [code, store, qty] of items) {
      if (!productGroups[code]) productGroups[code] = { stores: [], qty };
      productGroups[code].stores.push(store);
    }
    
    for (const [code, group] of Object.entries(productGroups)) {
      const stores = group.stores;
      const qty = group.qty;
      
      // 仓库库存（krec 不在门店列表中即为仓库）
      let warehouseStock = 0;
      try {
        const whR = await pool.request().input("code", sql.NVarChar, code).query(`
          SELECT ISNULL(SUM(gs.qty),0) as 仓库库存
          FROM ZHYYLS.dbo.Vptype v JOIN ZHYYLS.dbo.GoodsStocks gs ON gs.prec=v.rec
          WHERE v.usercode=@code AND gs.krec = '3'
        `);
        warehouseStock = (whR.recordset?.[0] as any)?.仓库库存 || 0;
      } catch (_) {}
      
      if (warehouseStock > qty) {
        toComplete.push(code);
        details.push(`✅ ${code} 仓库${warehouseStock}>订货${qty} → 已完成`);
        continue;
      }
      
      let allOk = true;
      for (const store of stores) {
        const row = stockLookup[`${code}|||${store}`];
        if (!row || !(row.门店库存>qty||row.在途>qty)) { allOk = false; break; }
      }
      if (allOk && stores.length > 0) { toComplete.push(code); details.push(`✅ ${code} 全部门店满足 → 已完成`); }
      else details.push(`❌ ${code} 不满足 订货=${qty}`);
    }
    
    // 一次性批量UPDATE
    if (toComplete.length > 0) {
      const note = `自动完成(门店精准匹配) ${new Date().toISOString().substring(0, 16).replace('T', ' ')}`;
      const updReq = pool.request();
      updReq.input("备注", sql.NVarChar(500), note);
      const inParams: string[] = [];
      toComplete.forEach((code, i) => {
        inParams.push(`@upc${i}`);
        updReq.input(`upc${i}`, sql.NVarChar, code);
      });
      
      const updateResult = await updReq.query(`
        UPDATE dbo.Shortage_OrderFeedback
        SET 补货状态 = '已完成', 到货确认时间 = GETDATE(),
            备注 = ISNULL(备注, '') + ' | ' + @备注
        OUTPUT INSERTED.商品编码
        WHERE 商品编码 IN (${inParams.join(', ')}) AND 补货状态 NOT IN ('已完成', '厂家断货')
      `);
      const actual = (updateResult.recordset || []).length;
      details.push(`SQL批量更新: ${actual}个`);
      
      // 同步更新 Supabase reports
      try {
        const { error: rptErr } = await supabaseClient
          .from("reports")
          .update({ replenish_status: '已完成' })
          .in("product_code", toComplete);
        if (rptErr) details.push(`⚠ Supabase同步失败: ${rptErr.message}`);
        else details.push(`Supabase同步: ${toComplete.length}个`);
      } catch (_e: any) { details.push(`⚠ Supabase异常: ${String(_e)}`); }
      
      return { detected: actual, details };
    }
    return { detected: 0, details };
  } catch (err) {
    console.error('[scheduled-task preciseAutoDetect] 错误:', err);
    return { detected: 0, details: [String(err)] };
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

// 同步采购计划（执行存储过程 + 更新Supabase缓存）
async function syncPurchasePlan(): Promise<{ success: boolean; message: string; supabase_synced?: number; error?: string }> {
  console.log('[定时任务] 开始同步采购计划...');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const pool = await getPool();
  
  try {
    // 执行同步存储过程
    await pool.request().execute('usp_Sync_AllShortageCache');
    console.log('[定时任务] SPFXB_Result 同步完成');
    
    // v5.1: 禁用全局汇总自动检测，已完成状态需手动确认
    // await pool.request().execute('usp_AutoDetectOrderStatus_Feedback');
    console.log('[定时任务] 自动状态检测已禁用(已完成需手动确认)');
    
    // ========== 同步到 Supabase 缓存 ==========
    let supabaseSynced = 0;
    try {
      const resultSet = await pool.request().query(`
        SELECT 
          LTRIM(RTRIM(ISNULL(商品编码, ''))) as product_code,
          LTRIM(RTRIM(ISNULL(门店名称, ''))) as store_name,
          ISNULL(库存数量, 0) as store_stock,
          ISNULL(在途数量, 0) as in_transit,
          ISNULL(门店库存汇总, 0) as store_total,
          ISNULL(配送中心库存数量, 0) as dc_stock,
          ISNULL(前30天销售数量, 0) as sales_30days,
          ISNULL(ISNULL(标准库存数量确认, 标准库存数量), 0) as standard_stock,
          ISNULL(门店计划, 0) as store_plan
        FROM dbo.SPFXB_Result WITH (NOLOCK)
        WHERE 商品编码 IS NOT NULL AND LTRIM(RTRIM(商品编码)) <> ''
      `);
      
      const records = resultSet.recordset || [];
      if (records.length > 0) {
        // 增量 UPSERT，消除全量清空的空窗期
        const batchSize = 300;
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize).map((r: any) => ({
            product_code: r.product_code, store_name: r.store_name,
            store_stock: r.store_stock, in_transit: r.in_transit,
            store_total: r.store_total, dc_stock: r.dc_stock,
            sales_30days: r.sales_30days, standard_stock: r.standard_stock,
            store_plan: r.store_plan, last_updated: new Date().toISOString()
          }));
          const { error: upsertErr } = await supabase.from("shortage_storestock_cache")
            .upsert(batch, { onConflict: 'product_code,store_name' });
          if (!upsertErr) supabaseSynced += batch.length;
        }
      }
      console.log(`[定时任务] Supabase缓存已更新 ${supabaseSynced} 条`);
    } catch (e) {
      console.error('[定时任务] Supabase缓存更新失败:', e);
    }
    
    // v5.2: 按门店精确匹配的自动检测
    let autoDetectCount = 0;
    try {
      const detectR = await preciseAutoDetectStatus(pool, supabase);
      autoDetectCount = detectR.detected;
      console.log(`[定时任务] 精准检测: ${autoDetectCount}个已完成`);
    } catch (detectErr) {
      console.error('[定时任务] 精准检测失败:', detectErr);
    }
    
    return { success: true, message: `同步完成，${autoDetectCount}个已完成`, supabase_synced: supabaseSynced, auto_detected: autoDetectCount };
    
  } catch (err) {
    console.error('[定时任务] 采购计划同步失败:', err);
    return { success: false, message: '采购计划同步失败', error: String(err) };
  } finally {
    releasePool(pool);
  }
}

// 刷新 RQZT 商品缓存表（从 ZHYYLS 同步到 RQZT 本地）
async function syncRQZTProductCache(): Promise<{ success: boolean; message: string; count?: number; time_ms?: number; error?: string }> {
  console.log('[定时任务] 开始刷新 RQZT 商品缓存表...');
  const pool = await getPool();
  const startTime = Date.now();
  
  try {
    await pool.request().execute('usp_Sync_ProductCache_RQZT');
    const elapsed = Date.now() - startTime;
    console.log(`[定时任务] RQZT 商品缓存刷新完成，耗时 ${elapsed}ms`);
    return { success: true, message: 'RQZT商品缓存刷新完成', time_ms: elapsed };
  } catch (err) {
    console.error('[定时任务] RQZT 商品缓存刷新失败:', err);
    return { success: false, message: 'RQZT商品缓存刷新失败', error: String(err) };
  } finally {
    releasePool(pool);
  }
}

// 完整同步（RQZT缓存 + 商品缓存 + 采购计划）
async function fullSync(): Promise<{ success: boolean; rqztSync: any; productSync: any; planSync: any }> {
  console.log('[定时任务] 开始完整同步...');
  const rqztResult = await syncRQZTProductCache();
  const productResult = await syncProductCache();
  const planResult = await syncPurchasePlan();
  
  return {
    success: rqztResult.success && productResult.success && planResult.success,
    rqztSync: rqztResult,
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
        // 完整同步：RQZT缓存 + 商品缓存 + 采购计划
        result = await fullSync();
        break;
      }
      
      case "sync_rqzt_cache": {
        // 仅刷新 RQZT 商品缓存表
        result = await syncRQZTProductCache();
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
          available_actions: ["full_sync", "sync_rqzt_cache", "sync_product", "sync_plan", "get_logs", "health"]
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
