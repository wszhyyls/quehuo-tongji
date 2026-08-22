/**
 * 二次校验脚本：定期检查 Supabase 中"已到货（自动）"商品
 * 仓库库存=0 的回退为"待处理"，同步更新通知
 * 用法：node second-check.mjs [--watch] [interval_ms]
 */
import { createClient } from '@supabase/supabase-js';
import sql from 'mssql';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

const sqlConfig = {
  server: config.sqlServer.host,
  port: config.sqlServer.port,
  user: config.sqlServer.user,
  password: config.sqlServer.password,
  database: 'ZHYYLS',
  options: { encrypt: false, trustServerCertificate: true, requestTimeout: 60000 },
};

async function runOnce(pool) {
  // 1. 查所有已到货（自动）
  const { data: arrivedAll, error } = await supabase
    .from('reports')
    .select('product_code, store_id')
    .eq('replenish_status', '已到货')
    .eq('order_type', '缺货订购')
    .eq('status_remark', '自动');
  if (error) throw new Error('查询已到货失败: ' + error.message);
  if (!arrivedAll || arrivedAll.length === 0) {
    console.log('[second-check] 无已到货商品');
    return 0;
  }

  const codes = [...new Set(arrivedAll.map(it => it.product_code).filter(Boolean))];
  console.log(`[second-check] 检查 ${arrivedAll.length} 条 (${codes.length} 个商品)`);

  // 2. 批量查库存
  const stockMap = {};
  const BATCH = 100;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const req = pool.request();
    const placeholders = batch.map((c, idx) => {
      const p = `c${idx}`;
      req.input(p, sql.NVarChar, c);
      return `@${p}`;
    }).join(',');
    const whRes = await req.query(`
      SELECT v.usercode, ISNULL(SUM(gs.qty), 0) as wh_qty
      FROM ZHYYLS.dbo.Vptype v WITH(NOLOCK)
      LEFT JOIN ZHYYLS.dbo.GoodsStocks gs WITH(NOLOCK) ON gs.prec = v.rec AND gs.krec = '3'
      WHERE v.usercode IN (${placeholders})
      GROUP BY v.usercode
    `);
    (whRes.recordset || []).forEach(r => { stockMap[r.usercode] = Number(r.wh_qty); });
    batch.forEach(c => { if (!(c in stockMap)) stockMap[c] = 0; });
  }

  // 3. 回退库存=0 的
  let revert = 0;
  for (const it of arrivedAll) {
    const stock = stockMap[it.product_code];
    if ((stock === undefined ? 0 : stock) <= 0) {
      const { error: updErr } = await supabase.from('reports').update({
        replenish_status: '待处理',
        status_remark: '自动',
        status_changed_at: new Date().toISOString(),
        status_changed_by: '系统自动'
      })
        .eq('product_code', it.product_code)
        .eq('store_id', it.store_id)
        .eq('order_type', '缺货订购')
        .eq('replenish_status', '已到货')
        .eq('status_remark', '自动');
      if (!updErr) {
        revert++;
        try {
          await supabase.from('store_notifications').upsert({
            store_id: it.store_id,
            product_code: it.product_code,
            message: `${it.product_code} 仓库库存已耗尽，已回退为待处理`,
            created_at: new Date().toISOString(),
            is_read: false
          }, { onConflict: 'store_id,product_code' });
        } catch (_) { /* 通知失败不阻断 */ }
      }
    }
  }
  console.log(`[second-check] 回退 ${revert} 条`);
  return revert;
}

async function main() {
  const args = process.argv;
  const isWatch = args.includes('--watch');
  // 解析可选的间隔（毫秒），默认 60s
  const intervalArg = args.find(a => /^\d+$/.test(a));
  const interval = intervalArg ? parseInt(intervalArg) : 60000;
  const pool = await sql.connect(sqlConfig);
  console.log('[second-check] 已连接 SQL Server');

  if (isWatch) {
    console.log(`[second-check] 持续运行模式，每 ${interval/1000}s 检查一次`);
    while (true) {
      try {
        await runOnce(pool);
      } catch (e) {
        console.error('[second-check] 错误:', e.message);
      }
      await new Promise(r => setTimeout(r, interval));
    }
  } else {
    const r = await runOnce(pool);
    console.log(`完成，共回退 ${r} 条`);
    await pool.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });