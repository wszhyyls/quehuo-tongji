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

const newDoneCodes = ['1020414', '1020448', '2100250', '0189'];
const reportIds = [1338, 1579, 1771, 1709];

async function main() {
  const pcResp = await post('batch_purchase_check', { codes: newDoneCodes });
  const pc = pcResp.data.purchaseByCode;

  const sum = await post('get_summary', {});
  const allReports = sum.data.reports || [];

  // 对每个新增完成的 report，找到同商品的所有 pending reports（按 created_at 升序）
  for (const targetId of reportIds) {
    const target = allReports.find(r => r.id === targetId);
    if (!target) { console.log(`❌ report ${targetId} 未找到`); continue; }
    const code = target.product_code;
    const myReports = allReports
      .filter(r => r.product_code === code && !['已完成','厂家断货','已关闭'].includes(r.replenish_status) && Number(r.demand_quantity) > 0)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    const earliestAnchorBj = toBjDate(myReports[0].created_at);
    console.log(`\n===== report ${targetId} | 商品 ${code} | 门店 ${target.store_name} =====`);
    console.log(`  需求: ${target.demand_quantity}`);
    console.log(`  上报日(UTC): ${target.created_at}`);
    console.log(`  北京时间锚点: ${earliestAnchorBj}`);
    console.log(`  同商品 pending 队列（按时间升序）:`);
    myReports.forEach((r, i) => {
      console.log(`    [${i+1}] id=${r.id} 门店=${r.store_name} 需求=${r.demand_quantity} 上报=${toBjDate(r.created_at)}`);
    });

    const purchases = pc[code] || [];
    console.log(`\n  该商品全部采购入库（${purchases.length} 条）:`);
    let strictPool = 0, loosePool = 0;
    for (const p of purchases) {
      const pBj = p.date || toBjDate(p.date_raw);
      const qty = Number(p.qty || 0);
      const strictCount = pBj > earliestAnchorBj ? qty : 0;
      const looseCount = pBj >= earliestAnchorBj ? qty : 0;
      const isSameDay = pBj === earliestAnchorBj;
      if (strictCount || looseCount || isSameDay) {
        console.log(`    BillDate=${pBj} (原始:${p.date_raw?.slice(0,19) || '?'}), qty=${qty} ${isSameDay ? '⚠️ 当天入库!' : ''} | 严格计入=${strictCount}, 宽松计入=${looseCount}`);
      }
      strictPool += strictCount;
      loosePool += looseCount;
    }
    console.log(`\n  严格口径池(>锚点): ${strictPool}, 宽松口径池(>=锚点): ${loosePool}`);
    console.log(`  差值: ${loosePool - strictPool}（都是锚点当天入库的）`);

    // FIFO 逐条扣减，看 target 在第几条被满足
    let remainingStrict = strictPool;
    let remainingLoose = loosePool;
    console.log(`\n  FIFO 逐条扣减（宽松口径）:`);
    for (const r of myReports) {
      const d = Number(r.demand_quantity);
      if (remainingLoose >= d) {
        const marker = r.id === targetId ? ' ⬅️ 这一条！' : '';
        console.log(`    消耗 ${r.id} 门店=${r.store_name} 需求=${d} → 满足${marker}`);
        remainingLoose -= d;
      } else {
        console.log(`    ${r.id} 不够（剩 ${remainingLoose} < ${d}）`);
        break;
      }
    }
    console.log(`  扣减后剩余: ${remainingLoose}`);
  }
}
main().catch(e => console.error('ERR:', e.message));
