export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const fileName = url.searchParams.get("f") || url.pathname.replace(/^\//, "");
    if (!fileName) return new Response("?f=filename required", { status: 400 });
    
    const githubUrl = `https://github.com/wszhyyls/quehuo-tongji/releases/download/v5.15.11/${encodeURIComponent(fileName)}`;
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
