// Supabase Edge Function - 查询缺货系统数据
// v3.12: 连接池预热 + 查询超时保护 + 状态查询修复
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import sql from "https://esm.sh/mssql@9";

// 默认员工密码（从环境变量读取，安全性增强）
const DEFAULT_EMPLOYEE_PASSWORD = Deno.env.get("DEFAULT_EMPLOYEE_PASSWORD") || "wszh123456";

// ========== 特殊账号配置 ==========
// 这些账号不受设备授权和单设备登录限制
const EXEMPT_ACCOUNTS = ['admin', '15305479520'];

// ========== 辅助函数：检查是否是例外账号 ==========
function isExemptAccount(identifier: string): boolean {
  return EXEMPT_ACCOUNTS.includes(identifier);
}

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

// ========== SQL 连接池管理（性能优化）==========
// 缓存活跃的连接，复用而非每次新建
interface PoolCache {
  pool: sql.ConnectionPool;
  lastUsed: number;
  inUse: boolean;
}

const MAX_POOL_SIZE = 5;  // 最多缓存5个连接
const POOL_TTL = 300000;   // 5分钟后未使用则关闭连接
const poolCache: Map<string, PoolCache> = new Map();

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
    return existing.pool;
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
  
  // 创建新连接
  const config = dbName === SQL_SERVER_DB ? sqlConfig : { ...sqlConfig, database: dbName };
  try {
    const pool = await sql.connect(config);
    poolCache.set(cacheKey, {
      pool,
      lastUsed: now,
      inUse: true,
    });
    return pool;
  } catch (err) {
    console.error(`连接SQL Server失败 (${dbName}):`, err);
    throw err;
  }
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

