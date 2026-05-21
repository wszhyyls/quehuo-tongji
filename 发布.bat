@echo off
chcp 65001 >nul
title 缺货统计系统 - 发布工具
cd /d "%~dp0"

:: 读取版本号
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

:: ==================== 环境检查 ====================
node --version >nul 2>&1
if errorlevel 1 (echo [错误] 未安装 Node.js & pause & exit /b 1)

:: ==================== 部署网页 ====================
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
call npx supabase functions deploy query-shortage-data --project-ref qswpgnnedqvuegwfbprd --no-verify-jwt
if errorlevel 1 (echo [错误] 部署失败 & pause & exit /b 1)

echo [2/3] 部署 check-update...
call npx supabase functions deploy check-update --project-ref qswpgnnedqvuegwfbprd --no-verify-jwt

echo [3/3] 部署 scheduled-task...
call npx supabase functions deploy scheduled-task --project-ref qswpgnnedqvuegwfbprd --no-verify-jwt

echo.
echo ═══ 步骤 B: 同步前端文件 ═══
if not exist "deploy" mkdir deploy
if not exist "deploy\static\js" mkdir "deploy\static\js"
if not exist "deploy\static\css" mkdir "deploy\static\css"
copy /Y "login.html" "deploy\login.html" >nul
copy /Y "store.html" "deploy\store.html" >nul
copy /Y "admin.html" "deploy\admin.html" >nul
copy /Y "index.html" "deploy\index.html" >nul
copy /Y "_headers" "deploy\_headers" >nul
copy /Y "manifest.json" "deploy\manifest.json" >nul
copy /Y "electron-main.js" "deploy\electron-main.js" >nul
xcopy /E /Y /Q "static\js\*.js" "deploy\static\js\" >nul
xcopy /E /Y /Q "static\css\*.css" "deploy\static\css\" >nul
copy /Y "static\*.png" "deploy\static\" >nul 2>nul
copy /Y "static\*.jpg" "deploy\static\" >nul 2>nul
echo [OK] 前端文件同步完成

echo.
echo ═══ 步骤 C: 部署到 Cloudflare ═══
call npx wrangler pages deploy deploy --project-name wszhyy --commit-dirty=true
if errorlevel 1 (echo [错误] 部署失败 & pause & exit /b 1)
echo [OK] Cloudflare 部署完成
echo 访问地址: https://wszhyy.pages.dev

if "%choice%"=="1" goto end

:: ==================== 打包客户端 ====================
:build
if "%choice%"=="4" goto end
if "%choice%"=="1" goto end
echo.
echo ═══ 步骤 D: 打包客户端 ═══
echo 清除旧文件...
rmdir /s /q "C:\temp\wszh-build" >nul 2>nul
echo 开始打包 (约 2-3 分钟)...
call npm run build:win
if errorlevel 1 (
    echo [错误] 打包失败，请检查上方错误信息
    pause
    exit /b 1
)
echo [OK] 打包完成: C:\temp\wszh-build\WSZH-ShortageStore Setup %V%.exe

:: 复制到桌面
for /f "tokens=2*" %%i in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" /v Desktop 2^>nul ^| findstr "Desktop"') do set DESKTOP=%%j
copy /Y "C:\temp\wszh-build\WSZH-ShortageStore Setup %V%.exe" "%DESKTOP%\缺货系统v%V%.exe" >nul 2>nul
echo [OK] 已复制到桌面

:: 上传 GitHub Release
echo.
echo ═══ 步骤 E: 上传到 GitHub Release ═══
gh auth status >nul 2>&1
if errorlevel 1 (
    echo [跳过] 未登录 gh CLI，跳过分发上传
) else (
    gh release upload v%V% "C:\temp\wszh-build\WSZH-ShortageStore Setup %V%.exe" --clobber >nul 2>&1
    if errorlevel 1 (echo [提示] 上传失败，请手动执行 gh release upload) else (echo [OK] 已上传到 GitHub Release)
)

:: ==================== 推送 Git ====================
:push
if "%choice%"=="2" goto end
if "%choice%"=="5" goto end
echo.
echo ═══ 步骤 F: 推送到 GitHub ═══
echo 请输入提交说明:
set /p MSG="> "
if "%MSG%"=="" set MSG=Update v%V%
git add -A
git commit -m "%MSG%"
if errorlevel 1 (echo [提示] 无变更或提交失败)
git push origin main
if errorlevel 1 (echo [警告] 推送失败，请检查网络后重试) else (echo [OK] 推送成功)

:end
echo.
echo ═══════════════════════════════════
echo   版本 %V% - 完成！
echo ═══════════════════════════════════
pause
