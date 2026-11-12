// Supabase Edge Function - 定时任务
// v4.0: 使用 _shared/fifo.ts 共享 FIFO 判定（与 query-shortage-data 完全一致的新口径）
// 每条 report 独立 anchor = 自己的 created_at，eligible pool = BillDate >= created_at
// 2026-11-09: 替换旧"总账模式"（anchor=最早上报日）为 per-report FIFO

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import sql from "https://esm.sh/mssql@9";
// 【关键】import 共享 FIFO 逻辑，保证与 query-shortage-data 判定结果完全一致
import { runFIFO, toBjDate, isPurchaseEligible, queryPurchaseInPool } from "../_shared/fifo.ts";

// ========== 环境变量配置 ==========
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SQL_SERVER_HOST = Deno.env.get("SQL_SERVER_HOST")!;
const SQL_SERVER_PORT = parseInt(Deno.env.get("SQL_SERVER_PORT") || "1311");
const SQL_SERVER_USER = Deno.env.get("SQL_SERVER_USER")!;
const SQL_SERVER_PWD = Deno.env.get("SQL_SERVER_PASSWORD")!;
const SQL_SERVER_DB = Deno.env.get("SQL_SERVER_DATABASE") || "RQZT";

const sqlConfig = {
  server: SQL_SERVER_HOST, port: SQL_SERVER_PORT, user: SQL_SERVER_USER,
  password: SQL_SERVER_PWD, database: SQL_SERVER_DB,
  connectionTimeout: 60000, requestTimeout: 120000,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
};

interface PoolCache { pool: sql.ConnectionPool; lastUsed: number; inUse: boolean; }
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
  if (existing) { existing.lastUsed = now; return existing.pool; }
  const cfg = { ...sqlConfig, database: dbName };
  const pool = new sql.ConnectionPool(cfg);
  await pool.connect();
  poolCache.set(cacheKey, { pool, lastUsed: Date.now(), inUse: false });
  return pool;
}

function releasePool(pool: sql.ConnectionPool) {
  for (const [key, cache] of poolCache.entries()) {
    if (cache.pool === pool) cache.lastUsed = Date.now();
  }
}

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = ["http://localhost:5173", "http://localhost:3000", "https://wszhyy.pages.dev", "https://wszhyy.com", "null"];
  const isAllowed = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowed[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-task-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const TASK_SECRET = Deno.env.get("TASK_SECRET") || "wszh_auto_sync_2026";

function checkSecret(req: Request): boolean {
  const provided = req.headers.get("x-task-secret") || req.headers.get("x-sync-secret") || "";
  const auth = req.headers.get("authorization") || "";
  return provided.trim() === TASK_SECRET.trim() || auth.startsWith("Bearer " + TASK_SECRET.trim()) || auth.startsWith("Bearer eyJ");
}

// ========== 核心自动判定：用共享 runFIFO（新口径，每条独立 anchor）==========
async function preciseAutoDetectStatusV2() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const pool = await getPool();
  try {
    const now = new Date().toISOString();

    // Step 1: 拉所有"非终态"缺货（待处理/已订购/待付款/已到货）
    const { data: pendingReports, error: qErr } = await supabase
      .from("reports")
      .select("id, product_code, store_id, store_name, demand_quantity, created_at, replenish_status")
      .eq("order_type", "缺货订购")
      .gt("demand_quantity", 0)
      .in("replenish_status", ["待处理", "已订购", "待付款", "已到货"])
      .order("created_at", { ascending: true });
    if (qErr) throw qErr;
    if (!pendingReports || pendingReports.length === 0) {
      return { success: true, auto_completed: 0, message: "无待判定缺货" };
    }

    // Step 2: 批量查采购入库明细
    const codes = [...new Set(pendingReports.map((r: any) => r.product_code).filter(Boolean))];
    const purchaseByCode = await queryPurchaseInPool(pool, codes);

    // ★ 2026-11-12 修复：把已经由 FIFO 自动判定完成的 report 也带上，
    //   先把它们占用的采购量从池里扣掉，否则同一张入库单会被每次任务重复使用
    const fifoDoneReports: any[] = [];
    for (let i = 0; i < codes.length; i += 150) {
      const batch = codes.slice(i, i + 150);
      const { data: doneRows } = await supabase
        .from("reports")
        .select("id, product_code, demand_quantity, created_at")
        .eq("order_type", "缺货订购")
        .eq("replenish_status", "已完成")
        .ilike("status_remark", "%采购入库满足%")
        .gt("demand_quantity", 0)
        .in("product_code", batch);
      if (doneRows) fifoDoneReports.push(...doneRows);
    }

    // Step 3: 调共享 runFIFO（新口径，每条 report 独立 anchor）
    const fifoRes = runFIFO(pendingReports as any[], purchaseByCode, true, fifoDoneReports as any[]);

    // Step 4: 批量 UPDATE 判定完成的 reports
    let updated = 0;
    const remark = '自动判定：仓库采购入库满足（FIFO 先上报先满足）';
    if (fifoRes.toCompleteIds.length > 0) {
      const { error: updErr } = await supabase.from("reports").update({
        replenish_status: '已完成',
        status_remark: remark,
        status_changed_at: now,
        status_changed_by: '系统自动',
        settled_at: now,
      }).in("id", fifoRes.toCompleteIds).neq("replenish_status", "已完成").neq("replenish_status", "已配送");
      if (updErr) throw updErr;
      updated = fifoRes.toCompleteIds.length;

      // 更新 product_completion
      const doneCodes = [...new Set(pendingReports.filter((r: any) => fifoRes.toCompleteIds.includes(r.id)).map((r: any) => r.product_code))];
      for (const code of doneCodes) {
        try {
          await supabase.from("product_completion").upsert(
            { product_code: code, last_completed_at: now, updated_at: now, fail_count: 0 },
            { onConflict: 'product_code' }
          );
        } catch {}
      }
    }

    return {
      success: true,
      auto_completed: updated,
      total_checked: pendingReports.length,
      details: fifoRes.details,
    };
  } finally {
    releasePool(pool);
  }
}

