// ======================================================================
// FIFO 采购入库自动判定 —— 共享模块
// scheduled-task（每天凌晨）和 query-shortage-data（一键同步/行级判定）
// 都 import 这份代码，保证判定结果完全一致
// ======================================================================

export interface FifoReport {
  id: string;
  product_code: string;
  demand_quantity: number;
  created_at: string; // UTC ISO 8601
  replenish_status?: string;
  [key: string]: any;
}

export interface FifoPurchaseRow {
  date: string; // 可能是 Date 对象也可能是字符串，SQL Server BillDate
  qty: number;
}

// ========== 北京时间转换（与前端 admin.js 的 toBjDate 保持一致）==========
export function toBjDate(utcInput: any): string {
  if (!utcInput) return '';
  const d = typeof utcInput === 'string' ? new Date(utcInput) : utcInput;
  if (isNaN(d.getTime())) return '';
  const bjMs = d.getTime() + 8 * 3600000;
  return new Date(bjMs).toISOString().substring(0, 10);
}

// ========== 唯一锚点门槛判定（可配置 sameDayCounts）==========
// 采购入库 BillDate（北京时间 YYYY-MM-DD）是否计入 FIFO 采购池
// 【2026-11-08 放开锚点】默认宽松口径：BillDate >= anchorDateBj（当天入库算当天报的缺）
// 如后续需恢复严格 → 改 sameDayCounts 默认值为 false
export function isPurchaseEligible(
  billDateBj: string,
  anchorDateBj: string,
  sameDayCounts: boolean = true
): boolean {
  if (!billDateBj || !anchorDateBj) return false;
  if (sameDayCounts) {
    return billDateBj >= anchorDateBj;   // 宽松：日期相等也算
  } else {
    return billDateBj > anchorDateBj;    // 严格：日期必须严格晚于
  }
}

// ========== 批量查采购入库明细（与原两边 SQL 完全一致）==========
// 在 Edge Function 里调用：await queryPurchaseInPool(pool, codesList)
export async function queryPurchaseInPool(
  pool: any,
  codes: string[]
): Promise<Record<string, FifoPurchaseRow[]>> {
  const result: Record<string, FifoPurchaseRow[]> = {};
  if (!codes || codes.length === 0) return result;

  const codesList = codes.map(c => `N'${c.replace(/'/g, "''")}'`).join(',');
  const sqlQuery = `
    SELECT v.usercode, vs.BillDate, ABS(vs.Qty) as qty
    FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
    JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
    WHERE vs.BillType = 34 AND vs.InKRec = '3' AND v.usercode IN (${codesList})
  `;
  const purchaseRes = await pool.request().query(sqlQuery);
  for (const row of purchaseRes.recordset) {
    const r: any = row;
    const code = (r.usercode || '').trim();
    if (!result[code]) result[code] = [];
    result[code].push({ date: r.BillDate, qty: Number(r.qty || 0) });
  }
  return result;
}

// ======================================================================
// 核心 FIFO 判定 —— 输入全部 pending reports + 采购明细，输出应该标记已完成的 report id 列表
// 逐行返回，调用方自己做 Supabase UPDATE
// ======================================================================
export interface FifoRunResult {
  toCompleteIds: string[];           // 应标记为已完成的 report.id 列表
  details: string[];                 // 诊断日志
  purchaseEnoughMap: Record<string, boolean>; // 每个商品采购是否已够（用于 30 天回退保护）
  skippedNoEligible: number;         // 因完全无可用采购跳过的 report 数
}

