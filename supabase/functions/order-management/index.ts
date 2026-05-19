
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { action, params } = await req.json();

    let result;
    switch (action) {
      case "create_order": {
        const { store_id, store_name, product_code, product_name, order_type, quantity, notes } = params;
        const { data, error } = await supabase
          .from("shortage_orders")
          .insert({
            store_id,
            store_name,
            product_code,
            product_name,
            order_type,
            quantity,
            notes,
            status: "pending"
          })
          .select();
        
        if (error) throw error;
        result = data[0];
        break;
      }

      case "list_orders": {
        const { store_id, limit = 50 } = params;
        const query = supabase
          .from("shortage_orders")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        
        if (store_id) {
          query.eq("store_id", store_id);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        result = data;
        break;
      }

      case "get_stats": {
        const { store_id } = params;
        
        const query = supabase
          .from("shortage_orders")
          .select("status", { count: "exact" })
          .eq("store_id", store_id);
        
        const { count, error } = await query;
        if (error) throw error;
        
        const pendingCount = await supabase
          .from("shortage_orders")
          .select("*", { count: "exact" })
          .eq("store_id", store_id)
          .eq("status", "pending");
        
        result = {
          total: count,
          pending: pendingCount.count || 0
        };
        break;
      }

      case "update_order": {
        const { id, status } = params;
        const { data, error } = await supabase
          .from("shortage_orders")
          .update({ status })
          .eq("id", id)
          .select();
        
        if (error) throw error;
        result = data[0];
        break;
      }

      default:
        return new Response(JSON.stringify({ error: "无效的操作" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify({ success: true, data: result }), {
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
