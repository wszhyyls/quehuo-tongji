$ErrorActionPreference = 'Continue'
$base = 'https://qswpgnnedqvuegwfbprd.supabase.co'
$key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI'
$origin = 'https://wszhyy.pages.dev'

# 1. OPTIONS 预检（带 Origin，检查 CORS 头）
try {
    $r = Invoke-WebRequest -Uri "$base/functions/v1/query-shortage-data" -Method Options `
        -Headers @{ Origin = $origin; 'Access-Control-Request-Method' = 'POST'; 'Access-Control-Request-Headers' = 'content-type,authorization' } `
        -TimeoutSec 20 -UseBasicParsing
    Write-Output "OPTIONS: $($r.StatusCode)"
    Write-Output "CORS allow-origin: $($r.Headers['Access-Control-Allow-Origin'])"
    Write-Output "CORS allow-headers: $($r.Headers['Access-Control-Allow-Headers'])"
} catch {
    if ($_.Exception.Response) {
        Write-Output ("OPTIONS: HTTP " + [int]$_.Exception.Response.StatusCode)
    } else { Write-Output ("OPTIONS FAILED: " + $_.Exception.Message) }
}

# 2. POST 实际请求（模拟 check_device_stores，登录前调用）
try {
    $body = '{"action":"check_device_stores","params":{"device_id":"test"}}'
    $r2 = Invoke-WebRequest -Uri "$base/functions/v1/query-shortage-data" -Method Post -Body $body -ContentType 'application/json' `
        -Headers @{ apikey = $key; Authorization = "Bearer $key"; Origin = $origin } `
        -TimeoutSec 40 -UseBasicParsing
    Write-Output "POST: $($r2.StatusCode)"
    Write-Output "allow-origin: $($r2.Headers['Access-Control-Allow-Origin'])"
    Write-Output ("BODY: " + $r2.Content.Substring(0, [Math]::Min(400, $r2.Content.Length)))
} catch {
    $resp = $_.Exception.Response
    if ($resp) {
        Write-Output ("POST: HTTP " + [int]$resp.StatusCode)
        try {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $t = $reader.ReadToEnd()
            Write-Output ("BODY: " + $t.Substring(0, [Math]::Min(500, $t.Length)))
        } catch {}
    } else { Write-Output ("POST FAILED: " + $_.Exception.Message) }
}
