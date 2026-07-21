// Cloudflare Pages Function: 代理下载 GitHub release 安装包
// 用法: /download?version=5.8.1
// 解决用户网络无法访问 objects.githubusercontent.com 的问题

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const version = url.searchParams.get('version') || '5.8.1';

    // GitHub release 资源直链（先尝试官方直链，失败则用 API 拿）
    const directUrl = `https://github.com/wszhyyls/quehuo-tongji/releases/download/v${version}/WSZH-ShortageStore.Setup.${version}.exe`;

    try {
        // 1. 验证文件存在（HEAD 请求，Cloudflare 缓存友好）
        const headResp = await fetch(directUrl, {
            method: 'HEAD',
            cf: { cacheTtl: 300, cacheEverything: true }
        });

        if (!headResp.ok) {
            return new Response(`GitHub release v${version} 不存在或访问失败 (HTTP ${headResp.status})`, {
                status: 404,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }

        // 2. 代理下载（流式传输，不占 Pages Functions 内存）
        const fileResp = await fetch(directUrl, {
            cf: { cacheTtl: 600, cacheEverything: true }
        });

        if (!fileResp.ok) {
            return new Response(`下载 GitHub 文件失败 (HTTP ${fileResp.status})`, {
                status: 502,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }

        // 3. 直接流式返回（CF Pages 限制：响应 100MB 以内，本文件 88MB 可行）
        const newHeaders = new Headers(fileResp.headers);
        newHeaders.set('Content-Disposition', `attachment; filename="WSZH-ShortageStore.Setup.${version}.exe"`);
        newHeaders.set('Cache-Control', 'public, max-age=600');
        newHeaders.set('X-Proxied-From', 'github.com');

        return new Response(fileResp.body, {
            status: 200,
            headers: newHeaders
        });
    } catch (e) {
        return new Response(`代理下载异常: ${e.message}`, {
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
}
