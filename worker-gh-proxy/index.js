// 兜底版本：正常运行时会先读 releases/latest.yml，仅当读取失败才用这个值
const FALLBACK_VERSION = "5.15.14";

async function getLatestVersion() {
  try {
    const r = await fetch("https://wszhyy.pages.dev/releases/latest.yml", { cf: { cacheTtl: 300 } });
    if (!r.ok) return FALLBACK_VERSION;
    const text = await r.text();
    const m = text.match(/^version:\s*['"]?(\S+?)['"]?\s*$/m);
    if (m && m[1]) return m[1];
  } catch {}
  return FALLBACK_VERSION;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const fileName = url.searchParams.get("f") || url.pathname.replace(/^\//, "");
    if (!fileName) return new Response("?f=filename required", { status: 400 });

    const version = url.searchParams.get("v") || (await getLatestVersion());
    const githubUrl = `https://github.com/wszhyyls/quehuo-tongji/releases/download/v${version}/${encodeURIComponent(fileName)}`;
    console.log(`Proxying: ${githubUrl}`);

    try {
      const resp = await fetch(githubUrl, { redirect: "follow" });
      if (!resp.ok) return new Response(`GitHub ${resp.status}`, { status: resp.status });

      const headers = new Headers();
      ["Content-Type","Content-Length"].forEach(h => { const v = resp.headers.get(h); if(v) headers.set(h,v); });
      headers.set("Content-Disposition", `attachment; filename="${fileName}"`);
      headers.set("Cache-Control", "public, max-age=3600");

      return new Response(resp.body, { status: 200, headers });
    } catch(e) {
      return new Response(`Error: ${e.message}`, { status: 502 });
    }
  }
};
