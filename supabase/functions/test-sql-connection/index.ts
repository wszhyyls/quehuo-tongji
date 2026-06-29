// 临时测试：Supabase Edge Function → SQL Server 直接连接
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import sql from "https://esm.sh/mssql@9";

const SQL_CONFIG = {
  server: "121.229.175.49",
  port: 1311,
  user: Deno.env.get("SQL_SERVER_USER")!,
  password: Deno.env.get("SQL_SERVER_PASSWORD")!,
  database: "RQZT",
  connectionTimeout: 5000,
  requestTimeout: 10000,
  options: { encrypt: false, trustServerCertificate: true },
};

serve(async (_req) => {
  const start = Date.now();
  try {
    const pool = await sql.connect(SQL_CONFIG);
    const r = await pool.request().query("SELECT GETDATE() as dt, DB_NAME() as db, COUNT(*) as cnt FROM dbo.ProductCache_RQZT");
    await pool.close();
    return new Response(JSON.stringify({ 
      success: true, 
      time_ms: Date.now() - start,
      server_time: r.recordset[0].dt,
      database: r.recordset[0].db,
      product_count: r.recordset[0].cnt
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ 
      success: false, 
      time_ms: Date.now() - start,
      error: err.message?.substring(0, 200)
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
