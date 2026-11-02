// Supabase Edge Function - 定时任务
// v3.17: 现查总账模式（去掉 carryover 余量结转，每次从 earliestActive 重新算）
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

// ========== v3.17 简化版：现查总账 + 90天自动关闭 + 30天超时回退 ==========
// 核心逻辑：所有待处理 reports 都参与判定，anchor = 最早未完成上报日
//           采购入库累计（锚点起） ≥ 总需求 → 判定完成
//           采购入库累计（锚点起） <  总需求 → 不判定，等下次同步
// 迁移上线时间兜底锚点
const STATUS_MIGRATION_EPOCH = '2026-09-17';
// 超期关闭：90 天未完成的 reports 自动标记"已关闭(未补货)"
const AUTO_CLOSE_DAYS = 90;
// 失败告警阈值
const FAIL_ALERT_THRESHOLD = 3;
// 暂停自动判定的状态（厂家断货由门店手动处理）
const DETECT_PAUSED_STATUSES = ['厂家断货', '已关闭'];

// 查单商品增量采购：从 anchor 起的采购累计 + 最新采购日期
// 一次查询拿到所有需要的数据
async function queryPurchaseDelta(
  pool: sql.ConnectionPool, code: string, anchor: string
): Promise<{ delta: number; latestDate: string | null; totalAfterAnchor: number }> {
  const req = pool.request();
  req.input("code", sql.NVarChar(50), code);
  req.input("anchor", sql.VarChar(10), (anchor || STATUS_MIGRATION_EPOCH).substring(0, 10));
  const res = await req.query(`
    SELECT 
      ISNULL(SUM(ABS(vs.Qty)), 0) as qty,
      MAX(vs.BillDate) as latest_date
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE v.usercode = @code
      AND vs.BillType = 34
      AND vs.InKRec = '3'
      AND vs.BillDate > @anchor
  `);
  const row = res.recordset?.[0] as any;
  return {
    delta: Number(row?.qty || 0),
    latestDate: row?.latest_date || null,
    totalAfterAnchor: Number(row?.qty || 0)
  };
}

// 查单商品**全历史**最新采购日期（事件驱动保护期用）
async function queryLatestPurchaseDate(
  pool: sql.ConnectionPool, code: string
): Promise<string | null> {
  const req = pool.request();
  req.input("code", sql.NVarChar(50), code);
  const res = await req.query(`
    SELECT MAX(vs.BillDate) as latest_date
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE v.usercode = @code
      AND vs.BillType = 34
      AND vs.InKRec = '3'
  `);
  const row = res.recordset?.[0] as any;
  return row?.latest_date || null;
}