export function runFIFO(
  pendingReports: FifoReport[],
  purchaseByCode: Record<string, FifoPurchaseRow[]>,
  sameDayCounts: boolean = true   // 【2026-11-08 放开锚点】默认宽松
): FifoRunResult {
  const details: string[] = [];
  const toCompleteIds: string[] = [];
  const purchaseEnoughMap: Record<string, boolean> = {};
  let skippedNoEligible = 0;

  // 按商品分组 + 时间升序
  const itemsByCode: Record<string, FifoReport[]> = {};
  for (const r of pendingReports) {
    const code = r.product_code;
    if (!code) continue;
    if (!itemsByCode[code]) itemsByCode[code] = [];
    itemsByCode[code].push(r);
  }
  for (const code of Object.keys(itemsByCode)) {
    itemsByCode[code].sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  }

  const activeCodes = Object.keys(itemsByCode);
  details.push(`待检测商品: ${activeCodes.length} 个`);

  for (const code of activeCodes) {
    const myReports = itemsByCode[code];
    if (myReports.length === 0) continue;

    const purchaseRows = purchaseByCode[code] || [];
    if (purchaseRows.length === 0) {
      skippedNoEligible += myReports.length;
      purchaseEnoughMap[code] = false;
      continue;
    }

    // ======= 【2026-11-09 修复】每条 report 用自己的 created_at 当 anchor =======
    // 旧口径：整个商品取 earliest pending report 的日期 → 错误地让新上报消费了旧入库
    // 新口径：每条 report 独立判断「哪些采购入库单的 BillDate >= 本条上报的日期」
    //         共享一个"剩余池"（FIFO 顺序保证先报先消耗，不会重复扣同一张入库单）
    // 但由于每条 report 的 anchor 不同，剩余池实际上需要按 anchor 重新算：
    //   已消耗掉的采购入库单 = 被排在当前 report 之前（更早上报）的 report 扣完的那些
    //   等价实现：对每条 report，先算其 anchor 下的 eligible 采购，再减去已被前面 report 扣掉的量

    // 预处理：每张采购入库单按 BillDate 升序排序，带 qty 余额
    // 核心数据结构：purchasePoolEntries —— 每张入库 = 1 条，带初始 qty 和剩余余额
    const poolEntries = purchaseRows
      .map(p => ({
        bill_date_bj: toBjDate(p.date),
        orig_qty: Number(p.qty || 0),
        remain: Number(p.qty || 0)
      }))
      .sort((a, b) => a.bill_date_bj.localeCompare(b.bill_date_bj));

    let passed = 0;
    let demandSum = 0;
    for (const r of myReports) {
      const demand = Number(r.demand_quantity) || 0;
      if (demand <= 0) continue;
      demandSum += demand;
      const myAnchor = toBjDate(r.created_at);

      // 汇总：本条 report 可用的采购池 = 所有 bill_date_bj >= myAnchor 的 entries 的 remain 之和
      let eligibleRemain = 0;
      for (const pe of poolEntries) {
        if (isPurchaseEligible(pe.bill_date_bj, myAnchor, sameDayCounts)) {
          eligibleRemain += pe.remain;
        }
      }

      if (eligibleRemain >= demand) {
        // 逐条扣：FIFO 消耗 oldest-first（BillDate 升序，且已经排序）
        let need = demand;
        for (const pe of poolEntries) {
          if (need <= 0) break;
          if (!isPurchaseEligible(pe.bill_date_bj, myAnchor, sameDayCounts)) continue;
          const take = Math.min(pe.remain, need);
          pe.remain -= take;
          need -= take;
        }
        toCompleteIds.push(r.id);
        passed++;
      } else {
        // 本商品 FIFO 严格顺序：这条没了，后面的也不会有
        break;
      }
    }

    // purchaseEnoughMap：商品级判断（最新那条 report 的 anchor 下 eligible 池是否 >= 总需求）
    const latestAnchorBj = toBjDate(myReports[myReports.length - 1].created_at);
    let latestAnchorEligible = 0;
    for (const pe of poolEntries) {
      if (isPurchaseEligible(pe.bill_date_bj, latestAnchorBj, sameDayCounts)) {
        latestAnchorEligible += pe.orig_qty;  // 用 orig_qty（不扣 remain，纯总池子判断）
      }
    }
    purchaseEnoughMap[code] = latestAnchorEligible >= demandSum;

    if (passed > 0) {
      // 剩余池（最新 anchor 口径下）
      let latestRemainAfter = 0;
      for (const pe of poolEntries) {
        if (isPurchaseEligible(pe.bill_date_bj, latestAnchorBj, sameDayCounts)) {
          latestRemainAfter += pe.remain;
        }
      }
      details.push(
        `  ${code}: ${passed}/${myReports.length} 完成（最新anchor后采购池剩余 ${latestRemainAfter}，总需求 ${demandSum}）`
      );
    }
  }

  details.push(`FIFO 完成判定: ${toCompleteIds.length} 条 report`);
  if (skippedNoEligible > 0) {
    details.push(`无可用采购跳过: ${skippedNoEligible} 条`);
  }

  return { toCompleteIds, details, purchaseEnoughMap, skippedNoEligible };
}
