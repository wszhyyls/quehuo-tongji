// 紧急回归诊断
const fs = require('fs');

async function fetchWithUA(url, headers={}) {
  const res = await fetch(url, { headers: { ...headers, 'Cache-Control': 'no-cache' } });
  const ct = res.headers.get('content-type');
  const txt = await res.text();
  return { status: res.status, contentType: ct, text: txt };
}

async function main() {
  const NOW = Date.now();
  const PREFIX = 'https://wszhyy.pages.dev';

  console.log('===== 1. sw.js 线上实际内容 =====');
  const sw = await fetchWithUA(PREFIX + '/sw.js?v=' + NOW);
  console.log('status:', sw.status, 'content-type:', sw.contentType, '长度:', sw.text.length);
  console.log(sw.text.substring(0, 300));
  if (sw.text.includes('Service Worker') || sw.text.includes('CACHE_NAME')) {
    const m = sw.text.match(/shortage-tool-v[\d.]+/);
    console.log('CACHE_NAME:', m ? m[0] : '未找到');
  } else {
    console.log('❌ sw.js 不是 Service Worker！');
  }

  console.log('\n===== 2. admin.html 线上内容 =====');
  const html = await fetchWithUA(PREFIX + '/admin.html?v=' + NOW);
  console.log('status:', html.status, 'content-type:', html.contentType, '长度:', html.text.length);
  // 找 SW 注册代码
  const swRegIdx = html.text.indexOf('navigator.serviceWorker');
  if (swRegIdx >= 0) {
    console.log('SW 注册代码:', html.text.substring(swRegIdx, swRegIdx + 300));
  } else {
    console.log('❌ admin.html 里没有 SW 注册！');
  }
  // 检查引用的 admin.js 版本号
  const jsRefs = html.text.matchAll(/static\/js\/[^"'\s>]+/g);
  for (const m of jsRefs) console.log('  JS 引用:', m[0]);

  console.log('\n===== 3. 本地 deploy/sw.js 内容（参考）=====');
  const localSw = fs.readFileSync('G:/Trae项目/缺货统计系统/deploy/static/sw.js', 'utf8');
  console.log('本地长度:', localSw.length);
  console.log('本地前 200:', localSw.substring(0, 200));
  const localCache = localSw.match(/shortage-tool-v[\d.]+/);
  console.log('本地 CACHE_NAME:', localCache ? localCache[0] : '未找到');

  console.log('\n===== 4. _headers 线上生效验证 =====');
  const hRes = await fetch(PREFIX + '/static/js/admin.js?v=' + NOW, { method: 'HEAD', headers: { 'Cache-Control': 'no-cache' } });
  const cc = hRes.headers.get('cache-control');
  console.log('admin.js Cache-Control:', cc);
  console.log('预期: no-cache, must-revalidate → ', cc && cc.includes('no-cache') ? '✅ 生效' : '❌ 没生效');

  console.log('\n===== 5. Edge Function get_summary 真实调用 =====');
  const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI";
  const ef = await fetch('https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': ANON },
    body: JSON.stringify({ action: 'get_summary', params: {} }),
  });
  const efBody = await ef.json();
  console.log('HTTP status:', ef.status);
  console.log('success:', efBody.success, 'error:', efBody.error);
  if (efBody.data) {
    const r = efBody.data.reports || [];
    console.log('reports 条数:', r.length);
    console.log('supplierLookup 键数:', efBody.data.supplierLookup ? Object.keys(efBody.data.supplierLookup).length : '无');
    console.log('warehouseStockMap 键数:', efBody.data.warehouseStockMap ? Object.keys(efBody.data.warehouseStockMap).length : '无');
    console.log('poolRemainingMap 键数:', efBody.data.poolRemainingMap ? Object.keys(efBody.data.poolRemainingMap).length : '无');
  }
}

main().catch(e => console.error('❌ FETCH 失败:', e.message));
