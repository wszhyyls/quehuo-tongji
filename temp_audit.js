const https = require('https');
const API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI';

function doReq(method, path, body) {
  return new Promise((res, rej) => {
    const opts = {
      hostname: 'qswpgnnedqvuegwfbprd.supabase.co',
      path, method,
      headers: { 'apikey': API_KEY, 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + API_KEY },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
    const req = https.request(opts, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); });
    req.on('error', rej);
    if (body) req.write(body, 'utf8'); req.end();
  });
}

(async () => {
  // 1. 拉所有 active reports
  const r1 = await doReq('GET', '/rest/v1/reports?select=id,product_code,product_name,store_id,demand_quantity,replenish_status,created_at&order=created_at.desc&limit=2000');
  const all = JSON.parse(r1);
  const active = all.filter(x => !['已完成','厂家断货','已关闭'].includes(x.replenish_status));

  // 2. 按商品汇总 demand + latestAt
  const byCode = {};
  for (const r of active) {
    const c = r.product_code;
    if (!byCode[c]) byCode[c] = { code: c, name: r.product_name, demand: 0, latestAt: r.created_at };
    byCode[c].demand += Number(r.demand_quantity) || 0;
    if (r.created_at > byCode[c].latestAt) byCode[c].latestAt = r.created_at;
  }

  const codes = Object.values(byCode).filter(x => x.demand > 0);
  console.log(`共 ${codes.length} 个活跃商品需要判定\n`);

  // 3. 调 Edge Function SQL 批量查锚点后采购量
  // 重新加 debug_query action 太麻烦 —— 直接用原始 SQL 查询
  // 我们构造一个 SQL 让 Edge Function 执行
  const batchCodes = codes.map(x => `'${x.code}'`).join(',');

  const sqlBody = JSON.stringify({
    action: 'sql_query',
    params: {
      sql: `SELECT v.usercode as product_code, ISNULL(SUM(ABS(vs.Qty)),0) as qty, MAX(vs.BillDate) as last_purchase
            FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
            JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
            WHERE v.usercode IN (${batchCodes}) AND vs.BillType = 34 AND vs.InKRec = '3'
            GROUP BY v.usercode`
    }
  });

  // 直接走 get_summary 的 SQL Server 逻辑... 简单粗暴：用已有的 get_summary 拿 SQL Server 补货状态和入库日期
  // 实际上最简单的是：我们跑 scheduled-task 一次拿判定 details，然后对有争议的商品单独分析
  // 让我们换个思路：用已有的 SQL Server 连接

  // 简化：逐个商品查锚点后采购
  const results = [];
  for (const item of codes.slice(0, 50)) {
    const anchor = item.latestAt ? new Date(item.latestAt).toISOString().substring(0, 10) : '';
    const qBody = JSON.stringify({
      action: 'sql_query',
      params: {
        sql: `SELECT ISNULL(SUM(ABS(vs.Qty)),0) as qty
              FROM ZHYYLS.dbo.vBuySendSumDetail vs WITH(NOLOCK)
              JOIN ZHYYLS.dbo.Vptype v WITH(NOLOCK) ON v.rec = vs.PRec
              WHERE v.usercode = '${item.code}' AND vs.BillType = 34 AND vs.InKRec = '3'
              ${anchor ? `AND vs.BillDate > '${anchor}'` : ''}`
      }
    });
    // sql_query action 也不存在... 用 Edge Function 的任意一个能跑 SQL Server 的 action
    // debug_query 已删除，用 get_purchase_plan ？不行
    // 只能临时加一个 sql_query action

    // 暂时打印锚点和需求
    results.push({ ...item, anchor, purchaseQty: 'TBD' });
  }

  // 输出表格（ASCII）
  console.log('┌──────────────┬──────────────────────┬──────┬────────────┬────────────┬──────────┐');
  console.log('│ 商品编码     │ 商品名               │ 需求 │ 最新上报日 │ 锚点后采购 │ 判定     │');
  console.log('├──────────────┼──────────────────────┼──────┼────────────┼────────────┼──────────┤');
  for (const r of results) {
    console.log(`│ ${r.code.padEnd(12)} │ ${(r.name || '').padEnd(20)} │ ${String(r.demand).padEnd(4)} │ ${String(r.anchor || '').padEnd(10)} │ ${String(r.purchaseQty).padEnd(10)} │          │`);
  }
  console.log('└──────────────┴──────────────────────┴──────┴────────────┴────────────┴──────────┘');
})();
