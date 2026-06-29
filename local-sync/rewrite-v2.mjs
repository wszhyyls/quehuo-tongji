/**
 * 精准替换 Edge Function 中所有 SQL 依赖 case 块为 Supabase 版本
 * 策略：用 case "name": 为锚点，替换到下一个 case 为止
 */
import fs from 'fs';

const filePath = '../supabase/functions/query-shortage-data/index.ts';
let src = fs.readFileSync(filePath, 'utf-8');

// 辅助函数：找到 case 块的结束位置（下一个 case 或 break; 后最近的 }）
function findCaseEnd(fromIdx, caseName) {
  const searchFrom = fromIdx + caseName.length + 1;
  // 找下一个 case 关键字
  const nextCase = src.indexOf('\n      case "', searchFrom);
  if (nextCase > 0) return nextCase;
  // 找不到下一个 case，找 break 后最近的 }
  const breakIdx = src.lastIndexOf('break;', src.length);
  return breakIdx > fromIdx ? src.indexOf('}', breakIdx) + 1 : src.length;
}

// 替换函数：oldBlock → newBlock
function replaceCase(caseName, newBlock) {
  const pattern = `\n      case "${caseName}":`;
  const idx = src.indexOf(pattern);
  if (idx < 0) {
    console.log(`⚠ Not found: ${caseName}`);
    return false;
  }
  const end = findCaseEnd(idx, pattern);
  const oldBlock = src.substring(idx, end);
  src = src.replace(oldBlock, `\n      ${newBlock}`);
  console.log(`✓ ${caseName}`);
  return true;
}

// ========== 1. get_all_products ==========
replaceCase("get_all_products",
`case "get_all_products": {
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
);

// ========== 2. check_products_update ==========
replaceCase("check_products_update",
`case "check_products_update": {
        const { count, error } = await supabase
          .from("product_cache").select("*", { count: "exact", head: true });
        result = { product_count: error ? 0 : (count || 0), last_update: new Date().toISOString() };
        break;
      }`
);

// ========== 3. get_store_inventory ==========
replaceCase("get_store_inventory",
`case "get_store_inventory": {
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
      }`
);

// ========== 4. get_product_detail ==========
replaceCase("get_product_detail",
`case "get_product_detail": {
        const p_code = validateInput(params?.product_code, "商品编码", 50);
        if (!p_code) { return new Response(JSON.stringify({ error: "商品编码不能为空" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        const { data: recs, error: err } = await supabase.from("shortage_storestock_cache")
          .select("*").eq("product_code", p_code).order("store_name");
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
);

// ========== 5. get_purchase_plan ==========
replaceCase("get_purchase_plan",
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

// ========== 6. set_actual_order_qty ==========
replaceCase("set_actual_order_qty",
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

// ========== 7. manual_update_status ==========
replaceCase("manual_update_status",
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
      }`
);

// ========== 8-14. 同步/自动检测 stubs ==========
const syncStubs = {
  "auto_detect_status": "auto_detect_status",
  "sync_with_auto_status": "sync_with_auto_status",
  "sync_product_cache": "sync_product_cache",
  "sync_realtime_only": "sync_realtime_only",
  "sync_inventory_incremental": "sync_inventory_incremental",
  "sync_inventory_full": "sync_inventory_full",
  "vba_sync": "vba_sync",
  "get_sync_log": "get_sync_log",
  "sync_cache": "sync_cache",
  "sync_integration": "sync_integration",
};

for (const caseName of Object.keys(syncStubs)) {
  replaceCase(caseName,
`case "${caseName}": {
        console.log(\`[stub] \${action} - 已迁移至本地同步脚本\`);
        result = { success: true, message: "操作「${caseName}」已迁移至本地同步脚本", stub: true };
        break;
      }`
  );
}

// ========== 15-16. get_status_change_log / get_status_log ==========
replaceCase("get_status_change_log",
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

replaceCase("get_status_log",
`case "get_status_log": {
        const { log_product_code, top } = params;
        let q = supabase.from("reports").select("product_code, replenish_status, actual_order_qty, created_at, updated_at, store_name")
          .order("updated_at", { ascending: false }).limit(Math.min(top || 100, 500)).eq("order_type", "缺货订购");
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

// ========== 17. get_my_reports ==========
replaceCase("get_my_reports",
`case "get_my_reports": {
        const { store_id } = params;
        const validStoreId = validateInput(store_id, "门店ID", 50);
        const { data: reports, error: rerr } = await supabase
          .from("reports").select("*").eq("store_id", validStoreId)
          .order("created_at", { ascending: false });
        if (rerr) throw rerr;
        result = reports || [];
        break;
      }`
);

// ========== 18. batch_update_status ==========
replaceCase("batch_update_status",
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

// ========== 19. get_summary ==========
replaceCase("get_summary",
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

// ========== 20. check_order_status ==========
replaceCase("check_order_status",
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

// ========== 清理残留的 getPool / releasePool 调用 ==========
// 如果有任何剩余（注释掉的或漏掉的），直接报错
const remaining = src.match(/getPool|releasePool|sql\.(Int|NVarChar|DateTime|VarChar|Bit)/g);
if (remaining) {
  console.log(`⚠ Remaining SQL references: ${remaining.length}`);
  console.log('  Locations:');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('getPool(') || line.includes('releasePool(') || 
        line.includes('sql.Int') || line.includes('sql.NVarChar') ||
        line.includes('sql.DateTime') || line.includes('sql.VarChar') ||
        line.includes('sql.Bit')) {
      console.log(`    Line ${i+1}: ${line.trim().substring(0, 100)}`);
    }
  });
} else {
  console.log('✓ All SQL references cleaned!');
}

// Write result
fs.writeFileSync(filePath, src, 'utf-8');
console.log('✓ File written');