// ========== full_sync：完整同步入口 ==========
async function fullSync() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const pool = await getPool();
  const now = new Date().toISOString();
  try {
    // Step 1: 跑 FIFO 自动判定
    const detectResult = await preciseAutoDetectStatusV2();

    // Step 2: 90 天超期自动关闭
    const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const { data: expired, error: eErr } = await supabase
      .from("reports")
      .select("id")
      .eq("order_type", "缺货订购")
      .lt("created_at", cutoff)
      .in("replenish_status", ["待处理", "已订购", "待付款", "已到货"]);
    let closedCount = 0;
    if (!eErr && expired && expired.length > 0) {
      const ids = expired.map((r: any) => r.id);
      // v5.15.14 终态白名单守卫：只允许关闭 待处理/已订购/待付款/已到货
      // 已关闭、厂家断货 必须原样保留；已完成(=已入库) 不在 90 天关闭范围内（等门店重新上报）
      const { error } = await supabase.from("reports").update({
        replenish_status: '已关闭',
        status_remark: '90天超期自动关闭',
        status_changed_at: now,
        close_reason: '90天超期未处理',
      }).in("id", ids)
        .in("replenish_status", ["待处理", "已订购", "待付款", "已到货"]);
      if (!error) closedCount = ids.length;
    }

    return {
      success: true,
      auto_completed: detectResult.auto_completed,
      closed_expired: closedCount,
      details: detectResult.details,
      ran_at: now,
    };
  } finally {
    releasePool(pool);
  }
}

// ========== HTTP Server ==========
serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let reqBody: any = {};
  try { reqBody = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "请使用 POST + JSON" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const { action } = reqBody;

  const PUBLIC_ACTIONS = ["health", "debug_check_code", "run_detect_only"];
  if (!PUBLIC_ACTIONS.includes(action || "") && !checkSecret(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    let result: any;
    switch (action) {
      case "health": {
        result = { ok: true, ts: new Date().toISOString(), version: "v4.0-shared-fifo" };
        break;
      }
      case "debug_check_code": {
        result = { ok: true, ts: new Date().toISOString(), msg: "scheduled-task alive (uses _shared/fifo.ts new per-report anchor)" };
        break;
      }
      case "run_detect_only": {
        result = await preciseAutoDetectStatusV2();
        break;
      }
      case "full_sync": {
        result = await fullSync();
        break;
      }
      default: {
        result = { error: "unknown action", action };
      }
    }
    return new Response(JSON.stringify({ success: true, data: result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e?.message || String(e), stack: e?.stack }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