async function preciseAutoDetectStatusV2(
  pool: sql.ConnectionPool,
  supabaseClient: any
): Promise<{ detected: number; details: string[] }> {
  const details: string[] = [];
  const now = new Date().toISOString();
  const nowTs = Date.now();

  try {
    // ================================================================
    // Step 0: 90 天超期自动关闭（独立步骤，不影响判定）
    // ================================================================
    const CUTOFF_90_DAYS = new Date(nowTs - AUTO_CLOSE_DAYS * 86400000).toISOString();
    let closedCount = 0;
    try {
      const { data: oldPending, error: qErr } = await supabaseClient
        .from("reports")
        .select("id, product_code")
        .eq("order_type", "缺货订购")
        .neq("replenish_status", "已完成")
        .neq("replenish_status", "厂家断货")
        .lt("created_at", CUTOFF_90_DAYS);
      if (qErr) {
        console.warn('[v3] 超期关闭查询失败:', qErr.message);
      } else if (oldPending && oldPending.length > 0) {
        const ids = oldPending.map((r: any) => r.id);
        // 分批更新（Supabase in 最多 1000）
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500);
          const { error: cErr } = await supabaseClient.from("reports").update({
            replenish_status: '已关闭',
            status_remark: `超期${AUTO_CLOSE_DAYS}天未补货自动关闭`,
            status_changed_at: now,
            status_changed_by: '系统自动',
            auto_closed_at: now,
            close_reason: `超期${AUTO_CLOSE_DAYS}天`
          }).in("id", batch);
          if (!cErr) closedCount += batch.length;
        }
        // 同步更新 product_completion.closed_count
        const closedCodes = [...new Set(oldPending.map((r: any) => r.product_code))];
        for (const code of closedCodes) {
          const cnt = oldPending.filter((r: any) => r.product_code === code).length;
          await supabaseClient.from("product_completion").upsert({
            product_code: code,
            closed_count: cnt,
            updated_at: now
          }, { onConflict: 'product_code' });
        }
      }
    } catch (e) {
      console.warn('[v3] 超期关闭异常:', e);
    }
    if (closedCount > 0) details.push(`超期${AUTO_CLOSE_DAYS}天自动关闭: ${closedCount} 条`);

    // ================================================================
    // Step 1: 分页拉取未完成 reports
    // ================================================================
    let allItems: any[] = [];
    let from = 0;
    const PAGE_SIZE = 1000;
    while (true) {
      const { data: page, error } = await supabaseClient
        .from("reports")
        .select("id, product_code, store_id, store_name, demand_quantity, created_at, replenish_status, status_changed_at")
        .eq("order_type", "缺货订购")
        .not("product_code", "is", null)
        .neq("replenish_status", "已完成")
        .neq("replenish_status", "厂家断货")
        .neq("replenish_status", "已关闭")
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) { console.warn('[v3] 分页查询失败:', error.message); break; }
      if (!page || page.length === 0) break;
      allItems = allItems.concat(page);
      if (page.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    details.push(`未完成缺货: ${allItems.length} 条`);

    const activeCodes = [...new Set(allItems.map((r: any) => r.product_code).filter(Boolean))];
    details.push(`待检测商品: ${activeCodes.length} 个`);
    if (activeCodes.length === 0) {
      if (closedCount === 0) details.push('无未完成缺货，跳过判定');
      return { detected: 0, details };
    }

    // ================================================================
    // Step 2: 读取 product_completion（只取 fail_count 和 last_completed_at，弃用 carryover/anchor）
    // ================================================================
    const compMap: Record<string, any> = {};
    for (let i = 0; i < activeCodes.length; i += 200) {
      const batch = activeCodes.slice(i, i + 200);
      const { data: rows } = await supabaseClient
        .from("product_completion")
        .select("product_code, fail_count, last_completed_at")
        .in("product_code", batch);
      (rows || []).forEach((c: any) => { compMap[c.product_code] = c; });
    }

    // ================================================================
    // Step 3: 构建缺货汇总 + 最早未完成上报日（简化版：不做保护期过滤）
    // ================================================================
    const demandByCode: Record<string, number> = {};
    const earliestActiveAt: Record<string, string> = {};
    for (const r of allItems) {
      const code = r.product_code;
      if (!code) continue;
      demandByCode[code] = (demandByCode[code] || 0) + (Number(r.demand_quantity) || 0);
      const ts = new Date(r.created_at).toISOString();
      if (!earliestActiveAt[code] || ts < earliestActiveAt[code]) {
        earliestActiveAt[code] = ts;
      }
    }

    // 简化版：所有待处理 reports 都参与判定，不做事件驱动保护期过滤
    // 不再排除 "上报后没新采购" 的商品，老老实实查总账
    const filteredItems = allItems;
    const filteredCodes = activeCodes;
    details.push(`参与判定: ${filteredItems.length} 条 / ${filteredCodes.length} 个商品（全部参与，无保护期过滤）`);

    if (filteredCodes.length === 0) {
      details.push('无待处理缺货，跳过判定');
      return { detected: 0, details };
    }

    // ================================================================
    // Step 4: 批量查所有待判定商品的采购明细 → JS 内存里按 anchor 过滤求和
    //         anchor = earliestActive（该商品最早未完成上报日）
    // ================================================================
    const codesList = filteredCodes.map(c => `N'${c.replace(/'/g, "''")}'`).join(',');
    let purchaseInfo: Record<string, { qty: number; anchor: string; error?: string }> = {};
    try {
      const purchaseRes = await pool.request().query(`
        SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
        FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
        JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
        WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesList})
      `);
      // 按 usercode 分组
      const purchaseByCode: Record<string, { date: string; qty: number }[]> = {};
      for (const row of purchaseRes.recordset) {
        const r = row as any;
        if (!purchaseByCode[r.usercode]) purchaseByCode[r.usercode] = [];
        purchaseByCode[r.usercode].push({ date: r.BillDate, qty: Number(r.qty || 0) });
      }
      // 内存计算：每个 code 的 anchor 起累计
      for (const code of filteredCodes) {
        const anchor = (earliestActiveAt[code] || STATUS_MIGRATION_EPOCH).substring(0, 10);
        const rows = purchaseByCode[code] || [];
        const anchorTs = new Date(anchor).getTime();
        const qty = rows.reduce((s, r) => s + (new Date(r.date).getTime() >= anchorTs ? r.qty : 0), 0);
        purchaseInfo[code] = { qty, anchor };
      }
    } catch (e: any) {
      const errMsg = String(e?.message || e);
      console.error('[批量查询] purchaseDetail 失败:', errMsg);
      for (const code of filteredCodes) {
        const anchor = (earliestActiveAt[code] || STATUS_MIGRATION_EPOCH).substring(0, 10);
        purchaseInfo[code] = { qty: 0, anchor, error: errMsg };
      }
    }

    // ================================================================
    // Step 5: 判定（简化版：所有商品一视同仁，不区分全新/老商品）
    // ================================================================
    let completedCount = 0;
    const failedCodes: string[] = [];
    for (const code of filteredCodes) {
      const demand = demandByCode[code] || 0;
      const info = purchaseInfo[code];
      const comp = compMap[code] || {};
      if (!info) continue;

      // 5a: 查询异常 → fail_count++
      if (info.error) {
        const newFail = (Number(comp.fail_count || 0)) + 1;
        failedCodes.push(`${code}(fail=${newFail})`);
        await supabaseClient.from("product_completion").upsert({
          product_code: code, fail_count: newFail, updated_at: now
        }, { onConflict: 'product_code' });
        continue;
      }

      // 5b: 判定 —— 采购累计 ≥ 总需求 → 已完成
      const purchase = info.qty;
      if (demand > 0 && purchase >= demand) {
        const idsToUpdate = filteredItems
          .filter((r: any) => r.product_code === code)
          .map((r: any) => r.id);
        const remark = `自动判定：采购${purchase}≥缺货${demand}（锚点${info.anchor}）`;
        try {
          const { error: updErr } = await supabaseClient.from("reports").update({
            replenish_status: '已完成',
            status_remark: remark,
            status_changed_at: now,
            status_changed_by: '系统自动',
            settled_at: now
          }).in("id", idsToUpdate).neq("replenish_status", "已完成");

          if (!updErr) {
            // 判定完成只更新 last_completed_at + 重置 fail_count，不碰 carryover/anchor
            await supabaseClient.from("product_completion").upsert({
              product_code: code,
              last_completed_at: now,
              fail_count: 0,
              updated_at: now
            }, { onConflict: 'product_code' });
            try {
              await supabaseClient.from("store_notifications").update({ notified_at: null })
                .eq("product_code", code);
            } catch (_) {}
            completedCount++;
          }
        } catch (e) {
          console.warn(`[v3.17] ${code} 标记完成失败:`, e);
        }
      }
      // 判定不通过 → 什么都不改，等下次同步再查
    }
    details.push(`判定完成: ${completedCount} 个商品`);
    if (failedCodes.length > 0) {
      const highFail = failedCodes.filter(c => {
        const m = c.match(/fail=(\d+)/); return m && parseInt(m[1]) >= FAIL_ALERT_THRESHOLD;
      });
      details.push(`⚠ SQL异常跳过 ${failedCodes.length} 个，≥${FAIL_ALERT_THRESHOLD}次告警: ${highFail.slice(0, 5).join(', ')}${highFail.length > 5 ? `...共${highFail.length}` : ''}`);
    }

    // ================================================================
    // Step 6: 30 天超时回退（已订购/待付款采购仍不够 → 待处理）
    // ================================================================
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    let revertedCount = 0;
    for (const r of allItems) {
      const s = r.replenish_status;
      if (s !== '已订购' && s !== '待付款') continue;
      const changedAt = r.status_changed_at ? new Date(r.status_changed_at).getTime() : 0;
      if (!changedAt || (nowTs - changedAt) < THIRTY_DAYS_MS) continue;
      const code = r.product_code;
      const info = purchaseInfo[code];
      const demand = demandByCode[code] || 0;
      if (info && info.qty >= demand) continue; // 采购已够就不回退
      try {
        const { error: revErr } = await supabaseClient.from("reports").update({
          replenish_status: '待处理',
          status_remark: '超时回退(30天未到货)',
          status_changed_at: now,
          status_changed_by: '系统自动'
        }).eq("id", r.id);
        if (!revErr) revertedCount++;
      } catch (e) { /* 不阻断 */ }
    }
    if (revertedCount > 0) {
      details.push(`超时回退: ${revertedCount} 条(30天未到货) → 待处理`);
    }

    return { detected: completedCount, details };
  } catch (err) {
    console.error('[scheduled-task v3] 错误:', err);
    return { detected: 0, details: [String(err)] };
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
    // 从 RQZT 缓存表获取全量商品（FullName 标准名，避免 Vptype.Name 的「品名(品牌)」后缀）
    // 先刷新缓存表再读取，与 query-shortage-data 的数据源保持一致
    await pool.request().execute('usp_Sync_ProductCache_RQZT');
    const result = await pool.request().query(`
      SELECT
        product_code,
        product_name,
        spec as product_spec,
        manufacturer,
        pinyin_code
      FROM dbo.ProductCache_RQZT WITH (NOLOCK)
      ORDER BY product_code
    `);
    
    const products = result.recordset || [];
    console.log(`[定时任务] 获取商品 ${products.length} 条`);
    
    // UPSERT（有则更新，无则插入），消除 DELETE→INSERT 空窗
    const batchSize = 200;
    let totalInserted = 0;
    
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      const { error: insertError } = await supabase.from('product_cache').upsert(batch, { onConflict: 'product_code' });
      
      if (insertError) {
        console.error(`[定时任务] UPSERT 商品批次 ${i / batchSize + 1} 失败:`, insertError);
      } else {
        totalInserted += batch.length;
        console.log(`[定时任务] 已同步 ${totalInserted}/${products.length} 条`);
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
    let autoDetectDetails: string[] = [];
    try {
      const detectR = await preciseAutoDetectStatusV2(pool, supabase);
      autoDetectCount = detectR.detected;
      autoDetectDetails = detectR.details;
      console.log(`[定时任务] 精准检测: ${autoDetectCount}个已完成`, JSON.stringify(detectR.details));
    } catch (detectErr) {
      console.error('[定时任务] 精准检测失败:', detectErr);
    }
    
    return { success: true, message: `同步完成，${autoDetectCount}个已完成`, supabase_synced: supabaseSynced, auto_detected: autoDetectCount, detection_details: autoDetectDetails };
    
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

// ========== 查询自动同步状态 ==========
async function getLastSyncInfo(): Promise<{
  success: boolean;
  auto_sync?: { start_time: string; status: string };
  next_sync_beijing?: string;
  cron_jobs?: Array<{ jobid: number; jobname: string; schedule: string }>;
  error?: string;
}> {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const SYNC_JOBID = 11; // sync-spfxb-result

    // 查最近一次自动同步运行记录
    const { data, error } = await supabase
      .rpc('get_last_cron_run', { p_jobid: SYNC_JOBID });

    if (error) {
      return { success: false, error: error.message };
    }

    // 算下次同步时间（UTC 16:30 = 北京 00:30，明天）
    const now = new Date();
    const nextUtc = new Date(now);
    nextUtc.setUTCHours(16, 30, 0, 0);
    if (nextUtc.getTime() <= now.getTime()) {
      nextUtc.setUTCDate(nextUtc.getUTCDate() + 1);
    }
    const nextBeijing = nextUtc.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });

    return {
      success: true,
      auto_sync: data ? {
        start_time: data.start_time,
        status: data.status
      } : undefined,
      next_sync_beijing: nextBeijing
    };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
}

