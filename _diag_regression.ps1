$ErrorActionPreference = "Continue"
$NOW = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$PREFIX = "https://wszhyy.pages.dev"
$ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI"

Write-Host "===== 1. sw.js 线上内容 ====="
try {
    $swResp = Invoke-WebRequest -Uri "$PREFIX/sw.js?v=$NOW" -UseBasicParsing -TimeoutSec 30
    Write-Host "status: $($swResp.StatusCode)  content-type: $($swResp.Headers['Content-Type'])  长度: $($swResp.Content.Length)"
    Write-Host ($swResp.Content.Substring(0, [Math]::Min(400, $swResp.Content.Length)))
    if ($swResp.Content -match 'shortage-tool-v[\d.]+') { Write-Host "✅ CACHE_NAME: $($Matches[0])" }
    else { Write-Host "❌ 不是 Service Worker 代码" }
} catch { Write-Host "❌ sw.js 拉取失败: $_" }

Write-Host "`n===== 2. admin.html 线上内容 ====="
try {
    $htmlResp = Invoke-WebRequest -Uri "$PREFIX/admin.html?v=$NOW" -UseBasicParsing -TimeoutSec 30
    Write-Host "status: $($htmlResp.StatusCode)  content-type: $($htmlResp.Headers['Content-Type'])  长度: $($htmlResp.Content.Length)"
    if ($htmlResp.Content -match 'navigator\.serviceWorker') { Write-Host "✅ 有 SW 注册代码" } else { Write-Host "❌ admin.html 没注册 SW" }
    if ($htmlResp.Content -match 'loadSummary') { Write-Host "✅ admin.html 有 loadSummary 引用" } else { Write-Host "❌ 没 loadSummary" }
    if ($htmlResp.Content -match 'supabase-init') { Write-Host "✅ 有 supabase-init" } else { Write-Host "❌ 没 supabase-init" }
    # 找 admin.js 引用
    [regex]::Matches($htmlResp.Content, 'static/js/[^"''\s>]+\.js') | ForEach-Object { Write-Host "  JS: $($_.Value)" }
} catch { Write-Host "❌ admin.html 失败: $_" }

Write-Host "`n===== 3. get_summary Edge Function ====="
try {
    $body = '{"action":"get_summary","params":{}}'
    $ef = Invoke-RestMethod -Uri "https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data" -Method POST -ContentType "application/json" -Headers @{apikey=$ANON} -Body $body -TimeoutSec 60
    Write-Host "success: $($ef.success)  error: $($ef.error)"
    if ($ef.data) {
        Write-Host "reports 条数: $($ef.data.reports.Count)"
        Write-Host "supplierLookup 键数: $(($ef.data.supplierLookup.PSObject.Properties | Measure-Object).Count)"
        Write-Host "warehouseStockMap 键数: $(($ef.data.warehouseStockMap.PSObject.Properties | Measure-Object).Count)"
    }
} catch { Write-Host "❌ get_summary 失败: $_" }

Write-Host "`n===== 4. utils.js admin.js 线上 200 OK ====="
try {
    $uResp = Invoke-WebRequest -Uri "$PREFIX/static/js/utils.js?v=$NOW" -UseBasicParsing -TimeoutSec 30 -Method HEAD
    Write-Host "utils.js status: $($uResp.StatusCode)  Cache-Control: $($uResp.Headers['Cache-Control'])  200?" ($uResp.StatusCode -eq 200)
} catch { Write-Host "❌" }
try {
    $aResp = Invoke-WebRequest -Uri "$PREFIX/static/js/admin.js?v=$NOW" -UseBasicParsing -TimeoutSec 30 -Method HEAD
    Write-Host "admin.js status: $($aResp.StatusCode)  Cache-Control: $($aResp.Headers['Cache-Control'])  200?" ($aResp.StatusCode -eq 200)
} catch { Write-Host "❌" }

Write-Host "`n===== 5. 本地 deploy sw.js CACHE_NAME ====="
$localSw = Get-Content "G:\Trae项目\缺货统计系统\deploy\static\sw.js" -Raw
if ($localSw -match 'shortage-tool-v[\d.]+') { Write-Host "本地 CACHE_NAME: $($Matches[0])" }

Write-Host "`n===== 6. 本地 admin.html 是否注册 SW ====="
$localHtml = Get-Content "G:\Trae项目\缺货统计系统\deploy\admin.html" -Raw
if ($localHtml -match 'navigator\.serviceWorker') { Write-Host "✅ 有" } else { Write-Host "❌ 没有！" }
Write-Host "admin.html 前 500 字符:"
Write-Host $localHtml.Substring(0, [Math]::Min(500, $localHtml.Length))
