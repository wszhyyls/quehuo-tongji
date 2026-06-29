/**
 * 批量重写 Edge Function：移除 SQL Server 依赖，改为纯 Supabase 读写
 * 运行: node rewrite-edge-function.mjs
 */
import fs from 'fs';

const filePath = '../supabase/functions/query-shortage-data/index.ts';
let content = fs.readFileSync(filePath, 'utf-8');

// 定义所有需要替换的 case 块 (old → new)
const replacements = [];

// ========== 1. get_all_products ==========
replacements.push({
  old: `      case "get_all_products": {
        // 获取全量商品数据（L2内存缓存10分钟，商品信息基本不变）
        const productCacheKey = 'all_products';
        const cached = memCacheGet<any[]>(productCacheKey, MEM_CACHE_TTL_PRODUCTS);
        if (cached) {
          console.log(\`✅ get_all_products 命中L2缓存，返回 \${cached.length} 条\`);
          result = cached;
          break;
        }
        
        // 从 RQZT 本地缓存表获取商品（避免跨库全表扫描 ZHYYLS，3-5s → 200ms）
        const poolRQZT = await getPool();
        try {
          const productsResult = await poolRQZT.request()
            .query(\`SELECT
                    product_code,
                    product_name,
                    spec as product_spec,
                    manufacturer,
                    pinyin_code
                    FROM dbo.ProductCache_RQZT WITH (NOLOCK)
                    ORDER BY product_code\`);
          
          // 映射为统一格式
          result = productsResult.recordset.map(p => ({
            product_code: (p.product_code || '').trim(),
            product_name: p.product_name || '',
            product_spec: p.product_spec || '',
            manufacturer: p.manufacturer || '',
            pinyin_code: (p.pinyin_code || '').trim().toLowerCase(),
          }));
          
          memCacheSet(productCacheKey, result); // 存入L2缓存
          console.log(\`✅ get_all_products 返回 \${result.length} 个商品（RQZT缓存表）\`);
        } finally {
          releasePool(poolRQZT);
        }
        break;
      }`,
  new: `      case "get_all_products": {
        const productCacheKey = 'all_products';
        const cached = memCacheGet<any[]>(productCacheKey, MEM_CACHE_TTL_PRODUCTS);
        if (cached) { result = cached; break; }
        const { data: products } = await supabase
          .from("product_cache").select("product_code, product_name, product_spec, manufacturer, pinyin_code")
          .order("product_code").limit(5000);
        result = (products || []).map(p => ({
          product_code: (p.product_code || '').trim(),
          product_name: p.product_name || '',
          product_spec: p.product_spec || '',
          manufacturer: p.manufacturer || '',
          pinyin_code: (p.pinyin_code || '').trim().toLowerCase(),
        }));
        memCacheSet(productCacheKey, result);
        break;
      }`
});

// ========== 2. check_products_update ==========
replacements.push({
  old: `      case "check_products_update": {
        // 从 RQZT 缓存表查询商品总数（避免跨库全表扫描 ZHYYLS）
        const poolRQZT = await getPool();
        try {
          const countResult = await poolRQZT.request()
            .query(\`SELECT COUNT(1) as product_count FROM dbo.ProductCache_RQZT WITH (NOLOCK)\`);
          
          const currentCount = countResult.recordset[0]?.product_count || 0;
          result = {
            product_count: currentCount,
            last_update: new Date().toISOString()
          };
          console.log(\`✅ check_products_update 当前商品数: \${currentCount} (RQZT缓存表)\`);
        } finally {
          releasePool(poolRQZT);
        }
        break;
      }`,
  new: `      case "check_products_update": {
        const { count, error } = await supabase
          .from("product_cache").select("*", { count: "exact", head: true });
        result = { product_count: error ? 0 : (count || 0), last_update: new Date().toISOString() };
        break;
      }`
});