// ========== DEBUG: 查单商品判定详情 ==========
async function debugCheckCode(code: string, forceAnchor?: string): Promise<any> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const pool = await getPool();

  try {
    // 1. Supabase 里的 reports
    const { data: reports } = await supabase
      .from("reports")
      .select("id, store_name, demand_quantity, replenish_status, created_at, status_remark")
      .eq("product_code", code)
      .eq("order_type", "缺货订购")
      .order("created_at", { ascending: false });

    // 2. product_completion（v3 新增字段）
    const { data: comp } = await supabase
      .from("product_completion").select("*").eq("product_code", code);

    // 3. 未完成缺货汇总
    const pending = (reports || []).filter((r: any) => r.replenish_status !== '已完成' && r.replenish_status !== '厂家断货' && r.replenish_status !== '已关闭');
    const demand = pending.reduce((s: number, r: any) => s + (Number(r.demand_quantity) || 0), 0);
    const totalDemand = (reports || []).reduce((s: number, r: any) => s + (Number(r.demand_quantity) || 0), 0);

    // 4. 事件驱动保护期：全历史最新采购日期
    let latestPurchaseAllTime: string | null = null;
    let anchorForDelta: string = forceAnchor || STATUS_MIGRATION_EPOCH;
    try {
      const latestRes = await pool.request()
        .input("code", sql.NVarChar(50), code)
        .query(`
          SELECT MAX(vs.BillDate) as latest_date
          FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
          JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
          WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3'
        `);
      latestPurchaseAllTime = latestRes.recordset?.[0]?.latest_date || null;
    } catch {}

    // 5. 增量采购 + 结转余量
    const compRow = comp?.[0] || {};
    const lastAnchor = compRow.last_anchor?.substring(0, 10) || STATUS_MIGRATION_EPOCH;
    const carryover = Number(compRow.carryover_qty || 0);
    anchorForDelta = forceAnchor || lastAnchor;

    let deltaAfterAnchor = 0;
    let rowsAll: any[] = [];
    try {
      const req1 = pool.request();
      req1.input("code", sql.NVarChar(50), code);
      req1.input("anchor", sql.VarChar(10), anchorForDelta);
      const res1 = await req1.query(`
        SELECT ISNULL(SUM(ABS(vs.Qty)), 0) as qty
        FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
        JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
        WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3' AND vs.BillDate > @anchor
      `);
      deltaAfterAnchor = Number(res1.recordset?.[0]?.qty || 0);

      const resAll = await pool.request().query(`
        SELECT vs.BillDate, ABS(vs.Qty) as Qty, v.usercode as Code
        FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
        JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
        WHERE v.usercode = '${code.replace(/'/g, "''")}' AND vs.BillType = 34 AND vs.InKRec = '3'
        ORDER BY vs.BillDate DESC
      `);
      rowsAll = resAll.recordset || [];
    } catch (e: any) {
      return { success: false, error: String(e?.message || e) };
    }

    const totalAllTime = rowsAll.reduce((s: number, r: any) => s + Number(r.Qty || 0), 0);

    // 简化版：所有 pending reports 都参与判定，anchor = 最早上报日
    const anchorEarliest = pending.length > 0
      ? pending.reduce((e: string, r: any) => {
          const c = (r.created_at || '').substring(0, 10);
          return !e || c < e ? c : e;
        }, STATUS_MIGRATION_EPOCH)
      : STATUS_MIGRATION_EPOCH;
    let deltaFromEarliestAnchor = 0;
    try {
      const req2 = pool.request();
      req2.input("code", sql.NVarChar(50), code);
      req2.input("anchor", sql.VarChar(10), anchorEarliest);
      const res2 = await req2.query(`
        SELECT ISNULL(SUM(ABS(vs.Qty)), 0) as qty
        FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
        JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
        WHERE v.usercode = @code AND vs.BillType = 34 AND vs.InKRec = '3' AND vs.BillDate >= @anchor
      `);
      deltaFromEarliestAnchor = Number(res2.recordset?.[0]?.qty || 0);
    } catch {}

    return {
      success: true,
      product_code: code,
      version: 'v3.17 简化版（无保护期，现查总账）',
      supabase_reports: reports,
      pending_demand: demand,
      anchor_earliest_report: anchorEarliest,
      all_reports_total_demand: totalDemand,
      completion_state: {
        fail_count: compRow.fail_count,
        last_completed_at: compRow.last_completed_at,
        updated_at: compRow.updated_at
      },
      purchase_analysis: {
        latest_purchase_all_time: latestPurchaseAllTime,
        purchase_since_earliest_anchor: deltaFromEarliestAnchor,
        all_time_total: totalAllTime
      },
      judge_result_now: demand > 0 && deltaFromEarliestAnchor >= demand
        ? `✅ 判定完成：采购${deltaFromEarliestAnchor}≥缺货${demand}（锚点${anchorEarliest}）`
        : demand === 0
          ? '✅ 无未完成缺货'
          : `❌ 不满足：锚点${anchorEarliest}起采购${deltaFromEarliestAnchor}<缺货${demand}，差${demand - deltaFromEarliestAnchor}`,
      logic_breakdown: `
        1. 简化版：无事件驱动保护期，所有${pending.length}条待处理都参与
        2. 锚点=${anchorEarliest}（最早未完成上报日）
        3. 总需求=${demand}
        4. 锚点起采购累计=${deltaFromEarliestAnchor}
        5. ${deltaFromEarliestAnchor >= demand ? '采购足够，判定完成' : '采购还差' + (demand - deltaFromEarliestAnchor)}
      `.trim()
    };
  } finally {
    releasePool(pool);
  }
}

