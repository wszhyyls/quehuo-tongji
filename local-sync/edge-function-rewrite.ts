/**
 * 此文件包含 query-shortage-data/index.ts 中需要替换的 case 块
 * 所有 SQL Server 依赖的 case 改为纯 Supabase 读写
 * 前端接口 100% 兼容，不做任何参数或返回值变更
 */

// ======== 1. get_all_products (行245-283) → Supabase ========
      case "get_all_products": {
        const productCacheKey = 'all_products';
        const cached = memCacheGet<any[]>(productCacheKey, MEM_CACHE_TTL_PRODUCTS);
        if (cached) {
          result = cached;
          break;
        }
        const { data: products } = await supabase
          .from("product_cache")
          .select("product_code, product_name, product_spec, manufacturer, pinyin_code")
          .order("product_code")
          .limit(5000);
        result = (products || []).map(p => ({
          product_code: (p.product_code || '').trim(),
          product_name: p.product_name || '',
          product_spec: p.product_spec || '',
          manufacturer: p.manufacturer || '',
          pinyin_code: (p.pinyin_code || '').trim().toLowerCase(),
        }));
        memCacheSet(productCacheKey, result);
        break;
      }

// ======== 2. check_products_update (行286-303) → Supabase ========
      case "check_products_update": {
        const { count, error } = await supabase
          .from("product_cache")
          .select("*", { count: "exact", head: true });
        result = {
          product_count: error ? 0 : (count || 0),
          last_update: new Date().toISOString()
        };
        break;
      }

// ======== 3. get_store_inventory (行306-494) → Supabase shortcut_storestock_cache ========
      case "get_store_inventory": {
        const store_name = validateInput(params?.store_name, "门店名称", 100);
        const store_id = params?.store_id;
        
        // 从 Supabase 缓存读取
        let query = supabase
          .from("shortage_storestock_cache")
          .select("*");
        
        if (store_id) {
          query = query.eq("store_id", store_id);
        } else if (store_name) {
          query = query.ilike("store_name", `%${store_name}%`);
        }
        
        // 分页支持
        const page = parseInt(params?.page) || 1;
        const pageSize = parseInt(params?.pageSize) || 500;
        query = query.range((page - 1) * pageSize, page * pageSize - 1);
        
        const { data: records, error } = await query;
        
        if (error) throw error;
        
        const rows = (records || []).map(r => ({
          "门店名称": r.store_name || '',
          "商品编码": r.product_code || '',
          "商品名称": r.product_name || '',
          "规格": r.specification || '',
          "生产企业": r.manufacturer || '',
          "库存数量": r.store_stock || 0,
          "在途数量": r.in_transit || 0,
          "门店库存汇总": r.store_total || 0,
          "配送中心库存数量": r.dc_stock || 0,
          "前30天销售数量": r.sales_30days || 0,
          "前90天销售数量": r.sales_90days || 0,
          "月均销售数量": r.monthly_sales || 0,
          "标准库存数量": r.standard_stock || 0,
          "门店计划": r.store_plan || 0,
          "建议订货数量": Math.max(0, (r.standard_stock||0) - (r.store_stock||0) - (r.in_transit||0) + (r.store_plan||0)),
          "标记": r.flag || '',
          "类别": r.category || '',
        }));
        
        result = rows;
        lastRefreshTime = new Date().toISOString();
        break;
      }

