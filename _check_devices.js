// === 查 store_authorized_devices 表真实状态 ===
const https = require('https');
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

function edgePost(action, params = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, params });
    const url = new URL('https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data');
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  // 1. 看所有已授权设备
  console.log('=== debug_get_all_authorized ===');
  const r1 = await edgePost('debug_get_all_authorized');
  console.log(JSON.stringify(r1, null, 2).substring(0, 2000));
  
  // 2. 待授权
  console.log('\n=== get_pending_devices ===');
  const r2 = await edgePost('get_pending_devices');
  console.log(JSON.stringify(r2, null, 2).substring(0, 2000));
  
})();
