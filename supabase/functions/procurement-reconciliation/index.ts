// Supabase Edge Function - 采购对账记录管理
// v3.19.0: 采购对账功能全面集成
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import sql from "https://esm.sh/mssql@9";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SQL_SERVER_HOST = Deno.env.get("SQL_SERVER_HOST")!;
const SQL_SERVER_PORT = parseInt(Deno.env.get("SQL_SERVER_PORT") || "1311"); // 默认1311
const SQL_SERVER_USER = Deno.env.get("SQL_SERVER_USER")!;
const SQL_SERVER_PWD = Deno.env.get("SQL_SERVER_PASSWORD")!;
const SQL_SERVER_DB = Deno.env.get("SQL_SERVER_DATABASE") || "RQZT";

const sqlConfig = {
  server: SQL_SERVER_HOST, port: SQL_SERVER_PORT,
  user: SQL_SERVER_USER, password: SQL_SERVER_PWD,
  database: SQL_SERVER_DB,
  connectionTimeout: 5000, requestTimeout: 60000,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

// 字段名映射（Excel中文列名 → 库表列名一致）
const FIELD_MAP: Record<string, string> = {
  "日期": "日期", "供货商全名": "供货商全名", "简称": "简称",
  "订货方式": "订货方式", "付款方式": "付款方式", "订货人": "订货人",
  "订货金额": "订货金额", "入库日期": "入库日期", "入库金额": "入库金额",
  "入库人": "入库人", "付款人": "付款人", "付款记录": "付款记录",
  "付款日期": "付款日期", "财务入库记账": "财务入库记账",
  "财务付款记账": "财务付款记账", "记账日期": "记账日期",
  "备注": "备注", "千方系统": "千方系统", "是否开具发票": "是否开具发票"
};

function friendlyError(err: unknown): string {
  const msg = String(err);
  if (msg.includes("timeout")) return "数据查询超时，请稍后重试";
  if (msg.includes("ECONNREFUSED")) return "服务器繁忙，请稍后重试";
  return msg.substring(0, 200);
}

// 构建更新SQL的SET子句
function buildSetClause(data: Record<string, any>): { setSql: string; values: any[] } {
  const parts: string[] = []; const values: any[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!FIELD_MAP[key]) continue;
    const dbField = FIELD_MAP[key];
    if (["订货金额", "入库金额"].includes(dbField)) {
      parts.push(`[${dbField}] = @p${values.length}`);
      values.push(value === "" || value === null || value === undefined ? null : parseFloat(value));
    } else if (["日期", "入库日期", "付款日期", "记账日期"].includes(dbField)) {
      parts.push(`[${dbField}] = @p${values.length}`);
      values.push(value && value.trim() ? value.trim() : null);
    } else {
      parts.push(`[${dbField}] = @p${values.length}`);
      values.push(value !== null && value !== undefined ? String(value) : null);
    }
  }
  parts.push(`[更新时间] = GETDATE()`);
  return { setSql: parts.join(", "), values };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, data, params } = await req.json();
    const authHeader = req.headers.get("Authorization") || "";
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    let result: any = null;


    // 验证JWT 或 服务角色密钥
    let jwt: string | null = null;
    let isServiceRole = false;
    const m = authHeader.match(/Bearer\s+(.+)/i);
    if (m) jwt = m[1];
    // 同时检查 apikey 头（用于导入脚本）
    const apiKeyHeader = req.headers.get("apikey") || "";
    if (apiKeyHeader === SUPABASE_SERVICE_KEY) {
      isServiceRole = true;
      if (!jwt) jwt = apiKeyHeader;
    }
    if (!jwt) {
      return new Response(JSON.stringify({ error: "未登录" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    
    let operator = "管理员";
    if (!isServiceRole) {
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(jwt);
      if (authError || !authUser) {
        return new Response(JSON.stringify({ error: "登录已过期" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      operator = (authUser.user_metadata?.name) || (authUser.user_metadata?.username) || authUser.email || "未知";
    } else {
      operator = "系统导入";
    }

    // ========== SQL Server 连接 ==========
    let pool: sql.ConnectionPool | null = null;
    try {
      pool = await sql.connect(sqlConfig);
    } catch (e) {
      console.error("SQL连接失败:", e);
      return new Response(JSON.stringify({ error: "数据库连接失败" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    try {
      switch (action) {
        // ========== 查询列表（一次性加载全部，不分页）==========
        case "list": {
          const pageSize = Math.min(100000, Math.max(10, (params?.pageSize || 100000)));
          const sortField = params?.sortField || "日期";
          const sortOrder = params?.sortOrder === "asc" ? "ASC" : "DESC";
          const supplier = params?.supplier || "";
          const keyword = params?.keyword || "";
          const dateFrom = params?.dateFrom || "";
          const dateTo = params?.dateTo || "";

          let where = "WHERE 1=1";
          const whereParams: any[] = [];
          if (supplier) { where += ` AND [供货商全名] LIKE @p${whereParams.length}`; whereParams.push('%' + supplier + '%'); }
          if (keyword) {
            where += ` AND ([供货商全名] LIKE @p${whereParams.length} OR [简称] LIKE @p${whereParams.length} OR [订货人] LIKE @p${whereParams.length} OR [备注] LIKE @p${whereParams.length})`;
            whereParams.push('%' + keyword + '%');
          }
          if (dateFrom) { where += ` AND [日期] >= @p${whereParams.length}`; whereParams.push(dateFrom); }
          if (dateTo) { where += ` AND [日期] <= @p${whereParams.length}`; whereParams.push(dateTo); }

          const safeSort = FIELD_MAP[sortField] ? `[${FIELD_MAP[sortField]}]` : "[日期]";

          const req = pool.request();
          whereParams.forEach((v, i) => req.input(`p${i}`, v));
          
          const dataResult = await req.query(
            `SELECT TOP ${pageSize} * FROM ProcurementRecords ${where} ORDER BY ${safeSort} ${sortOrder}`
          );

          const countReq = pool.request();
          whereParams.forEach((v, i) => countReq.input(`p${i}`, v));
          const countResult = await countReq.query(`SELECT COUNT(*) AS total FROM ProcurementRecords ${where}`);
          const total = countResult.recordset[0].total;

          result = { records: dataResult.recordset, total, pageSize };
          break;
        }

        // ========== 创建记录 ==========
        case "create": {
          if (!data) throw new Error("缺少数据");
          const fields: string[] = []; const placeholders: string[] = []; const values: any[] = [];
          for (const [key, value] of Object.entries(data)) {
            if (!FIELD_MAP[key]) continue;
            fields.push(`[${FIELD_MAP[key]}]`);
            placeholders.push(`@p${values.length}`);
            const dbField = FIELD_MAP[key];
            if (["订货金额", "入库金额"].includes(dbField)) {
              values.push(value === "" || value === null ? null : parseFloat(value));
            } else {
              values.push(value || null);
            }
          }
          if (fields.length === 0) throw new Error("没有有效字段");

          fields.push("[操作人]"); placeholders.push(`@p${values.length}`); values.push(operator);
          fields.push("[对账状态]"); placeholders.push(`@p${values.length}`); values.push("未对账");

          const req = pool.request();
          values.forEach((v, i) => req.input(`p${i}`, v));
          const insertResult = await req.query(
            `INSERT INTO ProcurementRecords (${fields.join(", ")}) OUTPUT INSERTED.Id VALUES (${placeholders.join(", ")})`
          );

          // 记录审计日志
          const logReq = pool.request();
          logReq.input("p0", insertResult.recordset[0]?.Id);
          logReq.input("p1", "创建");
          logReq.input("p2", operator);
          logReq.input("p3", JSON.stringify(data));
          logReq.input("p4", "新增采购记录");
          await logReq.query(
            `INSERT INTO ProcurementAuditLog (RecordId, 操作类型, 操作人, 修改后, 备注) VALUES (@p0, @p1, @p2, @p3, @p4)`
          );

          result = { id: insertResult.recordset[0]?.Id, message: "创建成功" };
          break;
        }

        // ========== 更新记录 ==========
        case "update": {
          const id = params?.id; if (!id) throw new Error("缺少记录ID");
          if (!data || Object.keys(data).length === 0) throw new Error("缺少更新数据");

          // 先获取旧数据
          const oldReq = pool.request().input("p0", id);
          const oldResult = await oldReq.query("SELECT * FROM ProcurementRecords WHERE Id = @p0");
          const oldData = oldResult.recordset[0] || null;

          const { setSql, values } = buildSetClause(data);
          if (!setSql) throw new Error("没有有效更新字段");

          const req = pool.request();
          values.forEach((v, i) => req.input(`p${i}`, v));
          req.input("id", id);
          await req.query(`UPDATE ProcurementRecords SET ${setSql} WHERE Id = @id`);

          // 记录审计日志
          const logReq = pool.request();
          logReq.input("p0", id);
          logReq.input("p1", "编辑");
          logReq.input("p2", operator);
          logReq.input("p3", JSON.stringify(oldData));
          logReq.input("p4", JSON.stringify(data));
          logReq.input("p5", `编辑采购记录 #${id}`);
          await logReq.query(
            `INSERT INTO ProcurementAuditLog (RecordId, 操作类型, 操作人, 修改前, 修改后, 备注) VALUES (@p0, @p1, @p2, @p3, @p4, @p5)`
          );

          result = { message: "更新成功" };
          break;
        }

        // ========== 删除记录 ==========
        case "delete": {
          const id = params?.id; if (!id) throw new Error("缺少记录ID");

          const oldReq = pool.request().input("p0", id);
          const oldResult = await oldReq.query("SELECT * FROM ProcurementRecords WHERE Id = @p0");
          const oldData = oldResult.recordset[0] || null;

          const req = pool.request().input("p0", id);
          await req.query("DELETE FROM ProcurementRecords WHERE Id = @p0");

          const logReq = pool.request();
          logReq.input("p0", id);
          logReq.input("p1", "删除");
          logReq.input("p2", operator);
          logReq.input("p3", JSON.stringify(oldData));
          logReq.input("p4", `删除采购记录 #${id}`);
          await logReq.query(
            `INSERT INTO ProcurementAuditLog (RecordId, 操作类型, 操作人, 修改前, 备注) VALUES (@p0, @p1, @p2, @p3, @p4)`
          );

          result = { message: "删除成功" };
          break;
        }

        // ========== 批量物理删除 ==========
        case "batch_delete": {
          const ids = params?.ids || [];
          if (!ids || !Array.isArray(ids) || ids.length === 0) throw new Error("无有效删除ID");

          const inClause = ids.map((_: any, i: number) => `@p${i}`).join(",");
          const req = pool.request();
          ids.forEach((v: any, i: number) => req.input(`p${i}`, v));
          await req.query(`DELETE FROM ProcurementRecords WHERE Id IN (${inClause})`);

          // 审计日志
          const logReq = pool.request();
          logReq.input("p1", "批量删除");
          logReq.input("p2", operator);
          logReq.input("p5", `批量物理删除 ${ids.length} 条采购记录`);
          await logReq.query(
            `INSERT INTO ProcurementAuditLog (操作类型, 操作人, 备注) VALUES (@p1, @p2, @p5)`
          );

          result = { message: `成功删除 ${ids.length} 条记录` };
          break;
        }

        // ========== 批量导入（Excel JSON数据）==========
        case "import_excel": {
          const records = data?.records || []; if (!records.length) throw new Error("无数据");
          let success = 0;
          const errors: string[] = [];

          for (const record of records) {
            try {
              const fields: string[] = []; const placeholders: string[] = []; const values: any[] = [];
              for (const [key, value] of Object.entries(record)) {
                if (!FIELD_MAP[key]) continue;
                fields.push(`[${FIELD_MAP[key]}]`);
                placeholders.push(`@p${values.length}`);
                const dbField = FIELD_MAP[key];
                if (["订货金额", "入库金额"].includes(dbField)) {
                  const num = value === "" || value === null || value === undefined ? null : parseFloat(value);
                  values.push((num !== null && !isNaN(num)) ? num : null);
                } else {
                  const strVal = value !== null && value !== undefined ? String(value).trim() : null;
                  values.push(strVal && strVal.length > 0 ? strVal : null);
                }
              }
              if (fields.length === 0) continue;
              fields.push("[操作人]"); placeholders.push(`@p${values.length}`); values.push(operator);

              const req = pool.request();
              values.forEach((v, i) => req.input(`p${i}`, v));
              await req.query(`INSERT INTO ProcurementRecords (${fields.join(", ")}) VALUES (${placeholders.join(", ")})`);
              success++;
            } catch (e: any) { 
              if (errors.length < 5) errors.push(e.message); 
            }
          }

          // 批量导入日志
          const logReq = pool.request();
          logReq.input("p1", "导入");
          logReq.input("p2", operator);
          logReq.input("p5", `批量导入 ${success}/${records.length} 条采购记录` + (errors.length > 0 ? ' 错误:' + errors.join('; ') : ''));
          await logReq.query(
            `INSERT INTO ProcurementAuditLog (操作类型, 操作人, 备注) VALUES (@p1, @p2, @p5)`
          );

          result = { total: records.length, success, failed: records.length - success };
          if (errors.length > 0) result.error = errors[0];
          break;
        }

        // ========== 导出数据 ==========
        case "export_excel": {
          const supplier = params?.supplier || "";
          const dateFrom = params?.dateFrom || "";
          const dateTo = params?.dateTo || "";
          let where = "WHERE 1=1";
          if (supplier) where += ` AND [供货商全名] LIKE '%${supplier}%'`;
          if (dateFrom) where += ` AND [日期] >= '${dateFrom}'`;
          if (dateTo) where += ` AND [日期] <= '${dateTo}'`;

          const req = pool.request();
          const dataResult = await req.query(`SELECT * FROM ProcurementRecords ${where} ORDER BY [日期] DESC`);
          result = dataResult.recordset;
          break;
        }

        // ========== 统计汇总 ==========
        case "get_stats": {
          const now = new Date();
          const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
          const supplier = params?.supplier || "";

          let supplierFilter = "";
          if (supplier) {
            const req = pool.request().input("s", supplier);
            const statsResult = await req.query(
              `SELECT 
                ISNULL(SUM([订货金额]), 0) AS 本月订货总额,
                ISNULL(SUM([入库金额]), 0) AS 本月入库总额,
                COUNT(*) AS 本月记录数,
                (SELECT ISNULL(SUM([订货金额]), 0) FROM ProcurementRecords WHERE [供货商全名] = @s AND [付款记录] = '未付款') AS 未付款总额,
                (SELECT COUNT(*) FROM ProcurementRecords WHERE [供货商全名] = @s AND [对账状态] = '已对账') AS 已对账数
              FROM ProcurementRecords WHERE [供货商全名] = @s AND [日期] >= @m`
            );
            result = statsResult.recordset[0];
          } else {
            const req = pool.request();
            const statsResult = await req.query(
              `SELECT 
                ISNULL(SUM(CASE WHEN [日期] >= '${monthStart}' THEN [订货金额] ELSE 0 END), 0) AS 本月订货总额,
                ISNULL(SUM(CASE WHEN [日期] >= '${monthStart}' THEN [入库金额] ELSE 0 END), 0) AS 本月入库总额,
                ISNULL(SUM(CASE WHEN [付款记录] = '未付款' THEN [订货金额] ELSE 0 END), 0) AS 未付款总额,
                ISNULL(SUM(CASE WHEN [对账状态] = '已对账' THEN [订货金额] ELSE 0 END), 0) AS 已对账总额,
                COUNT(CASE WHEN [日期] >= '${monthStart}' THEN 1 END) AS 本月记录数,
                COUNT(CASE WHEN [对账状态] = '未对账' THEN 1 END) AS 未对账记录数
              FROM ProcurementRecords`
            );
            result = statsResult.recordset[0];
          }
          break;
        }

        // ========== 获取操作日志 ==========
        case "get_logs": {
          const page = Math.max(1, (params?.page || 1));
          const pageSize = Math.min(200, (params?.pageSize || 50));
          const offset = (page - 1) * pageSize;

          const countReq = pool.request();
          const countResult = await countReq.query("SELECT COUNT(*) AS total FROM ProcurementAuditLog");
          const total = countResult.recordset[0].total;

          const req = pool.request();
          const logResult = await req.query(
            `WITH RowOrdered AS (
              SELECT *, ROW_NUMBER() OVER (ORDER BY [操作时间] DESC) AS RowNum 
              FROM ProcurementAuditLog
            )
            SELECT * FROM RowOrdered WHERE RowNum BETWEEN ${offset + 1} AND ${offset + pageSize}`
          );

          result = { logs: logResult.recordset, total, page, pageSize };
          break;
        }

        // ========== 对账操作 ==========
        case "reconcile": {
          const ids = params?.ids || []; if (!ids.length) throw new Error("请选择要操作的对账记录");
          const action_type = params?.action_type || "对账";
          const inClause = ids.map((_: any, i: number) => `@p${i}`).join(",");

          const req = pool.request();
          ids.forEach((v: any, i: number) => req.input(`p${i}`, v));
          await req.query(`UPDATE ProcurementRecords SET [对账状态] = N'${action_type === "对账" ? "已对账" : "未对账"}', [对账人] = N'${operator}', [对账时间] = GETDATE(), [更新时间] = GETDATE() WHERE Id IN (${inClause})`);

          // 审计日志
          const logReq = pool.request();
          logReq.input("p10", "对账");
          logReq.input("p11", operator);
          logReq.input("p12", `批量${action_type} ${ids.length}条记录`);
          await logReq.query(
            `INSERT INTO ProcurementAuditLog (操作类型, 操作人, 备注) VALUES (@p10, @p11, @p12)`
          );

          result = { message: `成功${action_type} ${ids.length} 条记录` };
          break;
        }

        // ========== 获取供货商列表 ==========
        case "get_suppliers": {
          const req = pool.request();
          const supResult = await req.query(
            "SELECT DISTINCT [供货商全名], [简称] FROM ProcurementRecords WHERE [供货商全名] IS NOT NULL AND [供货商全名] <> '' ORDER BY [供货商全名]"
          );
          result = supResult.recordset;
          break;
        }

        default:
          return new Response(JSON.stringify({ error: "无效的操作" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
      }

      return new Response(JSON.stringify({ success: true, data: result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } finally {
      if (pool) await pool.close();
    }
  } catch (err) {
    console.error("采购对账Edge Function错误:", err);
    return new Response(JSON.stringify({ error: friendlyError(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
