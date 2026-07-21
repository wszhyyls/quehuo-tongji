# Fix: update sync-cache.yml on GitHub
$sha = "74e1d47129a2ff409e24447e4ab830873a8f3319"

# Read the file
$yml = Get-Content ".github\workflows\sync-cache.yml" -Raw -Encoding UTF8

# Verify it has the fix
if ($yml -notmatch "SYNC_CACHE_SECRET") {
    Write-Host "ERROR: file doesn't contain SYNC_CACHE_SECRET"
    exit 1
}
Write-Host "Content OK, contains SYNC_CACHE_SECRET"

# Encode as base64
$bytes = [Text.Encoding]::UTF8.GetBytes($yml)
$b64 = [Convert]::ToBase64String($bytes)

# Build JSON string manually (avoid ConvertTo-Json issues)
$json = "{ `"message`": `"Fix sync-cache secret to use GitHub Secret`", `"content`": `"$b64`", `"sha`": `"$sha`" }"
[IO.File]::WriteAllText("$PWD\tmp.json", $json, [Text.Encoding]::ASCII)

# API call
$result = gh api "repos/wszhyyls/quehuo-tongji/contents/.github/workflows/sync-cache.yml" -X PUT --input "tmp.json" 2>&1 | Out-String
Write-Host "API Result: $result"

# Clean
Remove-Item "tmp.json"

# Trigger
if ($result -match "commit") {
    Start-Sleep -Seconds 3
    gh workflow run "Sync SendBill Cache" -R wszhyyls/quehuo-tongji 2>&1 | Out-String
    Write-Host "DONE"
} else {
    Write-Host "FAILED to update"
}
