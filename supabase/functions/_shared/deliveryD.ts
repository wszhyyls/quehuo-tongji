// ========== Supabase Edge Function 共享模块：配送量 D（按上报日分段）==========
// 2026-11-12 定稿口径（用户拍板 D 方案）：
//   区间 = [本条 report 上报日（北京时间，含）, 下一条同 (商品,门店) report 上报日（不含）)
//   - 最后一条 report 的窗口统计到今天（until = null）
//   - 切段用该组合全部 report（含已关闭、厂家断货）
//   - 同日多单按 id 升序，先创建的那张窗口为空（since == until → D = 0）
//   - 只算 704 出库：OutKRec='3'、InKRec=该门店 krec、Comment 不含"调货出库单"，取 ABS(Qty)
//   - 不对需求封顶，富余作废不结转（区间互不重叠，天然不结转）
// 判定：D >= 需求 → 该单配送满足（已配送/界面已完成）；否则停在已入库（reports.已完成）
//
// 【唯一来源】query-shortage-data 的所有配送判定都必须走这里，禁止再复制区间逻辑。

// ========== 北京时间日期（YYYY-MM-DD）==========
export function toBjDate(utcInput: string | Date | undefined | null): string {
  if (!utcInput) return '';
  const d = typeof utcInput === 'string' ? new Date(utcInput) : utcInput;
  if (isNaN(d.getTime())) return '';
  const bjMs = d.getTime() + 8 * 3600000; // UTC → 北京
  return new Date(bjMs).toISOString().substring(0, 10);
}

export function bjToday(): string { return toBjDate(new Date()); }

// 门店名称 → ZHYYLS krec 映射（与 query-shortage-data 原 STORE_KREC_MAP 同值）
export const STORE_KREC_MAP: Record<string, string> = {
  '02第二药店': '5', '03第三药店': '6', '04第四药店': '7',
  '06常口店': '9', '08第八药店': '66', '09第九药店': '11',
  '14第十四药店': '36', '16凤凰山药店': '50', '17益丰店': '13', '21富源店': '63',
};

export interface DWindow {
  report_id: number;
  product_code: string;
  store_name: string;
  store_id: string;
  since: string;        // 本窗口起始（含）
  until: string | null; // 下一条同组合上报日（不含）；null = 统计到今天
  demand: number;
}

export interface DResult {
  values: Record<string, number>;  // report_id → D
  windows: Record<string, DWindow>;
}

// 统一把 Date / 字符串 归一成 YYYY-MM-DD（用于与 since/until 做日期级比较）
function dateKey(v: any): string {
  if (!v) return '';
  if (typeof v === 'string') return v.substring(0, 10);
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  return '';
}

function tsOf(utcInput: any): number {
  const d = typeof utcInput === 'string' ? new Date(utcInput) : utcInput;
  const t = d instanceof Date ? d.getTime() : NaN;
  return isNaN(t) ? 0 : t;
}