// 允许的来源域名列表（安全增强）
const ALLOWED_ORIGINS = [
  "https://wszhyy.pages.dev",   // Cloudflare Pages 正式环境
  "https://wslzhyy.pages.dev",  // Cloudflare Pages 备用域名
  "http://localhost:8780",       // 本地开发环境
  "http://localhost:3000",        // 本地开发环境
];

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
};

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
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

    let result;
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
        // 获取全量商品数据（用于前端内存缓存）
        // 直接从 SQL Server 获取，绕过 Supabase 1000条限制
        const poolZHYYLS = await getPool();
        try {
          const productsResult = await poolZHYYLS.request()
            .query(`SELECT
                    LTRIM(RTRIM(ISNULL(a.USERCODE, ''))) as product_code,
                    LTRIM(RTRIM(ISNULL(a.FullName, ''))) as product_name,
                    LTRIM(RTRIM(ISNULL(a.Standard, ''))) as product_spec,
                    LTRIM(RTRIM(ISNULL(b.FullName, ''))) as manufacturer,
                    LTRIM(RTRIM(ISNULL(a.PYZJM, ''))) as pinyin_code
                    FROM ZHYYLS.dbo.Vptype a WITH (NOLOCK)
                    LEFT JOIN ZHYYLS.dbo.cstype b WITH (NOLOCK) ON a.area = b.rec
                    WHERE a.leveal = '3'
                      AND (
                        EXISTS (
                          SELECT 1 FROM ZHYYLS.dbo.Vsalebill s WITH (NOLOCK)
                          JOIN ZHYYLS.dbo.Vbillindex i WITH (NOLOCK) ON s.billid = i.billid
                          WHERE s.prec = a.rec
                            AND i.billdate >= DATEADD(year, -1, GETDATE())
                            AND i.BillType IN ('101', '102', '103', '104', '105')
                        )
                        OR EXISTS (
                          SELECT 1 FROM ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK)
                          WHERE gs.prec = a.rec
                            AND gs.qty > 0
                        )
                      )
                    ORDER BY a.USERCODE`);
          
          // 去重（以USERCODE为准）
          const productMap = new Map();
          productsResult.recordset.forEach(p => {
            const code = p.product_code ? p.product_code.trim() : '';
            if (code !== '' && !productMap.has(code)) {
              productMap.set(code, {
                product_code: code,
                product_name: p.product_name || '',
                product_spec: p.product_spec || '',
                manufacturer: p.manufacturer || '',
                pinyin_code: (p.pinyin_code || '').trim().toLowerCase(),
              });
            }
          });
          
          result = Array.from(productMap.values());
          console.log(`✅ get_all_products 返回 ${result.length} 个商品`);
        } finally {
          releasePool(poolZHYYLS);
        }
        break;
      }

      // ========== 检查商品列表是否有更新 ==========
      case "check_products_update": {
        // 返回当前商品总数和最后更新时间，用于前端判断是否需要更新
        const poolZHYYLS = await getPool();
        try {
          const countResult = await poolZHYYLS.request()
            .query(`SELECT COUNT(DISTINCT a.USERCODE) as product_count
                    FROM ZHYYLS.dbo.Vptype a WITH (NOLOCK)
                    WHERE a.leveal = '3'
                      AND (
                        EXISTS (
                          SELECT 1 FROM ZHYYLS.dbo.Vsalebill s WITH (NOLOCK)
                          JOIN ZHYYLS.dbo.Vbillindex i WITH (NOLOCK) ON s.billid = i.billid
                          WHERE s.prec = a.rec
                            AND i.billdate >= DATEADD(year, -1, GETDATE())
                            AND i.BillType IN ('101', '102', '103', '104', '105')
                        )
                        OR EXISTS (
                          SELECT 1 FROM ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK)
                          WHERE gs.prec = a.rec
                            AND gs.qty > 0
                        )
                      )`);
          
          const currentCount = countResult.recordset[0]?.product_count || 0;
          result = {
            product_count: currentCount,
            last_update: new Date().toISOString()
          };
          console.log(`✅ check_products_update 当前商品数: ${currentCount}`);
        } finally {
          releasePool(poolZHYYLS);
        }
        break;
      }

      // ========== 预加载方案：一次性返回本店所有商品库存（P0优化：优先查Supabase缓存）==========
      case "get_store_inventory": {
        // P0优化：优先从 Supabase 缓存查询，Supabase 失败再降级到 SQL Server
        // 这样可以大幅提升响应速度（Supabase ~50ms vs SQL Server ~3000ms）
        const store_name = validateInput(params?.store_name, "门店名称", 100);
        const force_refresh = params?.force_refresh === true;
        
        // 尝试从 Supabase 缓存查询（强制刷新时跳过缓存，直接查 SQL Server 最新数据）
        if (!force_refresh) {
        try {
          const storeFilter = store_name ? `like.%${store_name}%` : 'not.is.null';
          const { data: supabaseData, error: supabaseError } = await supabase
            .from("shortage_storestock_cache")
            .select("*")
            .like("store_name", store_name ? `%${store_name}%` : "%%")
            .limit(5000);
          
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
            WHERE @门店名称 = '' OR s.门店名称 LIKE '%' + @门店名称 + '%'
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
          console.log(`✅ get_store_inventory 从SQL Server返回 ${records.length} 条记录（降级模式）`);
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "get_product_detail": {
        // 商品详情 - 返回该商品在所有门店的数据（用于弹窗显示各门店库存）
        const product_code = validateInput(params?.product_code, "商品编码", 50);
        const store_name = validateInput(params?.store_name, "门店名称", 100);
        
        // P0优化：先尝试从 Supabase 查询（查所有门店的该商品）
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
        
        // 降级：从 SQL Server 获取（查询该商品所有门店数据）
        const pool = await getPool();
        try {
          const request = pool.request()
            .input("商品编码", sql.NVarChar, product_code);
          
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
          
          result = [records];
          console.log(`✅ get_product_detail 从SQL Server返回商品 ${product_code}，共 ${records.length} 条门店记录（降级模式）`);
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
              .input("Top", sql.Int, 500)
              .execute("usp_GetPurchasePlanWithFeedback");
            planResult = planList.recordsets;
          }

          // === 关键修复：用 Shortage_OrderFeedback 真实状态覆盖存储过程可能错误的自动判断 ===
          // usp_GetPurchasePlanWithFeedback 有时会根据库存自行计算状态，
          // 导致"只回填订货数量、无库存"时错误显示为"已到货"
          if (planResult && planResult[0] && Array.isArray(planResult[0]) && planResult[0].length > 0) {
            const codes = planResult[0].map((r: any) => r.商品编码).filter(Boolean);
            if (codes.length > 0) {
              const codesStr = codes.map((c: string) => `'${c.replace(/'/g, "''")}'`).join(",");
              const realStatusResult = await pool.request()
                .query(`SELECT 商品编码, 补货状态 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 IN (${codesStr})`);
              const realStatusMap: Record<string, string> = {};
              if (realStatusResult.recordset) {
                realStatusResult.recordset.forEach((row: any) => {
                  realStatusMap[row.商品编码] = row.补货状态;
                });
              }
              planResult[0] = planResult[0].map((r: any) => ({
                ...r,
                补货状态: realStatusMap[r.商品编码] || r.补货状态 || '待处理'
              }));
            }
          }

          result = planResult;
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
        // 手动修改补货状态
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

          // 直接使用 SQL 更新/插入，避免存储过程参数不兼容或内部错误导致 500
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
                    备注 = @备注
                WHERE 商品编码 = @商品编码
              END
              ELSE
              BEGIN
                INSERT INTO dbo.Shortage_OrderFeedback (商品编码, 实际订货数量, 补货状态, 订货时间, 操作人, 备注)
                VALUES (@商品编码, 0, @补货状态, GETDATE(), @操作人, @备注)
              END
            `);
          result = { success: true, message: '状态更新成功', product_code: validProductCode, status: validStatus };
        } catch (sqlErr) {
          console.error("手动更新状态 SQL 错误:", sqlErr);
          throw sqlErr;
        } finally {
          releasePool(pool);
        }
        break;
      }

      case "auto_detect_status": {
        // 自动检测所有补货状态变化
        const pool = await getPool();
        try {
          const res = await pool.request()
            .execute("usp_AutoDetectOrderStatus_Feedback");
          result = res.recordsets[0];
        } finally {
          releasePool(pool);
        }
        try { await supabase.from("sync_log_table").insert([{ 
          sync_time: new Date().toISOString(), 
          sync_type: "status_detect", 
          status: "success", 
          detail: "自动状态检测完成" 
        }]); } catch(e) {}
        break;
      }

      case "sync_with_auto_status": {
        // 一键：同步数据 + 自动检测状态
        const pool = await getPool();
        try {
          // 先执行标准同步（使用存在的存储过程）
          await pool.request().execute("usp_Sync_AllShortageCache");
          // 再执行自动状态检测（RQZT 端）
          const detectRes = await pool.request().execute("usp_AutoDetectOrderStatus_Feedback");
          result = { success: true, message: '同步和状态检测完成', detectResult: detectRes.recordsets[0] };
          try { await supabase.from("sync_log_table").insert([{ 
            sync_time: new Date().toISOString(), 
            sync_type: "full_auto", 
            status: "success", 
            detail: "同步+状态检测完成" 
          }]); } catch(e) {}
        } catch (e1) {
          throw e1;
        } finally {
          releasePool(pool);
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
        // 优化方案：直接从 ZHYYLS.Vptype + cstype 获取完整商品列表
        // 修复：使用 USERCODE（商品条码）作为 product_code，与原业务系统编码一致
        const poolZHYYLS = await getPool("ZHYYLS");
        try {
          console.log('正在从 ZHYYLS.Vptype + cstype 获取完整商品列表...');
          
          // 修复：获取 USERCODE（商品条码，原业务系统使用的编码，如 0002100277）
          // product_cache 表只有 product_code 列，所以将 USERCODE 存入 product_code
          // 优化：只同步"近2年有销售"或"有库存"的商品，大幅减少商品数量
          const productsResult = await poolZHYYLS.request()
            .query(`SELECT
                    LTRIM(RTRIM(ISNULL(a.USERCODE, ''))) as USERCODE,
                    LTRIM(RTRIM(ISNULL(a.typeId, ''))) as typeId,
                    LTRIM(RTRIM(ISNULL(a.FullName, ''))) as 商品名称,
                    LTRIM(RTRIM(ISNULL(a.Standard, ''))) as 规格,
                    LTRIM(RTRIM(ISNULL(b.FullName, ''))) as 生产企业,
                    LTRIM(RTRIM(ISNULL(a.PYZJM, ''))) as 拼音助记码
                    FROM Vptype a WITH (NOLOCK)
                    LEFT JOIN cstype b WITH (NOLOCK) ON a.area = b.rec
                    WHERE a.leveal = '3'
                      AND (
                        -- 近2年有销售记录的商品
                        EXISTS (
                          SELECT 1 FROM ZHYYLS.dbo.Vsalebill s WITH (NOLOCK)
                          JOIN ZHYYLS.dbo.Vbillindex i WITH (NOLOCK) ON s.billid = i.billid
                          WHERE s.prec = a.rec
                            AND i.billdate >= DATEADD(year, -2, GETDATE())
                            AND i.BillType IN ('101', '102', '103', '104', '105')
                        )
                        -- 或有库存的商品（任意门店）
                        OR EXISTS (
                          SELECT 1 FROM ZHYYLS.dbo.GoodsStocks gs WITH (NOLOCK)
                          WHERE gs.prec = a.rec
                            AND gs.qty > 0
                        )
                      )
                    ORDER BY a.USERCODE`);
          
          console.log(`✅ 从 Vptype 获取到 ${productsResult.recordset.length} 个商品`);
          
          // 构建商品列表：优先使用 USERCODE 存入 product_code（与原业务系统编码一致）
          const productMap = new Map();
          productsResult.recordset.forEach(p => {
            // 优先使用 USERCODE（商品条码），这是原业务系统使用的编码
            const productCode = p.USERCODE && p.USERCODE.trim() !== '' 
              ? p.USERCODE.trim() 
              : (p.typeId ? p.typeId.trim() : '');
            
            if (productCode !== '' && !productMap.has(productCode)) {
              productMap.set(productCode, {
                product_code: productCode,
                product_name: p.商品名称 || '',
                product_spec: p.规格 || '',
                manufacturer: p.生产企业 || '',
                pinyin_code: (p.拼音助记码 || '').trim().toLowerCase(),
              });
            }
          });
          
          const productList = Array.from(productMap.values());
          console.log(`✅ 有效商品数量: ${productList.length}（去重后）`);
          
          // 清空旧数据
          console.log('正在清空旧的商品缓存...');
          const { error: deleteError } = await supabase
            .from("product_cache")
            .delete()
            .neq('product_code', '');
          
          if (deleteError) {
            console.error('清空旧数据失败:', deleteError);
            throw deleteError;
          }
          
          // 分批插入（每批200个）
          console.log('正在插入新的商品数据...');
          const batchSize = 200;
          for (let i = 0; i < productList.length; i += batchSize) {
            const batch = productList.slice(i, i + batchSize);
            console.log(`插入第 ${Math.floor(i/batchSize) + 1} 批，共 ${batch.length} 个商品`);
            
            const { error: insertError } = await supabase
              .from("product_cache")
              .insert(batch);
              
            if (insertError) {
              console.error('插入数据失败:', insertError);
              throw insertError;
            }
          }
          
          console.log(`✅ 商品缓存同步完成！共 ${productList.length} 个商品`);
          result = { synced: productList.length };
        } catch (err) {
          console.error('❌ 商品缓存同步异常:', err);
          throw err;
        } finally {
          releasePool(poolZHYYLS, "ZHYYLS");
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
              ISNULL(标准库存数量, 0) as standard_stock,
              ISNULL(门店计划, 0) as store_plan,
              LTRIM(RTRIM(ISNULL(标记, ''))) as flag,
              LTRIM(RTRIM(ISNULL(分类组, ''))) as category,
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
                ISNULL(标准库存数量, 0) as standard_stock,
                ISNULL(门店计划, 0) as store_plan,
                LTRIM(RTRIM(ISNULL(标记, ''))) as flag,
                LTRIM(RTRIM(ISNULL(分类组, ''))) as category,
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
              ISNULL(标准库存数量, 0) as standard_stock,
              ISNULL(门店计划, 0) as store_plan,
              LTRIM(RTRIM(ISNULL(标记, ''))) as flag,
              LTRIM(RTRIM(ISNULL(分类组, ''))) as category,
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
        
        // 1. 验证账号密码（使用独立客户端，避免污染数据库查询客户端的认证状态）
        const validUsername = validateInput(username, "用户名", 50);
        const validPassword = validateInput(password, "密码", 100);
        
        const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({
          email: validUsername + '@wszh.com',
          password: validPassword
        });
        
        if (signInError) {
          return new Response(JSON.stringify({
            success: false, error: "账号或密码错误"
          }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        const userData = signInData.user;
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
        
        // 3. 非管理员账号：设备授权 + 单设备登录限制
        const validDeviceId = validateInput(device_id, "设备ID", 100);
        
        // 检查是否是例外账号
        const isExempt = isExemptAccount(validUsername);
        
        // 3.1 单设备登录检查（踢出旧设备）
        if (!isExempt) {
          const { data: otherDevices } = await adminClient
            .from("store_authorized_devices")
            .select("id, device_id, is_authorized")
            .eq("username", validUsername)
            .eq("is_active", true)
            .neq("device_id", validDeviceId);
          
          if (otherDevices && otherDevices.length > 0) {
            // 检查是否有其他已授权设备
            const hasOtherAuthorized = otherDevices.some(d => d.is_authorized);
            if (hasOtherAuthorized) {
              return new Response(JSON.stringify({
                success: false, error: "该账号已在其他设备登录，请先退出原设备后再试"
              }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
          }
        }
        
        // 3.2 查当前设备是否已有记录
        const { data: existingDevice } = await adminClient
          .from("store_authorized_devices")
          .select("id, is_authorized, username, is_active")
          .eq("device_id", validDeviceId)
          .eq("is_active", true)
          .limit(1);

        if (existingDevice && existingDevice.length > 0) {
          // 已有记录
          const device = existingDevice[0];
          
          // 检查授权状态（非例外账号）
          if (!isExempt && !device.is_authorized) {
            return new Response(JSON.stringify({
              success: false, error: "该设备未授权，请联系管理员授权后使用",
              pending_device_id: validDeviceId,
              pending_username: validUsername
            }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          
          // 更新登录时间
          await adminClient
            .from("store_authorized_devices")
            .update({ 
              is_authorized: isExempt ? true : device.is_authorized,
              is_active: true,
              last_login_at: new Date().toISOString(),
              username: validUsername
            })
            .eq("id", device.id);
        } else {
          // 新设备
          if (isExempt) {
            // 例外账号：自动授权
            await adminClient
              .from("store_authorized_devices")
              .insert([{
                device_id: validDeviceId,
                username: validUsername,
                is_authorized: true,
                is_active: true,
                first_login_at: new Date().toISOString(),
                last_login_at: new Date().toISOString()
              }]);
          } else {
            // 普通账号：创建待授权记录
            const { data: insertedDevice, error: insertErr } = await adminClient
              .from("store_authorized_devices")
              .insert([{
                device_id: validDeviceId,
                username: validUsername,
                is_authorized: false,
                is_active: true,
                first_login_at: new Date().toISOString()
              }])
              .select();
            
            if (insertErr) {
              console.error("[store_login] 创建设备授权记录失败:", insertErr);
              return new Response(JSON.stringify({
                success: false, error: "设备授权记录创建失败: " + insertErr.message,
                pending_device_id: validDeviceId,
                pending_username: validUsername
              }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            
            console.log("[store_login] 待授权设备记录已创建:", JSON.stringify(insertedDevice));
            
            // 验证插入是否成功
            if (!insertedDevice || insertedDevice.length === 0) {
              console.warn("[store_login] 警告：插入成功但select返回空，尝试直接查询验证");
              const { data: verifyData } = await adminClient
                .from("store_authorized_devices")
                .select("*")
                .eq("device_id", validDeviceId)
                .eq("username", validUsername)
                .eq("is_active", true);
              console.log("[store_login] 验证查询结果:", JSON.stringify(verifyData));
            }
            
            return new Response(JSON.stringify({
              success: false, error: "该设备未授权，请联系管理员授权后使用",
              pending_device_id: validDeviceId,
              pending_username: validUsername
            }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
        
        result = {
          user: {
            id: userData.id,
            username: validUsername,
            role: isExempt ? 'exempt_store' : 'store',
            store_id: validUsername,
            store_name: STORE_NAME_MAP[validUsername] || validUsername,
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
        
        if (validTargetType === 'employee') {
          // 员工设备授权
          const { data: existing } = await supabase
            .from("device_bindings")
            .select("id")
            .eq("device_id", validDeviceId)
            .eq("employee_id", validTargetId)
            .eq("is_active", true)
            .limit(1);
          
          if (existing && existing.length > 0) {
            await supabase
              .from("device_bindings")
              .update({ is_authorized: authorize })
              .eq("id", existing[0].id);
          } else if (authorize) {
            // 授权时如果记录不存在，创建一条
            await supabase.from("device_bindings").insert([{
              device_id: validDeviceId,
              employee_id: validTargetId,
              is_authorized: true,
              is_active: true,
              authorized_at: new Date().toISOString()
            }]);
          }
        } else if (validTargetType === 'store') {
          // 门店账号设备授权
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
              .update({ is_authorized: authorize })
              .eq("id", existing[0].id);
          } else if (authorize) {
            await supabase.from("store_authorized_devices").insert([{
              device_id: validDeviceId,
              username: validTargetId,
              is_authorized: true,
              is_active: true,
              authorized_at: new Date().toISOString()
            }]);
          }
        }
        
        result = { success: true, authorized: authorize };
        break;
      }

      case "get_pending_devices": {
        // 获取所有待授权的设备列表（管理员查看，不限制门店）
        
        // 员工待授权设备（先查设备，再单独查员工信息，避免外键关联查询失败）
        const { data: empPending, error: empErr } = await supabase
          .from("device_bindings")
          .select("id, device_id, employee_id, first_login_at")
          .eq("is_active", true)
          .eq("is_authorized", false);
        
        if (empErr) {
          console.error("[get_pending_devices] 员工设备查询失败:", empErr);
          return new Response(JSON.stringify({ 
            success: false, 
            error: "查询失败：" + empErr.message,
            employee_devices: [],
            store_devices: []
          }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        // 单独查询员工信息并合并
        let employeeDevices = [];
        if (empPending && empPending.length > 0) {
          const empIds = [...new Set(empPending.map((d: any) => d.employee_id).filter(Boolean))];
          const empMap: Record<string, any> = {};
          if (empIds.length > 0) {
            const { data: emps } = await supabase
              .from("store_employees")
              .select("id, name, phone, store_id")
              .in("id", empIds);
            emps?.forEach((e: any) => { empMap[e.id] = e; });
          }
          employeeDevices = empPending.map((d: any) => ({
            ...d,
            store_employees: empMap[d.employee_id] || null
          }));
        }
        
        // 门店账号待授权设备（查询所有门店）
        const { data: storePending, error: storeErr } = await supabase
          .from("store_authorized_devices")
          .select("*")
          .eq("is_active", true)
          .eq("is_authorized", false);
        
        if (storeErr) {
          console.error("[get_pending_devices] 门店设备查询失败:", storeErr);
          return new Response(JSON.stringify({ 
            success: false, 
            error: "查询失败：" + storeErr.message,
            employee_devices: employeeDevices,
            store_devices: []
          }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        console.log("[get_pending_devices] 员工待授权:", employeeDevices.length, "门店待授权:", storePending?.length || 0);
        console.log("[get_pending_devices] 门店待授权详情:", JSON.stringify(storePending?.slice(0, 3)));
        
        // 直接返回数据，不走 result
        return new Response(JSON.stringify({ 
          success: true, 
          data: {
            employee_devices: employeeDevices,
            store_devices: storePending || []
          }
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      case "get_authorized_devices": {
        // 获取已授权设备列表
        const { target_type, target_id } = params;
        const validTargetType = validateInput(target_type, "类型", 20);
        const validTargetId = validateInput(target_id, "目标ID", 100);
        
        let devices = [];
        if (validTargetType === 'employee') {
          const { data } = await supabase
            .from("device_bindings")
            .select("*, store_employees(name, phone)")
            .eq("employee_id", validTargetId)
            .eq("is_active", true);
          devices = data || [];
        } else if (validTargetType === 'store') {
          const { data } = await supabase
            .from("store_authorized_devices")
            .select("*")
            .eq("username", validTargetId)
            .eq("is_active", true);
          devices = data || [];
        }
        
        result = devices;
        break;
      }

      // ========== 用户主动退出登录 ==========
      case "logout_device": {
        // 用户退出当前设备登录
        const { target_type, target_id, device_id } = params;
        const validDeviceId = validateInput(device_id, "设备ID", 100);
        const validTargetType = validateInput(target_type, "类型", 20);
        const validTargetId = validateInput(target_id, "目标ID", 100);
        
        if (validTargetType === 'employee') {
          await supabase
            .from("device_bindings")
            .update({ is_authorized: false })
            .eq("employee_id", validTargetId)
            .eq("device_id", validDeviceId);
        } else if (validTargetType === 'store') {
          await supabase
            .from("store_authorized_devices")
            .update({ is_authorized: false })
            .eq("username", validTargetId)
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
        
        if (validTargetType === 'employee') {
          await supabase
            .from("device_bindings")
            .update({ is_active: false })
            .eq("device_id", validDeviceId)
            .eq("employee_id", validTargetId);
        } else if (validTargetType === 'store') {
          await supabase
            .from("store_authorized_devices")
            .update({ is_active: false })
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
        
        // 验证手机号格式
        const validPhone = validateInput(phone, "手机号", 11);
        if (!/^\d{11}$/.test(validPhone)) {
          return new Response(JSON.stringify({ success: false, error: "请输入正确的11位手机号" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        
        // 检查重复
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

        const { data: newEmp, error: addErr } = await supabase
          .from("store_employees")
          .insert([{
            phone: validPhone,
            name: validateInput(name || '', "姓名", 50),
            store_id: validateInput(store_id, "门店ID", 50),
            store_name: validateInput(store_name, "门店名称", 100),
            password: DEFAULT_EMPLOYEE_PASSWORD,  // 默认密码
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
            const { data: userList } = await supabase.auth.admin.listUsers();
            const authUser = userList?.users?.find((u: any) => u.email === email);
            if (authUser) {
              const { error: authUpdateErr } = await supabase.auth.admin.updateUserById(
                authUser.id,
                { password: validPassword }
              );
              if (authUpdateErr) {
                console.error("[update_employee_password] Auth密码更新失败:", authUpdateErr);
              } else {
                console.log("[update_employee_password] Auth密码已同步更新:", email);
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
        result = reports || [];
        break;
      }

      case "insert_report": {
        // 门店上报缺货/新品（绕过浏览器 Permissions Policy 限制）
        const reportData = params as Record<string, unknown>;
        delete (reportData as Record<string, unknown>).action; // 清理多余字段
        
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
        
        // 同步 SQL Server 中的补货状态
        let finalReports = reports || [];
        if (finalReports.length > 0) {
          try {
            const pool = await getPool();
            try {
              // 收集所有商品编码
              const productCodes = finalReports
                .filter(r => r.product_code)
                .map(r => r.product_code);
              
              if (productCodes.length > 0) {
                // 查询 SQL Server 中的补货状态
                const codesStr = productCodes.map(c => `'${c.replace(/'/g, "''")}'`).join(",");
                const statusResult = await pool.request()
                  .query(`SELECT 商品编码, 补货状态 FROM dbo.Shortage_OrderFeedback WHERE 商品编码 IN (${codesStr})`);
                
                // 构建状态映射
                const statusMap: Record<string, string> = {};
                if (statusResult.recordset) {
                  statusResult.recordset.forEach(row => {
                    statusMap[row.商品编码] = row.补货状态;
                  });
                }
                
                // 合并状态
                finalReports = finalReports.map(r => ({
                  ...r,
                  replenish_status: statusMap[r.product_code] || r.replenish_status || "待处理"
                }));
              }
            } finally {
              releasePool(pool);
            }
          } catch (syncErr) {
            console.error("同步补货状态失败:", syncErr);
            // 同步失败时仍返回原始数据
          }
        }
        
        result = finalReports;
        break;
      }

      case "list_stores": {
        // 获取所有门店列表（用于管理后台-门店管理）
        // 从 store_authorized_devices 表提取去重的门店账号
        const { data: devices } = await supabase
          .from("store_authorized_devices")
          .select("username, is_active, last_login_at");
        
        if (!devices) {
          result = [];
          break;
        }

        // 按用户名分组，取最新登录时间
        const storeMap: Record<string, { username: string; last_login_at: string | null; is_active: boolean }> = {};
        for (const d of devices) {
          const name = d.username;
          if (!name) continue;
          if (!storeMap[name] || (d.last_login_at && (!storeMap[name].last_login_at || d.last_login_at > storeMap[name].last_login_at!))) {
            storeMap[name] = { username: name, last_login_at: d.last_login_at, is_active: d.is_active };
          }
        }
        
        result = Object.values(storeMap).sort((a, b) => a.username.localeCompare(b.username));
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
    return new Response(JSON.stringify(responseBody), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Edge Function 错误:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