// ========== 3. get_store_inventory ==========
const getStoreInventoryOld = `      case "get_store_inventory": {
        // P0优化：优先从 Supabase 缓存查询，Supabase 失败再降级到 SQL Server
        // 这样可以大幅提升响应速度（Supabase ~50ms vs SQL Server ~3000ms）
        const store_name = validateInput(params?.store_name, "门店名称", 100);
        const force_refresh = params?.force_refresh === true;
        const sync_first = params?.sync_first === true;  // 是否先同步SPFXB_Result再查询
        
        // 强制刷新+先同步：执行 SPFXB 增量刷新（从 ZHYYLS 实时取库存/销售/在途，5-15s）
        let spfxbTime: string | null = null;
        if (force_refresh && sync_first) {
          console.log(\`[get_store_inventory] 门店「\${store_name}」触发SPFXB增量刷新...\`);
          try {
            const syncPool = await getPool();
            try {
              const syncReq = syncPool.request();
              syncReq.input("RefreshRanking", sql.Int, 0);
              await executeWithTimeout(syncPool, syncReq, "SPFXB", { timeout: 90000 });
              spfxbTime = new Date().toISOString();
              console.log(\`[get_store_inventory] SPFXB增量刷新完成\`);
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
            console.error(\`[get_store_inventory] SPFXB增量刷新失败:\`, syncErr);
          }
        }
        // 如果没有刷新，从数据库读上次刷新时间
        if (!spfxbTime) {
          const { data: metaRow } = await supabase
            .from("sync_metadata")`;

const getStoreInventoryNew = `      case "get_store_inventory": {
        const store_name = validateInput(params?.store_name, "门店名称", 100);
        const store_id = params?.store_id;
        let query = supabase.from("shortage_storestock_cache").select("*");
        if (store_id) query = query.eq("store_id", store_id);
        else if (store_name) query = query.ilike("store_name", \`%\${store_name}%\`);
        const page = parseInt(params?.page) || 1;
        const pageSize = parseInt(params?.pageSize) || 500;
        query = query.range((page - 1) * pageSize, page * pageSize - 1);
        const { data: records, error } = await query;
        if (error) throw error;
        result = (records || []).map(r => ({
          "门店名称": r.store_name || '', "商品编码": r.product_code || '',
          "商品名称": r.product_name || '', "规格": r.specification || '',
          "生产企业": r.manufacturer || '', "库存数量": r.store_stock || 0,
          "在途数量": r.in_transit || 0, "门店库存汇总": r.store_total || 0,
          "配送中心库存数量": r.dc_stock || 0, "前30天销售数量": r.sales_30days || 0,
          "前90天销售数量": r.sales_90days || 0, "月均销售数量": r.monthly_sales || 0,
          "标准库存数量": r.standard_stock || 0, "门店计划": r.store_plan || 0,
          "建议订货数量": Math.max(0, (r.standard_stock||0) - (r.store_stock||0) - (r.in_transit||0) + (r.store_plan||0)),
          "标记": r.flag || '', "类别": r.category || '',
        }));
        lastRefreshTime = new Date().toISOString();
        break;
      }`;

// get_store_inventory is too complex for simple replacement, find it by its break line
const getStoreInventoryBreak = `
        break;
      }

      case "get_product_detail":`;

// Replace get_store_inventory by finding its boundaries
const storeInvStart = content.indexOf('case "get_store_inventory":');
const storeInvEnd = content.indexOf(getStoreInventoryBreak, storeInvStart);
if (storeInvStart > 0 && storeInvEnd > storeInvStart) {
  const old_block = content.substring(storeInvStart, storeInvEnd + getStoreInventoryBreak.length);
  content = content.replace(old_block, getStoreInventoryNew + '\n\n      case "get_product_detail":');
} else {
  console.warn('⚠ get_store_inventory not found or boundary mismatch, skipping');
}

