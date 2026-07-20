// supabase/functions/sync-cache/index.ts
// v5.8.1+ 独立 Edge Function: 同步 SendBill_Cache
// 部署配置: verify_jwt = false (cron 服务可调用)
// 安全加固: 通过 SYNC_CACHE_SECRET 鉴权 + 限流

// 加载必要模块
// Deno.serve 是原生 fetch handler
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey",
};

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import sql from "https://esm.sh/mssql@9";

// SQL Server 配置（从环境变量读）
const SQL_SERVER_HOST = Deno.env.get("SQL_SERVER_HOST") || "221.6.168.13";
const SQL_SERVER_PORT = parseInt(Deno.env.get("SQL_SERVER_PORT") || "1311");
const SQL_SERVER_USER = Deno.env.get("SQL_SERVER_USER") || "sa";
const SQL_SERVER_PWD = Deno.env.get("SQL_SERVER_PASSWORD") || "";
const SQL_SERVER_DB = Deno.env.get("SQL_SERVER_DATABASE") || "RQZT";

// sync 鉴权 secret
// 主来源：Supabase Dashboard → Edge Function Secrets → SYNC_CACHE_SECRET
// 备用：旧 hardcoded 值（仅过渡期，待 Dashboard 确认生效后移除）
const SYNC_SECRET = Deno.env.get("SYNC_CACHE_SECRET") || "wszh_sync_2026";

// 启动日志
console.log(`[sync-cache] SYNC_CACHE_SECRET 已配置: ${!!Deno.env.get("SYNC_CACHE_SECRET")}, 使用备选: ${!Deno.env.get("SYNC_CACHE_SECRET")}`);

// 限流配置
const RATE_LIMIT = {
  windowStart: 0,
  reqCount: 0,
  WINDOW_MS: 60 * 1000,  // 1 分钟
  MAX_ALLOW: 5,           // 每分钟最多 5 次
};

// SQL Server 连接池（单例）
let pool: any = null;
async function getPool() {
  if (pool) return pool;
  pool = await new sql.ConnectionPool({
    server: SQL_SERVER_HOST,
    port: SQL_SERVER_PORT,
    user: SQL_SERVER_USER,
    password: SQL_SERVER_PWD,
    database: SQL_SERVER_DB,
    options: { encrypt: false, trustServerCertificate: true },
  }).connect();
  return pool;
}

// 限流检查
function checkRateLimit(): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  if (now - RATE_LIMIT.windowStart > RATE_LIMIT.WINDOW_MS) {
    RATE_LIMIT.windowStart = now;
    RATE_LIMIT.reqCount = 0;
  }
  RATE_LIMIT.reqCount += 1;
  if (RATE_LIMIT.reqCount > RATE_LIMIT.MAX_ALLOW) {
    const retryAfter = Math.ceil(
      (RATE_LIMIT.windowStart + RATE_LIMIT.WINDOW_MS - now) / 1000
    );
    return { ok: false, retryAfter };
  }
  return { ok: true };
}

// 鉴权检查
function checkAuth(providedSecret: string | undefined): boolean {
  if (!SYNC_SECRET) {
    console.error("[sync-cache] SYNC_CACHE_SECRET 未配置");
    return false;
  }
  if (!providedSecret || providedSecret !== SYNC_SECRET) {
    return false;
  }
  return true;
}

// CORS 预检
function handleCors(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// 返回 JSON 响应
function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// 执行同步
async function doSync(): Promise<{ success: boolean; rows?: number; error?: string }> {
  try {
    const p = await getPool();
    // 检查表是否存在
    const exist = await p.request().query(
      `SELECT OBJECT_ID('dbo.SendBill_Cache') AS id`
    );
    if (!exist.recordset?.[0]?.id) {
      return { success: false, error: "SendBill_Cache 表不存在" };
    }
    // 执行同步存储过程
    await p.request().query("EXEC dbo.usp_SyncSendBillCache;");
    // 查行数
    const cnt = await p.request().query(
      "SELECT COUNT(*) AS cnt FROM dbo.SendBill_Cache WITH(NOLOCK)"
    );
    return {
      success: true,
      rows: cnt.recordset?.[0]?.cnt || 0,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// 路由
async function handleRequest(req: Request): Promise<Response> {
  // CORS 预检
  if (req.method === "OPTIONS") return handleCors();

  // 1. 限流
  const rate = checkRateLimit();
  if (!rate.ok) {
    return jsonResponse(
      {
        success: false,
        error: "rate_limit",
        retryAfter: rate.retryAfter,
      },
      429
    );
  }

  // 2. 解析参数（支持 body / query string 两种方式）
  let params: { secret?: string } = {};
  if (req.method === "POST") {
    try {
      const body = await req.text();
      if (body) {
        try {
          params = JSON.parse(body);
        } catch {
          // 兼容 form-urlencoded 格式
          const form = new URLSearchParams(body);
          params.secret = form.get("secret") || undefined;
        }
      }
    } catch {}
  }
  // 也支持 query string（GET 请求时方便）
  if (!params.secret) {
    const url = new URL(req.url);
    params.secret = url.searchParams.get("secret") || undefined;
  }

  // 3. 鉴权
  if (!checkAuth(params.secret)) {
    return jsonResponse({ success: false, error: "unauthorized" }, 401);
  }

  // 4. 执行同步
  const result = await doSync();
  return jsonResponse(result, result.success ? 200 : 500);
}

serve(handleRequest, { port: 8000 });
