$owner = "wszhyyls"
$repo = "quehuo-tongji"
$path = ".github/workflows/sync-cache.yml"

# 1. Get current SHA
$info = gh api "repos/$owner/$repo/contents/$path" --jq ".sha" 2>$null
Write-Host "Current SHA: $info"

# 2. Read local file and encode to base64
$content = Get-Content ".github\workflows\sync-cache.yml" -Raw -Encoding UTF8
$base64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($content))

# 3. PUT updated content
$body = @{
    message = "Fix sync-cache secret to use GitHub Secret"
    content = $base64
    sha = $info.Trim()
} | ConvertTo-Json -Compress

$body | Out-File -FilePath "tmp.json" -Encoding UTF8 -Force
$result = gh api "repos/$owner/$repo/contents/$path" -X PUT --input "tmp.json" 2>&1 | Out-String
Write-Host "Result: $result"

# 4. Trigger workflow
Start-Sleep -Seconds 2
gh workflow run "Sync SendBill Cache (每 10 分钟)" -R "$owner/$repo" 2>&1 | Out-String
Write-Host "Workflow triggered"

# Cleanup
Remove-Item "tmp.json" -ErrorAction SilentlyContinue
