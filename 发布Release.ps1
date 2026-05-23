# ==========================================
# GitHub Release 自动上传脚本
# 使用前请先设置 GITHUB_TOKEN 环境变量
# ==========================================

$ErrorActionPreference = "Stop"

$repoOwner = "wszhyyls"
$repoName = "quehuo-tongji"
$version = "3.19.0"
$tag = "v$version"

# 从 package.json 读取版本号
$pkg = Get-Content package.json | ConvertFrom-Json
$version = $pkg.version
$tag = "v$version"

Write-Host "当前版本: $version" -ForegroundColor Cyan

# 检查环境变量中的 GitHub Token
$token = $env:GITHUB_TOKEN
if (-not $token) {
    Write-Host @"

请先设置 GITHUB_TOKEN 环境变量：

方式1（当前窗口生效）：
  `$env:GITHUB_TOKEN="ghp_xxxxxxxxxxxx"`

方式2（永久生效）：
  [系统属性] → 环境变量 → 新建 → GITHUB_TOKEN=你的token

Token 生成地址：https://github.com/settings/tokens
需要勾选 repo 权限。

"@ -ForegroundColor Yellow
    exit 1
}

$headers = @{
    Authorization = "Bearer $token"
    Accept = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
}

# 检查 tag 是否存在
$tagCheckUrl = "https://api.github.com/repos/$repoOwner/$repoName/git/ref/tags/$tag"
try {
    Invoke-RestMethod -Uri $tagCheckUrl -Headers $headers -Method Get | Out-Null
    Write-Host "Tag $tag 已存在，跳过创建" -ForegroundColor Yellow
} catch {
    Write-Host "创建 Tag: $tag..." -ForegroundColor Cyan
    $commit = git rev-parse HEAD
    $body = @{
        ref = "refs/tags/$tag"
        sha = $commit
    } | ConvertTo-Json
    Invoke-RestMethod -Uri "https://api.github.com/repos/$repoOwner/$repoName/git/refs" -Headers $headers -Method Post -Body $body | Out-Null
    Write-Host "Tag 创建成功" -ForegroundColor Green
}

# 创建 Release
Write-Host "创建 Release..." -ForegroundColor Cyan
$releaseBody = @{
    tag_name = $tag
    name = "v$version - 缺货统计系统"
    body = @"
## v$version 更新内容

- 新增供货商字段（缺货订购汇总）
- 状态变更日志系统（StatusChangeLog）
- 历史上报新增规格、商品编码列
- 双表格斑马纹隔行变色+悬停加深
- 品名列间距优化，表格更紧凑
- 需求明细弹窗商品信息蓝色高亮
- 悬停信息范围扩展至整行
- 操作日志翻页（每页10条）
- 已完成区状态下拉支持改回
- 退出客户端确认提示
- 供货商数据从 Vptype.comment 获取
"@
    draft = $false
    prerelease = $false
} | ConvertTo-Json

try {
    # 先尝试获取已有 Release
    $existingUrl = "https://api.github.com/repos/$repoOwner/$repoName/releases/tags/$tag"
    $release = Invoke-RestMethod -Uri $existingUrl -Headers $headers -Method Get
    $releaseId = $release.id
    Write-Host "Release 已存在，使用 ID: $releaseId" -ForegroundColor Yellow
} catch {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoOwner/$repoName/releases" -Headers $headers -Method Post -Body $releaseBody
    $releaseId = $release.id
    Write-Host "Release 创建成功，ID: $releaseId" -ForegroundColor Green
}

# 上传文件
$uploadUrl = "https://uploads.github.com/repos/$repoOwner/$repoName/releases/$releaseId/assets"

$files = @(
    "WSZH-ShortageStore Setup $version.exe",
    "WSZH-ShortageStore Setup $version.exe.blockmap",
    "latest.yml"
)

foreach ($file in $files) {
    $filePath = Join-Path "dist" $file
    if (-not (Test-Path $filePath)) {
        Write-Host "跳过（不存在）: $filePath" -ForegroundColor Yellow
        continue
    }
    Write-Host "上传: $file ..." -ForegroundColor Cyan
    $contentType = if ($file.EndsWith(".exe")) { "application/vnd.microsoft.portable-executable" } else { "application/octet-stream" }
    
    # 删除重名旧文件
    try {
        $existing = Invoke-RestMethod -Uri "$uploadUrl?name=$file" -Headers $headers -Method Get
        if ($existing) {
            Invoke-RestMethod -Uri "$uploadUrl/$($existing.id)" -Headers $headers -Method Delete | Out-Null
        }
    } catch {}

    Invoke-RestMethod -Uri "$uploadUrl?name=$([uri]::EscapeDataString($file))" -Headers ($headers + @{"Content-Type"= "application/octet-stream"}) -Method Post -InFile $filePath | Out-Null
    Write-Host "  完成: $file" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Release v$version 发布完成！" -ForegroundColor Green
Write-Host "  https://github.com/$repoOwner/$repoName/releases/tag/$tag" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
