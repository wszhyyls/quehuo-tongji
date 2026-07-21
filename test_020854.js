const https = require('https');
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODcyNzQ2MSwiZXhwIjoyMDk0MzAzNDYxfQ.gkgIKEqBXtUMz9op1Q9nUnvIZVA4KOsdycQoAAigE4U';

function restGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'qswpgnnedqvuegwfbprd.supabase.co', port: 443,
      path: path, method: 'GET',
      headers: { 'Authorization':'Bearer '+key, 'apikey':key }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch(e){resolve(d)}}); });
    req.end();
  });
}

async function main() {
  // Use URL-encoded product code
  let r = await restGet('/rest/v1/reports?select=id,product_code,store_id,store_name,demand_quantity,current_stock,in_transit,replenish_status,status_changed_at&product_code=eq.020854&order_type=eq.%E7%BC%BA%E8%B4%A7%E8%AE%A2%E8%B4%AD&order=created_at.asc');
  console.log('=== 020854 reports ===');
  if (Array.isArray(r)) {
    r.forEach(row => console.log(`  id=${row.id} ${row.store_name} demand=${row.demand_quantity} stock=${row.current_stock} transit=${row.in_transit} status=${row.replenish_status} changed=${row.status_changed_at}`));
  } else {
    console.log(JSON.stringify(r, null, 2).substring(0, 1000));
  }
}
main().catch(console.error);
