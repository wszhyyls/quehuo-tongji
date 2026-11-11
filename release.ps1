# ========== 一键打包发布脚本 v5.15.6 ==========
# 功能：Electron 打包 → 三件套进 deploy/releases/ → Cloudflare Pages 部署
# 版本号统一来源：package.json（发布前先改这里）
# 用法：右键 → 使用 PowerShell 运行，或在 PowerShell 里执行 .\release.ps1
# =============================================

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

function Write-Step($msg) { Write-Host "`n========== $msg ==========" -ForegroundColor Cyan }
function Write-OK($msg) { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  ❌ $msg" -ForegroundColor Red; exit 1 }

# ---------- 0. 前置检查 ----------
Write-Step "0. 前置检查"
$pkgPath = Join-Path $projectRoot "package.json"
if (-not (Test-Path $pkgPath)) { Write-Fail "找不到 package.json（请在项目根目录运行本脚本）" }
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$version = $pkg.version
Write-OK "版本号: $version（来源: package.json）"
if (-not (Test-Path "node_modules\.bin\electron-builder.cmd")) { Write-Fail "electron-builder 未安装，请先跑 npm install" }
if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) { Write-Fail "npx.cmd 不可用" }
$exeName = "WSZH-ShortageStore Setup $version.exe"

# ---------- 1. Electron 打包 ----------
Write-Step "1. Electron 打包 ($version)"
$buildOutput = & npx.cmd electron-builder --win --x64 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Fail "electron-builder 失败 (EXIT=$LASTEXITCODE)"
    Write-Host $buildOutput -ForegroundColor Red
}
$distDir = Join-Path $projectRoot "dist"
$exePath = Join-Path $distDir $exeName
$ymlPath = Join-Path $distDir "latest.yml"
$blockPath = Join-Path $distDir "$exeName.blockmap"
foreach ($f in @($exePath, $ymlPath, $blockPath)) {
    if (-not (Test-Path $f)) { Write-Fail "打包产物缺失: $(Split-Path $f -Leaf)" }
}
Write-OK "三件套生成: $exeName / latest.yml / .blockmap"
$sha256 = (Get-FileHash $exePath -Algorithm SHA256).Hash.ToUpper()
$sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
Write-Host "  📦 SHA256: $sha256" -ForegroundColor Yellow
Write-Host "  📦 大小:   $sizeMB MB" -ForegroundColor Yellow

# ---------- 2. 拷贝三件套到 deploy/releases/ ----------
Write-Step "2. 拷贝三件套到 deploy/releases/"
$releaseDir = Join-Path $projectRoot "deploy\releases"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
Get-ChildItem $releaseDir -File | Remove-Item -Force
Copy-Item $ymlPath    "$releaseDir\latest.yml" -Force
Copy-Item $exePath    "$releaseDir\$exeName" -Force
Copy-Item $blockPath  "$releaseDir\$exeName.blockmap" -Force
$files = Get-ChildItem $releaseDir -File
Write-OK "已复制 $($files.Count) 个文件到 deploy/releases/:"
$files | ForEach-Object { Write-Host "    $($_.Name)  ($([math]::Round($_.Length/1MB,1)) MB)" }

# ---------- 3. Cloudflare Pages 部署 ----------
Write-Step "3. Cloudflare Pages 部署"
if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) {
    Write-Host "  ⚠️  wrangler 未安装，跳过 Pages 部署" -ForegroundColor Yellow
    Write-Host "     手动部署: npm i -g wrangler && wrangler pages deploy deploy --project-name=wszhyy" -ForegroundColor DarkGray
} else {
    $wranglerOut = & wrangler pages deploy deploy --project-name=wszhyy 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ⚠️  wrangler 部署失败 (EXIT=$LASTEXITCODE)" -ForegroundColor Yellow
        Write-Host "     错误信息:" -ForegroundColor DarkGray
        Write-Host $wranglerOut -ForegroundColor DarkGray
    } else {
        Write-OK "Pages 部署完成"
        Write-Host $wranglerOut -ForegroundColor Gray
    }
}

# ---------- 完成 ----------
Write-Host "`n============================================" -ForegroundColor Green
Write-Host "  🎉 发布完成！v$version" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host "  安装包: dist\$exeName"
Write-Host "  SHA256: $sha256"
Write-Host "  下载页: https://wszhyy.pages.dev/download.html"
Write-Host "  三件套: deploy\releases\（已含最新）"
Write-Host ""
