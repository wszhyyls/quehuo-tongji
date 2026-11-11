// ======================================================================
// 【只读对比】scheduled-task 旧 FIFO vs 新共享 runFIFO
// 同一批真实数据，逐条跑，输出差异清单
// ======================================================================
const EDGE = "https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data";
const SECRET = "wszh_auto_sync_2026";

function toBjDate(utcInput) {
  if (!utcInput) return '';
  const d = typeof utcInput === 'string' ? new Date(utcInput) : utcInput;
  if (isNaN(d.getTime())) return '';
  const bjMs = d.getTime() + 8 * 3600000;
  return new Date(bjMs).toISOString().substring(0, 10);
}

function post(action, params) {
  return fetch(EDGE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-task-secret": SECRET },
    body: JSON.stringify({ action, params })
  }).then(r => r.json());
}

// ===== 旧版 scheduled-task FIFO =====
// 锚点 = UTC 毫秒最早 report
// 采购门槛 = new Date(BillDate).getTime() >= earliestTs（宽松，日期相等也算）
function runOld(reports, purchaseByCode) {
  const results = {}; // id → boolean（true=判定已完成）
  const itemsByCode = {};
  for (const r of reports) {
    if (!itemsByCode[r.product_code]) itemsByCode[r.product_code] = [];
    itemsByCode[r.product_code].push(r);
  }
  for (const code of Object.keys(itemsByCode)) {
    itemsByCode[code].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }
  for (const code of Object.keys(itemsByCode)) {
    const myReports = itemsByCode[code];
    if (myReports.length === 0) continue;
    const earliestTs = new Date(myReports[0].created_at).getTime();
    const purchaseRows = purchaseByCode[code] || [];
    let remaining = 0;
    for (const p of purchaseRows) {
      // p.date 是 Edge Function 格式化后的 YYYY-MM-DD 字符串
      // 但 Edge Function 里 BillDate 是 SQL Server datetime 对象
      // 旧版 scheduled-task 里写的是 new Date(p.date).getTime() —— 如果 p.date 是字符串 "2026-11-07"
      // 会被解析成 UTC 00:00:00，再和 earliestTs（report created_at 的 UTC 毫秒）比较
      const pTs = new Date(p.date_raw || p.date).getTime();
      if (pTs >= earliestTs) remaining += Number(p.qty || 0);
    }
    for (const r of myReports) {
      const demand = Number(r.demand_quantity);
      if (remaining >= demand) {
        results[r.id] = true;
        remaining -= demand;
      } else {
        results[r.id] = false;
        break; // 旧版 break：FIFO 扣光了后面的也不够
      }
    }
    // 旧版 break 后的 reports 保持 undefined → 视为 false
  }
  return results;
}

// ===== 新版共享 FIFO（北京时间 + 严格门槛）=====
function runNew(reports, purchaseByCode) {
  const results = {};
  const itemsByCode = {};
  for (const r of reports) {
    if (!itemsByCode[r.product_code]) itemsByCode[r.product_code] = [];
    itemsByCode[r.product_code].push(r);
  }
  for (const code of Object.keys(itemsByCode)) {
    itemsByCode[code].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }
  for (const code of Object.keys(itemsByCode)) {
    const myReports = itemsByCode[code];
    if (myReports.length === 0) continue;
    const earliestAnchorBj = toBjDate(myReports[0].created_at);
    const purchaseRows = purchaseByCode[code] || [];
    let remaining = 0;
    for (const p of purchaseRows) {
      const pBj = p.date || toBjDate(p.date_raw);
      if (pBj > earliestAnchorBj) remaining += Number(p.qty || 0); // 严格：BillDate 必须严格晚于
    }
    for (const r of myReports) {
      const demand = Number(r.demand_quantity);
      if (remaining >= demand) {
        results[r.id] = true;
        remaining -= demand;
      } else {
        results[r.id] = false;
        break;
      }
    }
  }
  return results;
}

