// Cloudflare Pages Function: /gh-release/* → 代理 GitHub Release 下载
// Pages Functions 双括号 [[path]] 语法匹配多段路径，context.params.path 是数组
// GitHub Release 上 asset 文件名用点号：WSZH-ShortageStore.Setup.5.15.15.exe

const GITHUB_REPO = "wszhyyls/quehuo-tongji";
// 兜底版本：正常运行时会先读 releases/latest.yml，仅当读取失败才用这个值
const DEFAULT_VERSION = "5.15.15";

async function getLatestVersion() {
  try {
    const r = await fetch("https://wszhyy.pages.dev/releases/latest.yml", { cf: { cacheTtl: 300 } });
    const text = await r.text();
    const match = text.match(/^version:\s*(\S+)/m);
    if (match) return match[1];
  } catch {}
  return DEFAULT_VERSION;
}

// 把文件名里的 " Setup 5.x.x" 转换成 ".Setup.5.x.x"
function normalizeGithubAssetName(fileName) {
  let n = decodeURIComponent(fileName);
  // "WSZH-ShortageStore Setup 5.15.15.exe" → "WSZH-ShortageStore.Setup.5.15.15.exe"
  if (n.includes(' Setup ')) {
    n = n.replace(' Setup ', '.Setup.');
  } else if (n.includes(' Setup.')) {
    n = n.replace(' Setup.', '.Setup.');
  }
  return n;
}

export async function onRequest(context) {
  const pathArr = context.params.path || [];
  if (pathArr.length === 0) {
    return new Response("Missing filename. Use /gh-release/WSZH-ShortageStore.Setup.5.15.15.exe", { status: 400 });
  }
  const rawFileName = pathArr.join("/");
  const version = await getLatestVersion();

  // 先尝试标准化后的点号文件名
  const githubName = normalizeGithubAssetName(rawFileName);
  const githubUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${githubName}`;

  console.log(`[gh-release] v${version} raw="${rawFileName}" → github="${githubName}"`);

  try {
    const resp = await fetch(githubUrl, { redirect: "follow", cf: { cacheTtl: 3600 * 24 } });
    if (!resp.ok && resp.status === 404 && githubName !== rawFileName) {
      // fallback: 用原始文件名再试一次
      console.log(`[gh-release] dot-name 404, retrying with raw name`);
      const rawUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${encodeURIComponent(rawFileName)}`;
      const rawResp = await fetch(rawUrl, { redirect: "follow", cf: { cacheTtl: 3600 * 24 } });
      if (rawResp.ok) {
        return buildResponse(rawResp, rawFileName);
      }
      return new Response(`GitHub 404: neither "${githubName}" nor "${rawFileName}" found in v${version}`, { status: 404 });
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return new Response(`GitHub ${resp.status}: ${body.slice(0, 300)}`, { status: resp.status });
    }

    return buildResponse(resp, rawFileName);
  } catch (e) {
    console.error(`[gh-release] ${e.message}`);
    return new Response(`Proxy error: ${e.message}`, { status: 502 });
  }
}

function buildResponse(upstreamResp, clientFileName) {
  const headers = new Headers();
  ["Content-Type", "Content-Length", "Accept-Ranges", "Cache-Control"].forEach(h => {
    const v = upstreamResp.headers.get(h);
    if (v) headers.set(h, v);
  });
  headers.set("Content-Disposition", `attachment; filename="${clientFileName}"`);
  return new Response(upstreamResp.body, { status: 200, headers });
}
