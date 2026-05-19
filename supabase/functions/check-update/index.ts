import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// 最新版本配置（每次发布新版本时更新）
const LATEST_VERSION = '3.18.5';
const UPDATE_URL = 'https://wszhyy.pages.dev/releases/';  // 放在 Cloudflare Pages

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 获取客户端版本
    const { version } = await req.json();
    
    // 比较版本
    const isUpdateAvailable = compareVersions(LATEST_VERSION, version) > 0;

    const response = {
      success: true,
      data: {
        version: LATEST_VERSION,
        updateAvailable: isUpdateAvailable,
        releaseDate: '2026-05-19',
        releaseNotes: `
v3.18.5 更新内容：
- 修复设备授权记录无法保存的问题
- 优化启动动画过渡效果
- 统一版本号显示
        `.trim(),
        downloadUrl: `${UPDATE_URL}WSZH-ShortageStore-3.18.5.exe`,
        forceUpdate: false
      }
    };

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// 版本比较函数
function compareVersions(v1, v2) {
  const v1Parts = v1.split('.').map(Number);
  const v2Parts = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const p1 = v1Parts[i] || 0;
    const p2 = v2Parts[i] || 0;
    
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}