async function main() {
  console.log("======== FIFO 对齐对比（只读）========");

  // 1. 拉 pending reports
  const sumResp = await post("get_summary", {});
  const allReports = sumResp.data?.reports || [];
  const pending = allReports.filter(r =>
    !['已完成', '厂家断货', '已关闭'].includes(r.replenish_status)
    && Number(r.demand_quantity) > 0
    && r.product_code
  );
  console.log(`\npending reports: ${pending.length} 条, 商品数: ${new Set(pending.map(r => r.product_code)).size}`);

  // 2. 拉采购（分批，最多 500 codes/批）
  const codes = [...new Set(pending.map(r => r.product_code))];
  const purchaseByCode = {};
  const BATCH = 500;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    console.log(`拉采购 ${i+1}-${Math.min(i+BATCH, codes.length)}...`);
    const pResp = await post("batch_purchase_check", { codes: batch });
    if (pResp.success && pResp.data?.purchaseByCode) {
      Object.assign(purchaseByCode, pResp.data.purchaseByCode);
    } else {
      console.warn("采购拉取失败:", pResp.error);
    }
  }
  console.log(`\n采购明细已拉: ${Object.keys(purchaseByCode).length} 个商品`);

  // 3. 两套逻辑各跑一次
  const oldResults = runOld(pending, purchaseByCode);
  const newResults = runNew(pending, purchaseByCode);

  // 4. 逐行 diff
  const allIds = [...new Set([...Object.keys(oldResults), ...Object.keys(newResults), ...pending.map(r => r.id)])];
  const diffs = [];
  let oldCompleted = 0, newCompleted = 0, both = 0;

  for (const id of allIds) {
    const oldDone = oldResults[id] === true;
    const newDone = newResults[id] === true;
    if (oldDone) oldCompleted++;
    if (newDone) newCompleted++;
    if (oldDone && newDone) both++;
    if (oldDone !== newDone) {
      const r = pending.find(x => x.id === id);
      diffs.push({
        id,
        product_code: r?.product_code,
        store_name: r?.store_name,
        replenish_status: r?.replenish_status,
        demand_quantity: r?.demand_quantity,
        created_at_bj: toBjDate(r?.created_at),
        earliest_in_code_bj: toBjDate(pending.filter(x => x.product_code === r?.product_code).sort((a,b) => new Date(a.created_at) - new Date(b.created_at))[0]?.created_at),
        old_result: oldDone ? "已完成" : "待处理",
        new_result: newDone ? "已完成" : "待处理",
        anchor_purchase_total_old: calcAnchorPurchaseOld(r?.product_code, pending, purchaseByCode),
        anchor_purchase_total_new: calcAnchorPurchaseNew(r?.product_code, pending, purchaseByCode),
        type: oldDone && !newDone ? "旧版已完成→新版待处理（可能严格锚点生效）"
            : (!oldDone && newDone ? "旧版待处理→新版已完成" : "?")
      });
    }
  }

  // 5. 输出
  console.log(`\n======== 结果汇总 ========`);
  console.log(`旧版完成: ${oldCompleted} 条`);
  console.log(`新版完成: ${newCompleted} 条`);
  console.log(`两边一致完成: ${both} 条`);
  console.log(`差异: ${diffs.length} 条`);

  if (diffs.length > 0) {
    console.log(`\n======== 差异清单 ========`);
    for (const d of diffs) {
      console.log(`\n--- id=${d.id} (商品=${d.product_code}, 门店=${d.store_name}, 需求=${d.demand_quantity}, 当前状态=${d.replenish_status}) ---`);
      console.log(`  最早锚点北京时间: ${d.earliest_in_code_bj}`);
      console.log(`  旧版可用采购总量: ${d.anchor_purchase_total_old}  新版可用采购总量: ${d.anchor_purchase_total_new}`);
      console.log(`  旧版判定: ${d.old_result}  新版判定: ${d.new_result}`);
      console.log(`  差异类型: ${d.type}`);
    }
  } else {
    console.log("\n🎉 两套逻辑判定结果完全一致！可以安全合并。");
  }

  // 6. 统计各商品的采购总量 + 锚点后采购量（用于理解差异来源）
  console.log(`\n======== 采购门槛差异来源（按商品）========`);
  const perCode = {};
  for (const code of codes) {
    const myReports = pending.filter(r => r.product_code === code).sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
    if (myReports.length === 0) continue;
    const earliestBj = toBjDate(myReports[0].created_at);
    const earliestTs = new Date(myReports[0].created_at).getTime();
    const rows = purchaseByCode[code] || [];
    let total = 0, countOld = 0, countNew = 0, oldPool = 0, newPool = 0;
    for (const p of rows) {
      total += Number(p.qty || 0);
      const pTs = new Date(p.date_raw || p.date).getTime();
      const pBj = p.date || toBjDate(p.date_raw);
      const oldOk = pTs >= earliestTs;
      const newOk = pBj > earliestBj;
      if (oldOk) { oldPool += Number(p.qty || 0); countOld++; }
      if (newOk) { newPool += Number(p.qty || 0); countNew++; }
    }
    const demand = myReports.reduce((s, r) => s + Number(r.demand_quantity), 0);
    if (oldPool !== newPool) {
      console.log(`\n商品 ${code}:`);
      console.log(`  最早锚点北京: ${earliestBj}  总采购: ${total}`);
      console.log(`  旧版池: ${oldPool} (${countOld} 条, UTC>=)  新版池: ${newPool} (${countNew} 条, BJ>)`);
      console.log(`  总需求: ${demand}  旧版能完成: ${oldPool >= demand}  新版能完成: ${newPool >= demand}`);
      // 列出每条采购的日期对比
      for (const p of rows) {
        const pTs = new Date(p.date_raw || p.date).getTime();
        const pBj = p.date || toBjDate(p.date_raw);
        const oldOk = pTs >= earliestTs;
        const newOk = pBj > earliestBj;
        if (oldOk !== newOk) {
          console.log(`  ← 差异行: date_raw=${p.date_raw}, Bj=${pBj}, oldOk=${oldOk}, newOk=${newOk}, qty=${p.qty}`);
        }
      }
    }
  }
}

function calcAnchorPurchaseOld(code, pending, purchaseByCode) {
  const myReports = pending.filter(r => r.product_code === code).sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  if (myReports.length === 0) return 0;
  const earliestTs = new Date(myReports[0].created_at).getTime();
  let pool = 0;
  for (const p of purchaseByCode[code] || []) {
    if (new Date(p.date_raw || p.date).getTime() >= earliestTs) pool += Number(p.qty || 0);
  }
  return pool;
}
function calcAnchorPurchaseNew(code, pending, purchaseByCode) {
  const myReports = pending.filter(r => r.product_code === code).sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  if (myReports.length === 0) return 0;
  const earliestBj = toBjDate(myReports[0].created_at);
  let pool = 0;
  for (const p of purchaseByCode[code] || []) {
    const pBj = p.date || toBjDate(p.date_raw);
    if (pBj > earliestBj) pool += Number(p.qty || 0);
  }
  return pool;
}

main().catch(e => console.error("对比失败:", e));
