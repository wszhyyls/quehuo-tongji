import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// 最新版本配置（每次发布新版本时更新）
const LATEST_VERSION = '3.19.0';
const UPDATE_URL = 'https://github.com/wszhyyls/quehuo-tongji/releases/download/v3.19.0/';  // GitHub Releases

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
        releaseDate: '2026-05-23',
        updateFilesUrl: UPDATE_URL,  // electron-updater 从此 URL 读取 latest.yml
        releaseNotes: `
v3.19.0 更新内容：
- 新增供货商字段（缺货订购汇总）
- 状态变更日志系统（可追溯每次修改）
- 历史上报新增规格、商品编码列
- 双表格斑马纹隔行变色+悬停加深
- 品名列间距优化，表格更紧凑
- 需求明细弹窗商品信息蓝色高亮
- 悬停信息范围扩展至整行
- 操作日志翻页（每页10条）
- 退出客户端确认提示
        `.trim(),
        downloadUrl: `https://github.com/wszhyyls/quehuo-tongji/releases/latest`,
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
