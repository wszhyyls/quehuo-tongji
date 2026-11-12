// Supabase Edge Function: /functions/v1/gh-proxy
// 支持两种格式：
//   /functions/v1/gh-proxy?f=Setup.exe                     (query param)
//   /functions/v1/gh-proxy/Setup.exe                       (路径 param - electron-updater 用)
// 还自动兼容 electron-updater generic provider 可能构造的奇怪路径：
//   /functions/v1/gh-proxy.blockmap?f=Setup.exe           (blockmap URL 替换错误)
//   /functions/v1/gh-proxy.blockmap/Setup.exe             (同上)
import "@supabase/functions-js/edge-runtime.d.ts";
import { getLatestVersion } from "../_shared/version.ts";

const GITHUB_REPO = "wszhyyls/quehuo-tongji";

function toDotName(fileName: string): string {
  return fileName.replace(/ Setup /g, ".Setup.");
}

function stripBlockmapSuffix(name: string): string {
  // electron-updater 可能把 URL 路径里加 .blockmap，或者在文件名后加 .blockmap
  // 我们需要从任意地方提取出真实文件名
  return name.replace(/\.blockmap$/i, "");
}

// 从请求 URL 里提取真实文件名（兼容各种奇怪的 URL 格式）
function extractFileName(url: URL): string {
  // 1. 优先用 query param
  const fParam = url.searchParams.get("f");
  if (fParam) return decodeURIComponent(fParam);

  // 2. 从路径里提取最后一段作为文件名
  // 路径可能是 /gh-proxy/Setup.exe 或 /gh-proxy/Setup.exe.blockmap
  // 不管是什么后缀，保留完整文件名（包括 .blockmap）
  const pathname = url.pathname;
  const segments = pathname.split("/").filter(s => s.length > 0);
  const lastSeg = segments[segments.length - 1];
  if (lastSeg) {
    return decodeURIComponent(lastSeg);
  }
  return "";
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const fileName = extractFileName(url);
    if (!fileName) {
      return new Response("Missing filename. Use ?f=Setup.exe or /gh-proxy/Setup.exe", { status: 400 });
    }

    // ?v=5.15.10 可覆盖版本（用于下载历史版本）
    const verOverride = url.searchParams.get("v");
    const version = verOverride || (await getLatestVersion());
    const dotName = toDotName(fileName);
    const githubUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${dotName}`;

    console.log(`[gh-proxy] v${version} "${fileName}" → "${dotName}"`);

    try {
      const headers: Record<string, string> = {};
      const range = req.headers.get("range");
      if (range) headers["Range"] = range;

      const resp = await fetch(githubUrl, { redirect: "follow", headers });

      if (!resp.ok) {
        if (resp.status === 404 && dotName !== fileName) {
          const altUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${encodeURIComponent(fileName)}`;
          const altResp = await fetch(altUrl, { redirect: "follow", headers });
          if (altResp.ok) return buildResponse(altResp, fileName);
        }
        const body = await resp.text().catch(() => "");
        return new Response(`GitHub ${resp.status}: ${body.slice(0, 200)}`, { status: resp.status });
      }

      return buildResponse(resp, fileName);
    } catch (e) {
      console.error(`[gh-proxy] ${(e as Error).message}`);
      return new Response(`Proxy error: ${(e as Error).message}`, { status: 502 });
    }
  },
};

function buildResponse(upstream: Response, clientName: string): Response {
  const headers = new Headers();
  const copyList = ["Content-Type", "Content-Length", "Accept-Ranges", "Cache-Control"];
  copyList.forEach((h) => {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  });
  const cd = upstream.headers.get("Content-Disposition");
  if (cd) {
    headers.set("Content-Disposition", cd);
  } else {
    headers.set("Content-Disposition", `attachment; filename="${clientName}"`);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