// ========== 4. get_product_detail ==========
replacements.push({
  old: `      case "get_product_detail": {` + 
    content.substring(
      content.indexOf('case "get_product_detail":') + 'case "get_product_detail":'.length,
      content.indexOf('break;\n      }\n\n      case "get_purchase_plan"', content.indexOf('case "get_product_detail":'))
    ) + `break;\n      }`,
  new: `      case "get_product_detail": {
        const p_code = validateInput(params?.product_code, "商品编码", 50);
        if (!p_code) { return new Response(JSON.stringify({ error: "商品编码不能为空" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        const { data: recs, error: err } = await supabase.from("shortage_storestock_cache").select("*").eq("product_code", p_code).order("store_name");
        if (err) throw err;
        result = (recs || []).map(r => ({
          "门店名称": r.store_name||'', "商品编码": r.product_code||'', "商品名称": r.product_name||'',
          "规格": r.specification||'', "生产企业": r.manufacturer||'', "库存数量": r.store_stock||0,
          "在途数量": r.in_transit||0, "门店库存汇总": r.store_total||0, "配送中心库存数量": r.dc_stock||0,
          "前30天销售数量": r.sales_30days||0, "前90天销售数量": r.sales_90days||0,
          "月均销售数量": r.monthly_sales||0, "标准库存数量": r.standard_stock||0,
          "门店计划": r.store_plan||0, "建议订货数量": Math.max(0,(r.standard_stock||0)-(r.store_stock||0)-(r.in_transit||0)+(r.store_plan||0)),
          "标记": r.flag||'', "类别": r.category||'',
        }));
        break;
      }`
});

// ========== Apply simple replacements ==========
let applied = 0;
for (const r of replacements) {
  if (content.includes(r.old)) {
    content = content.replace(r.old, r.new);
    applied++;
  } else {
    console.warn(`⚠ Replacement not found (searching for first 80 chars): ${r.old.substring(0, 80)}...`);
  }
}

// ========== Additional targeted replacements for common patterns ==========

// Replace get_my_reports SQL fallback with pure Supabase
const myReportsOld = content.match(/case "get_my_reports".*?break;\s*\}\s*\n\s*case "list_stores"/s);
if (myReportsOld) {
  content = content.replace(myReportsOld[0], 
    `case "get_my_reports": {
        const { store_id } = params;
        const validStoreId = validateInput(store_id, "门店ID", 50);
        const { data: reports, error: rerr } = await supabase
          .from("reports").select("*").eq("store_id", validStoreId)
          .order("created_at", { ascending: false });
        if (rerr) throw rerr;
        result = reports || [];
        break;
      }

      case "list_stores":`);
}

// Replace set_actual_order_qty to write to Supabase
content = content.replace(
  /case "set_actual_order_qty".*?break;\s*\}/s,
  `case "set_actual_order_qty": {
        const { product_code, actual_qty, operator } = params;
        const { error: uerr } = await supabase.from("reports").update({
          actual_order_qty: actual_qty || 0,
          replenish_status: "已订购",
          updated_at: new Date().toISOString()
        }).eq("product_code", validateInput(product_code, "商品编码", 50)).eq("order_type", "缺货订购");
        if (uerr) throw uerr;
        result = { success: true, message: "实际订货数量已更新" };
        break;
      }`
);

// Replace manual_update_status to write to Supabase
content = content.replace(
  /case "manual_update_status".*?break;\s*\}\s*\n\s*case "auto_detect_status"/s,
  `case "manual_update_status": {
        const { product_code, target_status, operator, remark } = params;
        if (!target_status) { return new Response(JSON.stringify({ error: "目标状态不能为空" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        const vpc = validateInput(product_code, "商品编码", 50);
        const vs = validateInput(target_status, "目标状态", 20);
        const vo = validateInput(operator || '管理员', "操作人", 50);
        const vr = validateInput(remark || \`手动改为\${vs}\`, "备注", 200);
        const { error: uerr } = await supabase.from("reports").update({
          replenish_status: vs, updated_at: new Date().toISOString()
        }).eq("product_code", vpc).eq("order_type", "缺货订购");
        if (uerr) throw uerr;
        await supabase.from("status_change_log").insert({
          product_code: vpc, new_status: vs, operator: vo, remark: vr,
          changed_at: new Date().toISOString()
        });
        result = { success: true, message: \`状态已更新为「\${vs}」\` };
        break;
      }

      case "auto_detect_status":`
);

