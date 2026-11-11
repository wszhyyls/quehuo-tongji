$ErrorActionPreference = "Continue"
$NOW = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$PREFIX = "https://wszhyy.pages.dev"

Write-Host "===== admin.html 308 重定向到哪 ====="
try {
    $resp = Invoke-WebRequest -Uri "$PREFIX/admin.html?v=$NOW" -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction SilentlyContinue
    Write-Host "status: $($resp.StatusCode)  Location: $($resp.Headers['Location'])"
} catch {
    if ($_.Exception.Response) {
        $r = $_.Exception.Response
        Write-Host "status: $($r.StatusCode.value__)  Location: $($r.Headers['Location'])"
    } else { Write-Host "ERROR: $_" }
}

Write-Host "`n===== 根路径 ====="
try {
    $resp2 = Invoke-WebRequest -Uri "$PREFIX/?v=$NOW" -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction SilentlyContinue
    Write-Host "status: $($resp2.StatusCode)  Location: $($resp2.Headers['Location'])"
} catch {
    if ($_.Exception.Response) {
        $r = $_.Exception.Response
        Write-Host "status: $($r.StatusCode.value__)  Location: $($r.Headers['Location'])"
    } else { Write-Host "ERROR: $_" }
}

Write-Host "`n===== /login.html ====="
try {
    $resp3 = Invoke-WebRequest -Uri "$PREFIX/login.html?v=$NOW" -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction SilentlyContinue
    Write-Host "status: $($resp3.StatusCode)  Length: $($resp3.Content.Length)"
    Write-Host "前300字符:"
    Write-Host $resp3.Content.Substring(0, [Math]::Min(300, $resp3.Content.Length))
} catch {
    if ($_.Exception.Response) {
        $r = $_.Exception.Response
        Write-Host "status: $($r.StatusCode.value__)  Location: $($r.Headers['Location'])"
    } else { Write-Host "ERROR: $_" }
}

Write-Host "`n===== /static/sw.js (注意子目录) ====="
try {
    $s1 = Invoke-WebRequest -Uri "$PREFIX/static/sw.js?v=$NOW" -UseBasicParsing -TimeoutSec 30
    Write-Host "status: $($s1.StatusCode)  content-type: $($s1.Headers['Content-Type'])  长度: $($s1.Content.Length)"
    if ($s1.Content -match 'shortage-tool-v[\d.]+') { Write-Host "✅ CACHE_NAME: $($Matches[0])" }
    else { Write-Host "❌ 不是 SW 代码，前200字符:"; Write-Host $s1.Content.Substring(0, [Math]::Min(200, $s1.Content.Length)) }
} catch { Write-Host "❌ $($_.Exception.Message)" }

Write-Host "`n===== 根根目录 sw.js ====="
try {
    $s2 = Invoke-WebRequest -Uri "$PREFIX/sw.js?v=$NOW" -UseBasicParsing -TimeoutSec 30
    Write-Host "status: $($s2.StatusCode)  content-type: $($s2.Headers['Content-Type'])  长度: $($s2.Content.Length)"
    if ($s2.Content -match 'shortage-tool-v[\d.]+') { Write-Host "✅ CACHE_NAME: $($Matches[0])" }
    else { Write-Host "❌ 不是 SW，前200字符:"; Write-Host $s2.Content.Substring(0, [Math]::Min(200, $s2.Content.Length)) }
} catch { Write-Host "❌ $($_.Exception.Message)" }

Write-Host "`n===== 本地项目根目录 static/sw.js 对比 ====="
$rootSw = Get-Content "G:\Trae项目\缺货统计系统\static\sw.js" -Raw
if ($rootSw -match 'shortage-tool-v[\d.]+') { Write-Host "项目根 CACHE_NAME: $($Matches[0])  长度: $($rootSw.Length)" } else { Write-Host "❌ 项目根没 CACHE_NAME" }

Write-Host "`n===== GitHub deploy workflow 看看怎么部署 ====="
$wf = Get-Content "G:\Trae项目\缺货统计系统\.github\workflows\deploy.yml" -Raw
Write-Host $wf.Substring(0, [Math]::Min(1000, $wf.Length))
