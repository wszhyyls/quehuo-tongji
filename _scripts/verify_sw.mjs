const ts = Date.now();
const ed = 'https://wszhyy.pages.dev';
(async () => {
  const sw = await fetch(`${ed}/static/sw.js?t=${ts}`).then(r => r.text());
  const resp = await fetch(`${ed}/static/sw.js?t=${ts}`);
  console.log('CACHE_NAME:', sw.match(/CACHE_NAME = '([^']+)'/)?.[1]);
  console.log('sw.js headers:');
  for (const [k, v] of resp.headers.entries()) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('\n✅ 部署验证完毕');
})();