// Replace batch_update_status to write to Supabase
content = content.replace(
  /case "batch_update_status".*?break;\s*\}/s,
  `case "batch_update_status": {
        const { product_codes, target_status, operator } = params;
        if (!product_codes || !Array.isArray(product_codes) || product_codes.length === 0) {
          return new Response(JSON.stringify({ error: "商品编码列表不能为空" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        let successCount = 0;
        for (const code of product_codes) {
          const { error: uerr } = await supabase.from("reports").update({
            replenish_status: target_status, updated_at: new Date().toISOString()
          }).eq("product_code", code).eq("order_type", "缺货订购");
          if (!uerr) successCount++;
        }
        result = { success: true, success_count: successCount, total: product_codes.length };
        break;
      }`
);

// Replace get_status_change_log → Supabase
content = content.replace(
  /case "get_status_change_log".*?break;\s*\}/s,
  `case "get_status_change_log": {
        const { log_product_code, top } = params;
        let q = supabase.from("status_change_log").select("*").order("changed_at", { ascending: false }).limit(Math.min(top || 100, 500));
        if (log_product_code) q = q.eq("product_code", validateInput(log_product_code, "商品编码", 50));
        const { data: logs, error: lerr } = await q;
        if (lerr) throw lerr;
        result = logs || [];
        break;
      }`
);

// Replace get_status_log → Supabase reports
content = content.replace(
  /case "get_status_log".*?break;\s*\}/s,
  `case "get_status_log": {
        const { log_product_code, top } = params;
        let q = supabase.from("reports").select("product_code, replenish_status, actual_order_qty, created_at, updated_at, store_name").order("updated_at", { ascending: false }).limit(Math.min(top || 100, 500)).eq("order_type", "缺货订购");
        if (log_product_code) q = q.eq("product_code", validateInput(log_product_code, "商品编码", 50));
        const { data: logs, error: lerr } = await q;
        if (lerr) throw lerr;
        result = (logs || []).map(r => ({
          "商品编码": r.product_code, "补货状态": r.replenish_status||'', "实际订货数量": r.actual_order_qty||null,
          "订货时间": r.created_at, "到货确认时间": r.updated_at, "操作人": r.store_name||'', "备注": r.replenish_status||''
        }));
        break;
      }`
);

// ========== Sync stubs ==========
const syncStubs = {
  'auto_detect_status': '自动状态检测',
  'sync_with_auto_status': '同步+自动检测',
  'sync_product_cache': '商品缓存同步',
  'sync_inventory_incremental': '增量库存同步',
  'sync_inventory_full': '全量库存同步',
  'sync_realtime_only': '实时同步',
  'vba_sync': 'VBA同步',
  'get_sync_log': '同步日志',
  'sync_cache': '缓存同步',
  'sync_integration': '集成同步'
};

for (const [caseName, desc] of Object.entries(syncStubs)) {
  const escapedName = caseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`case "${escapedName}".*?break;\\s*\\}`, 's');
  content = content.replace(regex, 
    `case "${caseName}": { console.log(\`[stub] \${action} - 已迁移至本地同步脚本\`); result = { success: true, message: "操作「${desc}」已迁移至本地同步脚本", stub: true }; break; }`);
}