// 按 (product_code, store_name) 切窗口
// reports: Supabase reports 行（至少含 id / product_code / store_name / store_id / demand_quantity / created_at）
export function buildWindows(reports: any[]): Map<string, DWindow> {
  const groups = new Map<string, any[]>();
  for (const r of (reports || [])) {
    if (!r || !r.product_code || !r.store_name) continue;
    const key = r.product_code + '||' + r.store_name;
    const arr = groups.get(key);
    if (arr) arr.push(r); else groups.set(key, [r]);
  }
  const out = new Map<string, DWindow>();
  for (const arr of groups.values()) {
    // 同日多单按 id 升序，先创建的窗口为空
    arr.sort((a, b) => {
      const d = tsOf(a.created_at) - tsOf(b.created_at);
      return d !== 0 ? d : (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    for (let i = 0; i < arr.length; i++) {
      const cur = arr[i];
      const next = arr[i + 1];
      const since = toBjDate(cur.created_at);
      if (!since) continue; // 上报日不可解析，不产生窗口（该单不参与配送判定）
      const until = next ? toBjDate(next.created_at) : null;
      out.set(String(cur.id), {
        report_id: Number(cur.id),
        product_code: cur.product_code,
        store_name: cur.store_name,
        store_id: cur.store_id || '',
        since,
        until: until || null,
        demand: Number(cur.demand_quantity) || 0,
      });
    }
  }
  return out;
}

// 拉 704 出库明细（配送中心 → 门店），一次按商品编码批量查
export async function fetch704Rows(
  pool: any,
  codes: string[],
  krecs: string[],
  minSince: string
): Promise<Array<{ code: string; krec: string; date: string; qty: number }>> {
  const out: Array<{ code: string; krec: string; date: string; qty: number }> = [];
  const codeList = [...new Set((codes || []).filter(Boolean))];
  const krecList = [...new Set((krecs || []).filter(Boolean))];
  if (codeList.length === 0 || krecList.length === 0) return out;

  for (let i = 0; i < codeList.length; i += 200) {
    const batch = codeList.slice(i, i + 200);
    const req = pool.request();
    const codePh = batch.map((c, idx) => { req.input(`c${idx}`, c); return `@c${idx}`; }).join(',');
    const krecPh = krecList.map((k, idx) => { req.input(`k${idx}`, k); return `@k${idx}`; }).join(',');
    req.input('minSince', minSince);
    const res = await req.query(`
      SELECT v.usercode as code, vs.InKRec as krec, vs.BillDate as bill_date, ABS(vs.Qty) as qty
      FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH (NOLOCK)
      JOIN ZHYYLS.dbo.Vptype v WITH (NOLOCK) ON v.rec = vs.PRec
      WHERE vs.OutKRec = '3'
        AND vs.InKRec IN (${krecPh})
        AND vs.BillDate >= @minSince
        AND (vs.Comment IS NULL OR vs.Comment NOT LIKE '%调货出库单%')
        AND v.usercode IN (${codePh})
    `);
    for (const row of (res.recordset || [])) {
      const r = row as any;
      out.push({ code: r.code, krec: String(r.krec), date: dateKey(r.bill_date), qty: Number(r.qty) || 0 });
    }
  }
  return out;
}

// Supabase 分页拉全（默认单次 1000 条上限，必须翻页，否则窗口会被截断）
async function fetchAllRows(builder: any, pageSize = 1000): Promise<any[]> {
  const all: any[] = [];
  let from = 0;
  for (let guard = 0; guard < 50; guard++) {
    const { data, error } = await builder.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// 计算指定 report 的 D 值（返回 values/windows，键为 String(report_id)）
export async function computeD(
  pool: any,
  supabase: any,
  reportIds: Array<number | string>
): Promise<DResult> {
  const values: Record<string, number> = {};
  const windows: Record<string, DWindow> = {};
  const ids = [...new Set((reportIds || []).map(n => Number(n)).filter(n => n > 0))];
  if (ids.length === 0) return { values, windows };

  // 1. 目标 report
  const targets: any[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const batch = ids.slice(i, i + 150);
    const rows = await fetchAllRows(
      supabase.from('reports')
        .select('id, product_code, store_name, store_id, demand_quantity, created_at')
        .eq('order_type', '缺货订购')
        .in('id', batch)
    );
    targets.push(...rows);
  }
  if (targets.length === 0) return { values, windows };

  // 2. 同商品的全部 report（含已关闭/厂家断货），用于切段
  const codes = [...new Set(targets.map((r: any) => r.product_code).filter(Boolean))];
  const allReports: any[] = [];
  for (let i = 0; i < codes.length; i += 100) {
    const batch = codes.slice(i, i + 100);
    const rows = await fetchAllRows(
      supabase.from('reports')
        .select('id, product_code, store_name, store_id, demand_quantity, created_at')
        .eq('order_type', '缺货订购')
        .in('product_code', batch)
    );
    allReports.push(...rows);
  }

  // 3. 切窗口（全部 report 的窗口），再挑出目标 report
  const allWindows = buildWindows(allReports.length > 0 ? allReports : targets);
  const targetIds = new Set(targets.map((r: any) => String(r.id)));
  const picked: DWindow[] = [];
  for (const [key, w] of allWindows.entries()) {
    if (!targetIds.has(key)) continue;
    if (!STORE_KREC_MAP[w.store_name]) continue; // 门店无 krec，无法统计，视为无 D
    picked.push(w);
    windows[key] = w;
  }
  if (picked.length === 0) return { values, windows };

  // 4. 查 704 出库明细（从最早窗口起点开始）
  const minSince = picked.reduce((m, w) => (!m || w.since < m) ? w.since : m, '');
  const krecs = picked.map(w => STORE_KREC_MAP[w.store_name]);
  const rows = await fetch704Rows(pool, codes, krecs, minSince || '2000-01-01');

  // 5. 按 (code, krec) 建日期前缀和，二分求区间值
  const buckets = new Map<string, { dates: string[]; prefix: number[] }>();
  const grouped = new Map<string, Array<{ d: string; q: number }>>();
  for (const r of rows) {
    const k = r.code + '||' + r.krec;
    const arr = grouped.get(k);
    if (arr) arr.push({ d: r.date, q: r.qty }); else grouped.set(k, [{ d: r.date, q: r.qty }]);
  }
  for (const [k, arr] of grouped.entries()) {
    arr.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    const dates: string[] = [];
    const prefix: number[] = [0];
    for (const it of arr) {
      dates.push(it.d);
      prefix.push(prefix[prefix.length - 1] + it.q);
    }
    buckets.set(k, { dates, prefix });
  }

  const lowerBound = (dates: string[], v: string): number => {
    let lo = 0, hi = dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  for (const w of picked) {
    const krec = STORE_KREC_MAP[w.store_name];
    const bucket = buckets.get(w.product_code + '||' + krec);
    if (!bucket) { values[String(w.report_id)] = 0; continue; }
    const lo = lowerBound(bucket.dates, w.since);
    const hi = w.until ? lowerBound(bucket.dates, w.until) : bucket.dates.length;
    values[String(w.report_id)] = hi > lo ? bucket.prefix[hi] - bucket.prefix[lo] : 0;
  }

  return { values, windows };
}
