$dest = 'g:/Trae项目/缺货统计系统/static/js/supabase.min.js'
$urls = @(
    'https://registry.npmmirror.com/@supabase/supabase-js/2.58.0/files/dist/umd/supabase.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js'
)
foreach ($u in $urls) {
    Write-Output "尝试: $u"
    $t = Measure-Command {
        try {
            Invoke-WebRequest -Uri $u -OutFile $dest -TimeoutSec 60 -UseBasicParsing
            $ok = $true
        } catch { $ok = $false }
    }
    if ($ok -and (Test-Path $dest) -and ((Get-Item $dest).Length -gt 100000)) {
        Write-Output ("成功: " + [math]::Round($t.TotalMilliseconds) + " ms, " + (Get-Item $dest).Length + " bytes")
        break
    } else {
        Write-Output "失败，换下一个源"
    }
}
if (Test-Path $dest) {
    Copy-Item $dest 'g:/Trae项目/缺货统计系统/deploy/static/js/supabase.min.js' -Force
    Write-Output "已复制到 deploy/static/js/"
}