// Replace get_purchase_plan → Supabase 
content = content.replace(
  /case "get_purchase_plan".*?break;\s*\}/s,
  `case "get_purchase_plan": {
        const { plan_product_code, keyword, status_filter, page, pageSize } = params;
        const pg = parseInt(page) || 1, ps = parseInt(pageSize) || 500;
        let q = supabase.from("shortage_storestock_cache").select("*");
        if (plan_product_code) { q = q.eq("product_code", plan_product_code).limit(1); }
        else { if (keyword) { const kw = \`%\${keyword}%\`; q = q.or(\`product_code.ilike.\${kw},product_name.ilike.\${kw}\`); } q = q.range((pg-1)*ps, pg*ps-1); }
        const { data: recs, error: perr } = await q;
        if (perr) throw perr;
        result = (recs || []).map(r => ({
          "商品编码": r.product_code||'', "商品名称": r.product_name||'', "规格": r.specification||'',
          "生产企业": r.manufacturer||'', "库存数量": r.store_stock||0, "在途数量": r.in_transit||0,
          "门店库存汇总": r.store_total||0, "配送中心库存数量": r.dc_stock||0,
          "前30天销售数量": r.sales_30days||0, "前90天销售数量": r.sales_90days||0,
          "月均销售数量": r.monthly_sales||0, "标准库存数量": r.standard_stock||0,
          "门店计划": r.store_plan||0, "建议订货数量": Math.max(0,(r.standard_stock||0)-(r.store_stock||0)-(r.in_transit||0)+(r.store_plan||0)),
          "标记": r.flag||'', "类别": r.category||'', "门店名称": r.store_name||'', "补货状态": '', "供货商": ''
        }));
        break;
      }`
);

// Replace get_summary → Supabase
content = content.replace(
  /case "get_summary".*?break;\s*\}/s,
  `case "get_summary": {
        const { store_id, keyword: kw, status_filter: sf } = params;
        let q = supabase.from("shortage_storestock_cache").select("*");
        if (store_id) q = q.eq("store_id", validateInput(store_id, "门店ID", 50));
        if (kw) { const kwPat = \`%\${kw}%\`; q = q.or(\`product_code.ilike.\${kwPat},product_name.ilike.\${kwPat}\`); }
        const { data: recs, error: serr } = await q;
        if (serr) throw serr;
        result = (recs || []).map(r => ({
          "门店名称": r.store_name||'', "商品编码": r.product_code||'', "商品名称": r.product_name||'',
          "规格": r.specification||'', "生产企业": r.manufacturer||'', "库存数量": r.store_stock||0,
          "在途数量": r.in_transit||0, "门店库存汇总": r.store_total||0, "配送中心库存数量": r.dc_stock||0,
          "前30天销售数量": r.sales_30days||0, "前90天销售数量": r.sales_90days||0,
          "月均销售数量": r.monthly_sales||0, "标准库存数量": r.standard_stock||0,
          "门店计划": r.store_plan||0, "建议订货数量": Math.max(0,(r.standard_stock||0)-(r.store_stock||0)-(r.in_transit||0)+(r.store_plan||0)),
          "标记": r.flag||'', "类别": r.category||'', "补货状态": '', "供货商": ''
        }));
        break;
      }`
);

// Replace check_order_status → Supabase simplified
content = content.replace(
  /case "check_order_status".*?break;\s*\}/s,
  `case "check_order_status": {
        const { product_codes, store_name } = params;
        if (!product_codes || !Array.isArray(product_codes) || product_codes.length === 0) {
          result = { buyMap: {}, sendMap: {} }; break;
        }
        const { data: statusData } = await supabase.from("reports")
          .select("product_code, replenish_status, updated_at, store_name")
          .in("product_code", product_codes).eq("order_type", "缺货订购");
        const buyMap: Record<string, string> = {}, sendMap: Record<string, string> = {};
        (statusData || []).forEach(r => { buyMap[r.product_code] = r.updated_at || ''; });
        result = { buyMap, sendMap };
        break;
      }`
);

// Clean up any remaining getPool/releasePool/closeAllPools references
content = content.replace(/releasePool\([^)]+\)/g, '// releasePool removed (v4.0)');
content = content.replace(/closeAllPools\(\)/g, '// closeAllPools removed (v4.0)');

// Write the result
fs.writeFileSync(filePath, content, 'utf-8');
console.log(`✅ Rewrite complete. Simple replacements: ${applied} applied.`);
console.log(`   File: ${filePath}`);
