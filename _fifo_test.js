const https = require('https');
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

function edgePost(action, params = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, params });
    const url = new URL('https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/scheduled-task');
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
  // run_detect_only 是 public action
  console.log('=== run_detect_only (public, 不写 DB) ===');
  const r = await edgePost('run_detect_only');
  console.log('success:', r.success);
  const d = r.data || r;
  console.log('auto_completed (FIFO判定可完成的report数):', d.auto_completed);
  console.log('details:');
  (d.details || []).forEach(x => console.log(' ', x));
  
  // 也看 health
  console.log('\n=== health ===');
  const h = await edgePost('health');
  console.log(h);
})();
