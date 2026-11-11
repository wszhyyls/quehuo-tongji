import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CF_BASE = 'https://wszhyy.pages.dev';
const RELEASES_DIR = `${CF_BASE}/releases/`;          // latest.yml + .blockmap 在这里
const GITHUB_REPO = 'wszhyyls/quehuo-tongji';
const GITHUB_RELEASES_BASE = `https://github.com/${GITHUB_REPO}/releases/download`;
const FALLBACK_VERSION = '5.11.1';

// 内存缓存（1 小时）
let cache: { version: string; fileName: string; ts: number } | null = null;
const TTL = 60 * 60 * 1000;

/** 从 Cloudflare Pages 的 releases/latest.yml 读取最新版本（最权威，部署时同步） */
async function fetchLatest(): Promise<{ version: string; ghUrl: string; fileName: string } | null> {
  if (cache && (Date.now() - cache.ts) < TTL) return cache;
  try {
    const resp = await fetch(`${RELEASES_DIR}latest.yml`, { headers: { 'User-Agent': 'wszh-check-update' } });
    if (!resp.ok) return null;
    const text = await resp.text();
    const vMatch = text.match(/^version:\s*['"]?(\S+)['"]?\s*$/m);
    // 匹配顶层 url: 或数组内的 "- url:" （latest.yml 的 files 数组格式）
    const urlMatch = text.match(/^[\s-]*url:\s*['"]?(https?:\/\/\S+?)['"]?\s*$/m);
    if (!vMatch) return null;
    // 优先从 latest.yml 解析 url（永远最准，跟着部署走），fallback 到 gh-proxy 直拼
    const ghUrl = urlMatch ? urlMatch[1] : `${GITHUB_RELEASES_BASE}/v${vMatch[1]}/WSZH-ShortageStore.Setup.${vMatch[1]}.exe`;
    // 文件名：如果 URL 里有 %20（空格编码），解码后取最后一段
    let fileName = ghUrl.split('/').pop() || `WSZH-ShortageStore.Setup.${vMatch[1]}.exe`;
    if (fileName.includes('%')) fileName = decodeURIComponent(fileName);
    cache = { version: vMatch[1], fileName, ts: Date.now() };
    // 存 ghUrl 到临时字段供下方使用
    (cache as any).ghUrl = ghUrl;
    return cache;
  } catch { return null; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const { version } = await req.json();

    const info = await fetchLatest();
    const actualVersion = info?.version || FALLBACK_VERSION;
    const fileName = info?.fileName || `WSZH-ShortageStore.Setup.${actualVersion}.exe`;
    const ghUrl = (info as any)?.ghUrl || `${GITHUB_RELEASES_BASE}/v${actualVersion}/${fileName}`;
    const ghTag = `v${actualVersion}`;

    // electron-updater 从此目录读 latest.yml（我们部署时带过去）
    const updateFilesUrl = RELEASES_DIR;
    // exe 实际下载源：GitHub Releases（单文件 2GB 上限，稳定）
    const ghReleasePage = `https://github.com/${GITHUB_REPO}/releases/tag/${ghTag}`;

    const isUpdateAvailable = compareVersions(actualVersion, version) > 0;

    const response = {
      success: true,
      data: {
        version: actualVersion,
        updateAvailable: isUpdateAvailable,
        releaseDate: '2026-11-09',
        updateFilesUrl,
        releaseNotes: `v${actualVersion}\n- 启动后自动静默下载，下次重启安装`,
        downloadUrl: ghUrl,           // 主手动下载（从 latest.yml 解析，永远正确）
        downloadUrl2: ghUrl,         // 备 2
        downloadUrl3: ghReleasePage, // GitHub Release 页面
        fileName,
        forceUpdate: false
      }
    };
    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
