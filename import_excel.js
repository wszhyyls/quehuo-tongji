// 导入采购记录Excel到数据库
var XLSX = require('xlsx');
var fs = require('fs');

var filePath = process.argv[2] || 'G:/Trae项目/缺货统计系统/采购记录(2).xlsx';
var EDGE_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/procurement-reconciliation';
var SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0ODcxMjAwMCwiZXhwIjoyMDY0Mjg0MDAwfQ.placeholder';

async function main() {
    console.log('📖 读取:', filePath);
    var buf = fs.readFileSync(filePath);
    var wb = XLSX.read(buf, { type: 'buffer' });
    var sh = wb.Sheets[wb.SheetNames[0]];
    var data = XLSX.utils.sheet_to_json(sh, { defval: '' });
    console.log('📊 共', data.length, '条');

    var FIELDS = ['日期','供货商全名','简称','订货方式','付款方式','订货人','订货金额','入库日期','入库金额','入库人','付款人','付款记录','付款日期','财务入库记账','财务付款记账','记账日期','备注','千方系统','是否开具发票'];

    var records = data.map(function(row) {
        var r = {};
        FIELDS.forEach(function(f) { r[f] = (row[f] !== undefined && row[f] !== null && row[f] !== '') ? String(row[f]) : ''; });
        return r;
    });

    console.log('✅ 有效:', records.length, '条');

    var batchSize = 50, total = records.length, success = 0, failed = 0;
    var batches = Math.ceil(total / batchSize);

    for (var i = 0; i < total; i += batchSize) {
        var batch = records.slice(i, Math.min(i + batchSize, total));
        var bi = Math.floor(i / batchSize) + 1;
        try {
            var resp = await fetch(EDGE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SERVICE_KEY,
                    'Authorization': 'Bearer ' + SERVICE_KEY
                },
                body: JSON.stringify({ action: 'import_excel', data: { records: batch } })
            });
            var result = await resp.json();
            if (result.success) {
                var s = result.data.success || batch.length;
                var f = result.data.failed || 0;
                success += s; failed += f;
                console.log('  📥 批次 ' + bi + '/' + batches + ' 成功 ' + s + ' 失败 ' + f + ' (状态 ' + resp.status + ')');
            } else {
                console.log('  ❌ 批次 ' + bi + ' 失败:', result.error || resp.status);
                failed += batch.length;
            }
        } catch(e) {
            console.log('  ❌ 批次 ' + bi + ' 异常:', e.message);
            failed += batch.length;
        }
    }
    console.log('\n========== 导入完成 ==========');
    console.log('总计:', total, '| 成功:', success, '| 失败:', failed);
}

main().catch(function(e) { console.error('致命错误:', e); });
