$key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI'

function Test-Speed($name, $url, $headers) {
    $t = Measure-Command {
        try { $script:r = Invoke-WebRequest -Uri $url -Headers $headers -TimeoutSec 30 -UseBasicParsing }
        catch { }
    }
    $ms = [math]::Round($t.TotalMilliseconds)
    $size = if ($script:r) { $script:r.RawContentLength } else { 0 }
    Write-Output ("{0}: {1} ms, {2} bytes" -f $name, $ms, $size)
}

# 1. Cloudflare Pages 页面
1..2 | ForEach-Object { Test-Speed "Pages login.html (第$_次)" 'https://wszhyy.pages.dev/login.html' @{} }

# 2. jsDelivr CDN (supabase-js)
Test-Speed 'jsDelivr supabase-js' 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2' @{}

# 3. Supabase API
Test-Speed 'Supabase Auth health' 'https://qswpgnnedqvuegwfbprd.supabase.co/auth/v1/health' @{ apikey = $key }

# 4. Edge Function 实际业务请求
$t = Measure-Command {
    try {
        $body = '{"action":"check_device_stores","params":{"device_id":"test"}}'
        $script:r2 = Invoke-WebRequest -Uri 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/query-shortage-data' -Method Post -Body $body -ContentType 'application/json' -Headers @{ apikey = $key; Authorization = "Bearer $key" } -TimeoutSec 40 -UseBasicParsing
    } catch { }
}
Write-Output ("Edge Function check_device_stores: " + [math]::Round($t.TotalMilliseconds) + " ms")
