$bytes = [System.IO.File]::ReadAllBytes('static\js\store.js')
$hasBom = ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)
Write-Host "BOM: $(if ($hasBom) { 'YES' } else { 'NO' })"
Write-Host "Size: $($bytes.Length) bytes"
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
$hasMojibake = $text -match '鑽|闂ㄥ|鍏'
if ($hasMojibake) {
    Write-Host "Mojibake: YES - file is double-encoded"
} else {
    Write-Host "Mojibake: NO"
}
Write-Host "--- First 300 chars ---"
Write-Host $text.Substring(0, [Math]::Min(300, $text.Length))
Write-Host "--- Last 200 chars ---"
$lastIdx = [Math]::Max(0, $text.Length - 200)
Write-Host $text.Substring($lastIdx)
