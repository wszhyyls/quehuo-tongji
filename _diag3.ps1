$ErrorActionPreference = "Continue"
$NOW = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$PREFIX = "https://wszhyy.pages.dev"

function Test-Url($url, $maxRedirects=5) {
    Write-Host "`n=== $url ==="
    $currentUrl = $url
    for ($i = 0; $i -lt $maxRedirects; $i++) {
        Write-Host "  [$i] GET $currentUrl"
        try {
            $resp = Invoke-WebRequest -Uri $currentUrl -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0 -ErrorAction Stop
            Write-Host "      status: $($resp.StatusCode)  Content-Type: $($resp.Headers['Content-Type'])  长度: $($resp.Content.Length)"
            return $resp
        } catch {
            $statusCode = $_.Exception.Response.StatusCode.value__
            $loc = $_.Exception.Response.Headers['Location']
            Write-Host "      status: $statusCode  Location: $loc"
            if ($statusCode -eq 308 -or $statusCode -eq 301 -or $statusCode -eq 302 -or $statusCode -eq 307) {
                if (-not $loc) { Write-Host "      ❌ 无 Location header"; return $null }
                if ($loc -match '^https?://') { $currentUrl = $loc } else { $currentUrl = ($PREFIX + $loc) }
            } else {
                Write-Host "      ❌ 非重定向状态"; return $null
            }
        }
    }
    Write-Host "      ❌ 超过最大重定向"
}

Test-Url "$PREFIX/admin.html?v=$NOW"
Test-Url "$PREFIX/login.html?v=$NOW"
Test-Url "$PREFIX/?v=$NOW"
Test-Url "$PREFIX/static/sw.js?v=$NOW"

Write-Host "`n=== 本地 deploy/admin.html 前 300 字符 ==="
$localAdmin = [System.IO.File]::ReadAllText("G:\Trae项目\缺货统计系统\deploy\admin.html")
Write-Host $localAdmin.Substring(0, [Math]::Min(300, $localAdmin.Length))

Write-Host "`n=== 本地项目根 admin.html 前 300 字符 ==="
$rootAdmin = [System.IO.File]::ReadAllText("G:\Trae项目\缺货统计系统\admin.html")
Write-Host $rootAdmin.Substring(0, [Math]::Min(300, $rootAdmin.Length))

Write-Host "`n=== deploy/ 和 项目根/ 的 admin.html 一样吗 ==="
Write-Host ($localAdmin -eq $rootAdmin)

Write-Host "`n=== _headers 里 admin.html 有没有特殊规则 ==="
$h = [System.IO.File]::ReadAllText("G:\Trae项目\缺货统计系统\deploy\_headers")
Write-Host $h
