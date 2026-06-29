// Supabase Edge Function - 实时+批量同步订购明细到 SQL Server
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import sql from "https://esm.sh/mssql@9";

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
  options: { encrypt: false, trustServerCertificate: true },
};

async function insertOne(pool: sql.ConnectionPool, record: any) {
  await pool.request()
    .input("report_id", sql.NVarChar(100), String(record.id || "").substring(0, 100))
    .input("store_id", sql.NVarChar(50), (record.store_id || "").substring(0, 50))
    .input("store_name", sql.NVarChar(100), (record.store_name || "").substring(0, 100))
    .input("order_type", sql.NVarChar(20), (record.order_type || "").substring(0, 20))
    .input("product_code", sql.NVarChar(50), (record.product_code || "").substring(0, 50))
    .input("product_name", sql.NVarChar(200), (record.product_name || record.new_product_name || "").substring(0, 200))
    .input("specification", sql.NVarChar(100), (record.specification || record.new_specification || "").substring(0, 100))
    .input("manufacturer", sql.NVarChar(200), (record.manufacturer || record.new_manufacturer || "").substring(0, 200))
    .input("demand_quantity", sql.Int, record.demand_quantity || 0)
    .input("replenish_status", sql.NVarChar(20), (record.replenish_status || "待处理").substring(0, 20))
    .input("reporter_name", sql.NVarChar(50), (record.reporter_name || "").substring(0, 50))
    .input("created_at", sql.DateTime, record.created_at ? new Date(record.created_at) : new Date())
    .query(`INSERT INTO dbo.StoreOrderDetail (report_id,store_id,store_name,order_type,product_code,product_name,specification,manufacturer,demand_quantity,replenish_status,reporter_name,created_at) VALUES (@report_id,@store_id,@store_name,@order_type,@product_code,@product_name,@specification,@manufacturer,@demand_quantity,@replenish_status,@reporter_name,@created_at)`);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
  }

  try {
    const body = await req.json();

    // 批量同步模式：action=batch
    if (body.action === "batch") {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const { data: reports, error } = await supabase.from("reports").select("*").order("created_at", { ascending: false }).limit(5000);
      if (error) throw new Error("读取reports失败: " + error.message);
      if (!reports || reports.length === 0) {
        return new Response(JSON.stringify({ success: true, synced: 0, message: "无数据" }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }

      const pool = await sql.connect(sqlConfig);
      try {
        // 先清空旧数据再批量写入
        await pool.request().query("DELETE FROM dbo.StoreOrderDetail");
        let count = 0;
        for (const r of reports) {
          try { await insertOne(pool, r); count++; } catch(e) { /* 跳过单条错误 */ }
        }
        return new Response(JSON.stringify({ success: true, synced: count, total: reports.length }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } finally { pool.close(); }
    }

    // 单条同步模式（触发器调用）
    const record = body?.record;
    if (!record) {
      return new Response(JSON.stringify({ success: false, error: "缺少record" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const pool = await sql.connect(sqlConfig);
    try { await insertOne(pool, record); } finally { pool.close(); }

    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  } catch (err: any) {
    console.error("[sync-order-detail]", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
});