// ========== Secret 鉴权（供 pg_cron 定时任务绕过 JWT 调用） ==========
const TASK_SECRET = Deno.env.get("TASK_SECRET") || "wszh_auto_sync_2026";

function checkSecret(req: Request): boolean {
  const provided = req.headers.get("x-task-secret") || req.headers.get("x-sync-secret") || "";
  const auth = req.headers.get("authorization") || "";
  // 允许: 自定义 secret header 匹配 / 或 Bearer service_role key（由 Supabase 自动处理 JWT）
  return provided.trim() === TASK_SECRET.trim() || auth.startsWith("Bearer ");
}

// ========== HTTP Server ==========
serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  
  // 先解析 action，判断是否需要鉴权
  let reqBody: any = {};
  try { reqBody = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "请使用 POST + JSON 格式调用" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { action } = reqBody;
  // health / get_last_sync / debug_check_code / run_detect_only 是只读查询或幂等操作，免鉴权
  const PUBLIC_ACTIONS = ["health", "get_last_sync", "debug_check_code", "run_detect_only"];
  if (!PUBLIC_ACTIONS.includes(action || "") && !checkSecret(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  
  try {
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

      case "get_last_sync": {
        // 查询自动同步状态（上次自动同步时间 + 下次预计时间）
        result = await getLastSyncInfo();
        break;
      }

      case "debug_check_code": {
        // DEBUG: 查单商品完成判定详情（缺货汇总 + 采购入库累计）
        result = await debugCheckCode(reqBody.product_code || reqBody.code || '', reqBody.anchor);
        break;
      }

      case "run_detect_only": {
        // 仅跑完成判定逻辑（跳过存储过程，快速验证新逻辑）
        console.log('[定时任务] run_detect_only: 仅跑自动判定...');
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        const pool = await getPool();
        try {
          const detectR = await preciseAutoDetectStatusV2(pool, supabase);
          result = {
            success: true,
            mode: 'run_detect_only',
            detected: detectR.detected,
            detection_details: detectR.details
          };
        } finally {
          releasePool(pool);
        }
        break;
      }
      
      default:
        return new Response(JSON.stringify({ 
          error: `未知操作: ${action}`,
          available_actions: ["full_sync", "sync_rqzt_cache", "sync_product", "sync_plan", "run_detect_only", "get_logs", "health", "get_last_sync", "debug_check_code"]
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
