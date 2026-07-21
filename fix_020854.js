const https = require('https');
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODcyNzQ2MSwiZXhwIjoyMDk0MzAzNDYxfQ.gkgIKEqBXtUMz9op1Q9nUnvIZVA4KOsdycQoAAigE4U';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'qswpgnnedqvuegwfbprd.supabase.co', port: 443, path: encodeURI(path), method, headers: { 'Authorization':'Bearer '+key, 'apikey':key, 'Prefer':'return=representation' } };
    if (body) { opts.headers['Content-Type']='application/json'; opts.headers['Content-Length']=Buffer.byteLength(body); }
    const r = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(d)})}catch(e){resolve({status:res.statusCode,data:d})}}); });
    if (body) r.write(body); r.end();
  });
}

async function main() {
  // Delete duplicate id=524 (newer duplicate), keep id=331
  console.log('=== Delete duplicate id=524 ===');
  let r = await req('DELETE', '/rest/v1/reports?id=eq.524');
  console.log('Status:', r.status, JSON.stringify(r.data).substring(0, 200));

  // Mark id=331 as 待处理 so next sync re-evaluates correctly
  console.log('\n=== Mark id=331 as 待处理 ===');
  r = await req('PATCH', '/rest/v1/reports?id=eq.331',
    JSON.stringify({ replenish_status:'待处理', status_changed_at:new Date().toISOString(), status_changed_by:'修正', status_remark:'已删除重复上报，下一次同步会基于transit=4>=demand=3判定为已完成' }));
  console.log('Status:', r.status, JSON.stringify(r.data).substring(0, 200));
}
main().catch(console.error);
