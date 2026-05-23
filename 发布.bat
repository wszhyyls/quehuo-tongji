@echo off
chcp 65001 >nul
title 缺货统计系统 - 发布工具
cd /d "%~dp0"

: 读取版本号
for /f "tokens=2 delims=: " %%a in ('findstr /C:"version" package.json') do set V=%%a
set V=%V:"=%

echo.
echo  ╔══════════════════════════════════╗
echo  ║  缺货统计系统 发布工具 v%V%     ║
echo  ╚══════════════════════════════════╝
echo.
echo  [1] 仅部署网页 (Edge Function + Cloudflare)
echo  [2] 部署网页 + 打包客户端 (.exe)
echo  [3] 部署网页 + 打包 + 推送到 GitHub
echo  [4] 仅推送代码到 GitHub
echo  [5] 仅打包客户端
echo  [0] 退出
echo.
set /p choice="请选择 [0-5]: "

if "%choice%"=="0" exit /b 0

: ==================== 环境检查 ====================
node --version >nul 2>&1
if errorlevel 1 (echo [错误] 未安装 Node.js & pause & exit /b 1)

: ==================== 部署网页 ====================
if "%choice%"=="1" goto deploy
if "%choice%"=="2" goto deploy
if "%choice%"=="3" goto deploy
if "%choice%"=="4" goto push
if "%choice%"=="5" goto build
goto end

:deploy
echo.
echo ═══ 步骤 A: 部署 Edge Functions ═══
echo [1/3] 部署 query-shortage-data...
call npx supabase functions deploy query-shortage-data --project-ref qswpgnnedqvuegwfbprd
if errorlevel 1 (echo [错误] 部署失败 & pause & exit /b 1)

echo [2/3] 部署 check-update...
call npx supabase functions deploy check-update --project-ref qswpgnnedqvuegwfbprd

echo [3/3] 部署 scheduled-task...
call npx supabase functions deploy scheduled-task --project-ref qswpgnnedqvuegwfbprd

echo.
echo ═══ 步骤 B: 同步前端文件到 deploy 目录 ═══
if not exist "deploy" mkdir deploy
if not exist "deploy\static\js" mkdir "deploy\static\js"
if not exist "deploy\static\css" mkdir "deploy\static\css"
copy /Y "login.html" "deploy\login.html" >nul
copy /Y "store.html" "deploy\store.html" >nul
copy /Y "admin.html" "deploy\admin.html" >nul
copy /Y "index.html" "deploy\index.html" >nul
copy /Y "_headers" "deploy\_headers" >nul
copy /Y "manifest.json" "deploy\manifest.json" >nul
xcopy /E /Y /Q "static\js\*.js" "deploy\static\js\" >nul
xcopy /E /Y /Q "static\css\*.css" "deploy\static\css\" >nul
copy /Y "static\*.png" "deploy\static\" >nul 2>nul
copy /Y "static\*.jpg" "deploy\static\" >nul 2>nul
copy /Y "static\*.webmanifest" "deploy\static\" >nul 2>nul
echo [OK] 前端文件同步完成

echo.
echo ═══ 步骤 C: 部署到 Cloudflare ═══
call npx wrangler pages deploy deploy --project-name wszhyy --commit-dirty=true
if errorlevel 1 (echo [错误] 部署失败 & pause & exit /b 1)
echo [OK] Cloudflare 部署完成
echo 访问地址: https://wszhyy.pages.dev

if "%choice%"=="1" goto end

: ==================== 打包客户端 ====================
:build
if "%choice%"=="4" goto end
if "%choice%"=="1" goto end
echo.
echo ═══ 步骤 D: 打包客户端 ═══
echo 清除旧文件...
rmdir /s /q "dist" >nul 2>nul
echo 开始打包 (约 2-3 分钟)...
call npm run build:win
if errorlevel 1 (
    echo [错误] 打包失败，请检查上方错误信息
    pause
    exit /b 1
)
echo [OK] 打包完成

: 列出输出文件
echo.
echo 打包输出:
dir /b "dist\*.exe" 2>nul
echo.
echo 如需上传到 GitHub Release 发布自动更新，请运行：
echo   PowerShell  .\发布Release.ps1  (需先设置 $env:GITHUB_TOKEN)
echo.

: ==================== 推送 Git ====================
:push
if "%choice%"=="2" goto end
if "%choice%"=="5" goto end
echo.
echo ═══ 步骤 E: 推送到 GitHub ═══
echo 请输入提交说明:
set /p MSG="> "
if "%MSG%"=="" set MSG=Update v%V%
git tag -f v%V% >nul 2>&1
git add -A
git commit -m "%MSG%"
if errorlevel 1 (echo [提示] 无变更或提交失败)
git push origin main
if errorlevel 1 (echo [警告] 推送失败，请检查网络后重试) else (echo [OK] 推送成功)
git push origin v%V% --force 2>nul

:end
echo.
echo ═══════════════════════════════════
echo   版本 %V% - 完成！
echo ═══════════════════════════════════
pause
