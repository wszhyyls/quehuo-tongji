// 用 Edge Function 已有的 debug_check_code 对 030231 跑一遍确认
// 然后直接从 Supabase REST 拉 autoDone + pending 全部
const https = require('https');

const SB_HOST = 'qswpgnnedqvuegwfbprd.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjA4MjY1ODQsImV4cCI6MjAzNjQwMjU4NH0.NOPE';

function sbGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SB_HOST, path, method: 'GET',
      headers: {
        'apikey': ANON_KEY,
        'Authorization': 'Bearer ' + ANON_KEY,
        'Range': '0-999'
      }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function callFunction(action, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ action, ...body });
    const req = https.request({
      hostname: SB_HOST, path: '/functions/v1/scheduled-task', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-task-secret': 'wszh_auto_sync_2026'
      }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 500)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('=== list_auto_done（FIFO 验证误关）===');
  try {
    const r = await callFunction('list_auto_done');
    console.log('summary:', JSON.stringify(r.summary, null, 2));
    console.log('\n--- 误关报告（FIFO 判定应保持待处理但被自动关了）---');
    if (!r.false_positives || r.false_positives.length === 0) {
      console.log('✅ 没有误关！所有自动判定完成的都符合 FIFO 逻辑');
    } else {
      console.log(`⚠️ 发现 ${r.false_positives.length} 条误关：`);
      r.false_positives.forEach(r => console.log(`  id=${r.id} ${r.product_code} ${r.store_name} 需求${r.demand} 上报${r.created_at}`));
    }
    console.log('\n--- FIFO 正确的自动完成（前20条）---');
    (r.correct_auto_done || []).slice(0, 20).forEach(r => console.log(`  ✅ id=${r.id} ${r.product_code} ${r.store_name} 需求${r.demand} 上报${r.created_at}`));
  } catch (e) {
    console.log('FAIL:', e.message);
  }
})();
