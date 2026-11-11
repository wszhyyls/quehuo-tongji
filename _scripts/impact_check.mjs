const EDGE = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data';
const SECRET = 'wszh_auto_sync_2026';

async function post(action, params) {
  const r = await fetch(EDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-task-secret': SECRET },
    body: JSON.stringify({ action, params })
  });
  return r.json();
}

function toBjDate(s) {
  if (!s) return '';
  const d = typeof s === 'string' ? new Date(s) : s;
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 8 * 3600000).toISOString().substring(0, 10);
}

function runStrict(reports, purchaseByCode) {
  const done = new Set();
  const itemsByCode = {};
  for (const r of reports) {
    if (!itemsByCode[r.product_code]) itemsByCode[r.product_code] = [];
    itemsByCode[r.product_code].push(r);
  }
  for (const code of Object.keys(itemsByCode)) {
    itemsByCode[code].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const ms = itemsByCode[code];
    if (ms.length === 0) continue;
    const anchorBj = toBjDate(ms[0].created_at);
    let pool = 0;
    for (const p of (purchaseByCode[code] || [])) {
      const pBj = p.date || toBjDate(p.date_raw);
      if (pBj > anchorBj) pool += Number(p.qty || 0); // 严格
    }
    for (const r of ms) {
      if (pool >= Number(r.demand_quantity)) { done.add(r.id); pool -= Number(r.demand_quantity); } else break;
    }
  }
  return done;
}

function runLoose(reports, purchaseByCode) {
  const done = new Set();
  const itemsByCode = {};
  for (const r of reports) {
    if (!itemsByCode[r.product_code]) itemsByCode[r.product_code] = [];
    itemsByCode[r.product_code].push(r);
  }
  for (const code of Object.keys(itemsByCode)) {
    itemsByCode[code].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const ms = itemsByCode[code];
    if (ms.length === 0) continue;
    const anchorBj = toBjDate(ms[0].created_at);
    let pool = 0;
    for (const p of (purchaseByCode[code] || [])) {
      const pBj = p.date || toBjDate(p.date_raw);
      if (pBj >= anchorBj) pool += Number(p.qty || 0); // 宽松（当天入库算）
    }
    for (const r of ms) {
      if (pool >= Number(r.demand_quantity)) { done.add(r.id); pool -= Number(r.demand_quantity); } else break;
    }
  }
  return done;
}

async function main() {
  const sum = await post('get_summary', {});
  const pending = (sum.data?.reports || []).filter(r =>
    !['已完成', '厂家断货', '已关闭'].includes(r.replenish_status)
    && Number(r.demand_quantity) > 0 && r.product_code
  );
  console.log('pending:', pending.length);

  const codes = [...new Set(pending.map(r => r.product_code))];
  const pcResp = await post('batch_purchase_check', { codes });
  const pc = pcResp.data.purchaseByCode;

  const strict = runStrict(pending, pc);
  const loose = runLoose(pending, pc);

  const newDones = [];
  for (const id of loose) {
    if (!strict.has(id)) {
      const r = pending.find(x => x.id === id);
      newDones.push(r);
    }
  }

  console.log('严格版完成:', strict.size, '条');
  console.log('宽松版完成:', loose.size, '条');
  console.log('放开锚点新增:', newDones.length, '条\n');

  const byCode = {};
  for (const r of newDones) {
    const c = r.product_code;
    if (!byCode[c]) byCode[c] = { count: 0, stores: new Set(), demand: 0 };
    byCode[c].count++;
    byCode[c].stores.add(r.store_name || '?');
    byCode[c].demand += Number(r.demand_quantity || 0);
  }
  const sorted = Object.entries(byCode).sort((a, b) => b[1].count - a[1].count);
  console.log('=== 放开锚点新增完成（按商品 top 20）===');
  for (let i = 0; i < Math.min(20, sorted.length); i++) {
    const [code, info] = sorted[i];
    console.log(code + ': ' + info.count + ' 条, 需求=' + info.demand + ', 门店=[' + [...info.stores].join(',') + ']');
  }
  if (sorted.length > 20) console.log('... 还有 ' + (sorted.length - 20) + ' 个商品');

  const byStore = {};
  for (const r of newDones) {
    const s = r.store_name || '未知';
    if (!byStore[s]) byStore[s] = 0;
    byStore[s]++;
  }
  console.log('\n=== 按门店分布 ===');
  Object.entries(byStore).sort((a, b) => b[1] - a[1]).forEach(([s, c]) => console.log(s + ': ' + c + ' 条'));

  // 列单据详情
  console.log('\n=== 单据详情前 30 条 ===');
  for (let i = 0; i < Math.min(30, newDones.length); i++) {
    const r = newDones[i];
    console.log(r.id + ' | ' + r.product_code + ' | ' + r.store_name + ' | 需求=' + r.demand_quantity + ' | ' + r.replenish_status + ' | ' + r.created_at);
  }
}
main().catch(e => console.error('ERR:', e.message));
