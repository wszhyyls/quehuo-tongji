import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// 本地声明的最新版本（如果 GitHub API 失败时兜底）
const FALLBACK_VERSION = '5.8.1';
const GITHUB_REPO = 'wszhyyls/quehuo-tongji';
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
// Cloudflare Pages Function 代理下载（用户网络访问不到 objects.githubusercontent.com 时使用）
const CF_PROXY_BASE = 'https://wszhyy.pages.dev';

// 内存缓存：1 小时过期（避免 GitHub API 速率限制 60次/小时）
interface GhRelease { version: string; downloadUrl: string; fileName: string; }
let ghCache: { data: GhRelease | null; ts: number } = { data: null, ts: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getGitHubLatestRelease(): Promise<GhRelease | null> {
  // 命中缓存
  if (ghCache.data && (Date.now() - ghCache.ts) < CACHE_TTL_MS) {
    return ghCache.data;
  }
  try {
    const resp = await fetch(GITHUB_API_LATEST, {
      headers: {
        'User-Agent': 'wszh-check-update',
        'Accept': 'application/vnd.github+json'
      }
    });
    if (!resp.ok) {
      console.warn('[check-update] GitHub API 失败:', resp.status);
      return ghCache.data || null;
    }
    const data = await resp.json();
    const tag = (data.tag_name || '').replace(/^v/, '');
    if (!tag) return ghCache.data || null;
    // 找 .exe 资源（排除 .blockmap）
    const exeAsset = (data.assets || []).find((a: any) =>
      a && a.name && /\.exe$/i.test(a.name) && !/\.blockmap$/i.test(a.name)
    );
    if (!exeAsset || !exeAsset.browser_download_url) {
      console.warn('[check-update] 未找到 .exe 资源');
      return ghCache.data || null;
    }
    const result: GhRelease = {
      version: tag,
      downloadUrl: exeAsset.browser_download_url,
      fileName: exeAsset.name
    };
    ghCache = { data: result, ts: Date.now() };
    return result;
  } catch (e) {
    console.warn('[check-update] GitHub API 异常:', e);
    return ghCache.data || null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 获取客户端版本
    const { version } = await req.json();

    // 1) 优先从 GitHub API 拿真实最新版本 + 直链
    const ghRelease = await getGitHubLatestRelease();
    const actualVersion = ghRelease?.version || FALLBACK_VERSION;
    // GitHub 原始直链（用户网络好的话直连下载）
    const githubDirectUrl = ghRelease?.downloadUrl ||
      `https://github.com/${GITHUB_REPO}/releases/download/v${FALLBACK_VERSION}/WSZH-ShortageStore.Setup.${FALLBACK_VERSION}.exe`;
    // Cloudflare Pages 代理下载（绕开 GitHub CDN 阻断：服务端从 GitHub 拿，客户端从 CF 拿）
    const cfProxyUrl = `${CF_PROXY_BASE}/download?version=${actualVersion}`;
    // 实际给用户的链接：优先用 CF 代理（兼容性更好）
    const directDownloadUrl = cfProxyUrl;
    const updateFilesUrl = `${CF_PROXY_BASE}/download?version=${actualVersion}`;

    // 2) 比较版本
    const isUpdateAvailable = compareVersions(actualVersion, version) > 0;

    const response = {
      success: true,
      data: {
        version: actualVersion,
        updateAvailable: isUpdateAvailable,
        releaseDate: '2026-07-17',
        updateFilesUrl: updateFilesUrl,  // electron-updater 从此 URL 读取 latest.yml
        releaseNotes: `
v${actualVersion}（自动从 GitHub API 同步）
- 点击下方"下载地址1"或"下载地址2"直接下载安装包
- 系统会自动检测最新版本，无需跳页
        `.trim(),
        // 主下载：Cloudflare Pages Function 代理（用户网络访问 GitHub CDN 不稳定也能下）
        downloadUrl: directDownloadUrl,
        // 备用下载：GitHub 原始直链（如果 CF 代理失败可用）
        downloadUrl2: githubDirectUrl,
        // 备用下载 3：GitHub release 页面（最稳定，永远可用）
        downloadUrl3: `https://github.com/${GITHUB_REPO}/releases/tag/v${actualVersion}`,
        fileName: ghRelease?.fileName || `WSZH-ShortageStore.Setup.${actualVersion}.exe`,
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
function compareVersions(v1: string, v2: string) {
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