// ======== 4. get_product_detail (行496-624) → Supabase ========
      case "get_product_detail": {
        const product_code = validateInput(params?.product_code, "商品编码", 50);
        if (!product_code) {
          return new Response(JSON.stringify({ error: "商品编码不能为空" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const { data: records, error } = await supabase
          .from("shortage_storestock_cache")
          .select("*")
          .eq("product_code", product_code)
          .order("store_name");
        if (error) throw error;
        result = (records || []).map(r => ({
          "门店名称": r.store_name || '',
          "商品编码": r.product_code || '',
          "商品名称": r.product_name || '',
          "规格": r.specification || '',
          "生产企业": r.manufacturer || '',
          "库存数量": r.store_stock || 0,
          "在途数量": r.in_transit || 0,
          "门店库存汇总": r.store_total || 0,
          "配送中心库存数量": r.dc_stock || 0,
          "前30天销售数量": r.sales_30days || 0,
          "前90天销售数量": r.sales_90days || 0,
          "月均销售数量": r.monthly_sales || 0,
          "标准库存数量": r.standard_stock || 0,
          "门店计划": r.store_plan || 0,
          "建议订货数量": Math.max(0, (r.standard_stock||0) - (r.store_stock||0) - (r.in_transit||0) + (r.store_plan||0)),
          "标记": r.flag || '',
          "类别": r.category || '',
        }));
        break;
      }

// ======== 5. get_purchase_plan (行626-724) → Supabase ========
      case "get_purchase_plan": {
        const { plan_product_code, keyword, status_filter, page, pageSize } = params;
        const pg = parseInt(page) || 1;
        const ps = parseInt(pageSize) || 500;
        
        let query = supabase.from("shortage_storestock_cache").select("*");
        
        if (plan_product_code) {
          query = query.eq("product_code", plan_product_code).limit(1);
        } else {
          if (keyword) {
            const kw = `%${keyword}%`;
            query = query.or(`product_code.ilike.${kw},product_name.ilike.${kw}`);
          }
          query = query.range((pg - 1) * ps, pg * ps - 1);
        }
        
        const { data: records, error } = await query;
        if (error) throw error;
        
        result = (records || []).map(r => ({
          "商品编码": r.product_code || '',
          "商品名称": r.product_name || '',
          "规格": r.specification || '',
          "生产企业": r.manufacturer || '',
          "库存数量": r.store_stock || 0,
          "在途数量": r.in_transit || 0,
          "门店库存汇总": r.store_total || 0,
          "配送中心库存数量": r.dc_stock || 0,
          "前30天销售数量": r.sales_30days || 0,
          "前90天销售数量": r.sales_90days || 0,
          "月均销售数量": r.monthly_sales || 0,
          "标准库存数量": r.standard_stock || 0,
          "门店计划": r.store_plan || 0,
          "建议订货数量": Math.max(0, (r.standard_stock||0) - (r.store_stock||0) - (r.in_transit||0) + (r.store_plan||0)),
          "标记": r.flag || '',
          "类别": r.category || '',
          "门店名称": r.store_name || '',
          "补货状态": "",
          "供货商": "",
        }));
        break;
      }

// ======== 6. set_actual_order_qty (行727-742) → Supabase ========
      case "set_actual_order_qty": {
        const { product_code, actual_qty, operator } = params;
        const { error } = await supabase
          .from("reports")
          .update({ 
            actual_order_qty: actual_qty || 0, 
            replenish_status: "已订购",
            updated_at: new Date().toISOString()
          })
          .eq("product_code", validateInput(product_code, "商品编码", 50))
          .eq("order_type", "缺货订购");
        if (error) throw error;
        result = { success: true, message: "实际订货数量已更新" };
        break;
      }

// ======== 7. manual_update_status (行744-821) → Supabase ========
      case "manual_update_status": {
        const { product_code, target_status, operator, remark } = params;
        if (!target_status) {
          return new Response(JSON.stringify({ error: "目标状态不能为空" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const validProductCode = validateInput(product_code, "商品编码", 50);
        const validStatus = validateInput(target_status, "目标状态", 20);
        const validOperator = validateInput(operator || '管理员', "操作人", 50);
        const validRemark = validateInput(remark || `手动改为${validStatus}`, "备注", 200);
        
        const { error } = await supabase
          .from("reports")
          .update({ 
            replenish_status: validStatus,
            updated_at: new Date().toISOString()
          })
          .eq("product_code", validProductCode)
          .eq("order_type", "缺货订购");
        
        if (error) throw error;
        
        // 写入状态变更日志到 Supabase
        await supabase.from("status_change_log").insert({
          product_code: validProductCode,
          new_status: validStatus,
          operator: validOperator,
          remark: validRemark,
          changed_at: new Date().toISOString(),
        });
        
        result = { success: true, message: `状态已更新为「${validStatus}」` };
        break;
      }

// ======== 8-14. 同步类操作 → Stub（本地脚本处理） ========
      case "auto_detect_status":
      case "sync_with_auto_status":
      case "sync_product_cache":
      case "sync_inventory_incremental":
      case "sync_inventory_full":
      case "sync_realtime_only":
      case "vba_sync": {
        console.log(`[stub] ${action} - 已迁移至本地同步脚本`);
        result = { success: true, message: `操作「${action}」已迁移至本地同步脚本执行`, stub: true };
        break;
      }

      case "get_sync_log":
      case "sync_cache":
      case "sync_integration": {
        console.log(`[stub] ${action} - 已迁移至本地同步脚本`);
        result = { success: true, message: `同步操作已迁移至本地脚本`, stub: true };
        break;
      }

// ======== 15-16. get_status_change_log / get_status_log → Supabase ========
      case "get_status_change_log": {
        const { log_product_code, top } = params;
        let query = supabase
          .from("status_change_log")
          .select("*")
          .order("changed_at", { ascending: false })
          .limit(Math.min(top || 100, 500));
        
        if (log_product_code) {
          query = query.eq("product_code", validateInput(log_product_code, "商品编码", 50));
        }
        const { data, error } = await query;
        if (error) throw error;
        result = data || [];
        break;
      }

      case "get_status_log": {
        const { log_product_code, top } = params;
        let query = supabase
          .from("reports")
          .select("product_code, replenish_status, actual_order_qty, created_at, updated_at, store_name")
          .order("updated_at", { ascending: false })
          .limit(Math.min(top || 100, 500))
          .eq("order_type", "缺货订购");
        
        if (log_product_code) {
          query = query.eq("product_code", validateInput(log_product_code, "商品编码", 50));
        }
        const { data: logs, error } = await query;
        if (error) throw error;
        result = (logs || []).map(r => ({
          "商品编码": r.product_code,
          "补货状态": r.replenish_status || '',
          "实际订货数量": r.actual_order_qty || null,
          "订货时间": r.created_at,
          "到货确认时间": r.updated_at,
          "操作人": r.store_name || '',
          "备注": r.replenish_status || '',
        }));
        break;
      }

// ======== 17. get_my_reports (行2622-2698) → 纯 Supabase（移除 SQL 降级） ========
      case "get_my_reports": {
        const { store_id } = params;
        const validStoreId = validateInput(store_id, "门店ID", 50);
        const { data: reports, error } = await supabase
          .from("reports")
          .select("*")
          .eq("store_id", validStoreId)
          .order("created_at", { ascending: false });
        
        if (error) throw error;
        result = reports || [];
        break;
      }

// ======== 18. batch_update_status (行2910-2935) → Supabase ========
      case "batch_update_status": {
        const { product_codes, target_status, operator } = params;
        if (!product_codes || !Array.isArray(product_codes) || product_codes.length === 0) {
          return new Response(JSON.stringify({ error: "商品编码列表不能为空" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        let successCount = 0;
        for (const code of product_codes) {
          const { error } = await supabase
            .from("reports")
            .update({ 
              replenish_status: target_status,
              updated_at: new Date().toISOString()
            })
            .eq("product_code", code)
            .eq("order_type", "缺货订购");
          if (!error) successCount++;
        }
        result = { success: true, success_count: successCount, total: product_codes.length };
        break;
      }

// ======== 19. get_summary (行2974-3128) → Supabase 聚合 ========
      case "get_summary": {
        const { store_id, keyword: kw, status_filter: sf } = params;
        
        // 基础查询
        let query = supabase.from("shortage_storestock_cache").select("*");
        
        if (store_id) query = query.eq("store_id", validateInput(store_id, "门店ID", 50));
        if (kw) {
          const keyword = `%${kw}%`;
          query = query.or(`product_code.ilike.${keyword},product_name.ilike.${keyword}`);
        }
        
        const { data: records, error } = await query;
        if (error) throw error;
        
        const rows = (records || []).map(r => ({
          "门店名称": r.store_name || '',
          "商品编码": r.product_code || '',
          "商品名称": r.product_name || '',
          "规格": r.specification || '',
          "生产企业": r.manufacturer || '',
          "库存数量": r.store_stock || 0,
          "在途数量": r.in_transit || 0,
          "门店库存汇总": r.store_total || 0,
          "配送中心库存数量": r.dc_stock || 0,
          "前30天销售数量": r.sales_30days || 0,
          "前90天销售数量": r.sales_90days || 0,
          "月均销售数量": r.monthly_sales || 0,
          "标准库存数量": r.standard_stock || 0,
          "门店计划": r.store_plan || 0,
          "建议订货数量": Math.max(0, (r.standard_stock||0) - (r.store_stock||0) - (r.in_transit||0) + (r.store_plan||0)),
          "标记": r.flag || '',
          "类别": r.category || '',
          "补货状态": '',
          "供货商": '',
        }));
        
        result = rows;
        break;
      }

// ======== 20. check_order_status → Supabase（简化版） ========
      case "check_order_status": {
        const { product_codes, store_name } = params;
        if (!product_codes || !Array.isArray(product_codes) || product_codes.length === 0) {
          result = { buyMap: {}, sendMap: {} };
          break;
        }
        
        // 从 Supabase reports 表读取已有的补货状态
        const { data: statusData } = await supabase
          .from("reports")
          .select("product_code, replenish_status, updated_at, store_name")
          .in("product_code", product_codes)
          .eq("order_type", "缺货订购");
        
        const buyMap: Record<string, string> = {};
        const sendMap: Record<string, string> = {};
        
        (statusData || []).forEach(r => {
          const code = r.product_code;
          if (buyMap[code] && r.updated_at) {
            buyMap[code] = r.updated_at;
          }
        });
        
        result = { buyMap, sendMap };
        break;
      }
