@echo off
chcp 65001 >nul
echo ========================================
echo   缺货统计系统 - 一键部署
echo ========================================
echo.

cd /d "%~dp0"

REM 获取当前版本号
for /f "tokens=2 delims=: " %%a in ('findstr /C:"version" package.json') do set VERSION=%%a
set VERSION=%VERSION:"=%
echo 当前版本: v%VERSION%
echo.

echo [1/3] 部署 Edge Function 到 Supabase...
call npx supabase functions deploy query-shortage-data --project-ref qswpgnnedqvuegwfbprd
if %errorlevel% neq 0 (
    echo [错误] Edge Function 部署失败！
    pause
    exit /b 1
)
echo [OK] Edge Function 部署成功
echo.

echo [2/3] 同步前端文件到 deploy 目录...
xcopy /E /Y /Q "*.html" "deploy\" 2>nul
xcopy /E /Y /Q "static\" "deploy\static\" 2>nul
xcopy /E /Y /Q "manifest.json" "deploy\" 2>nul
xcopy /E /Y /Q "_headers" "deploy\" 2>nul
echo [OK] 前端文件同步完成
echo.

echo [3/3] 部署前端到 Cloudflare Pages...
call npx wrangler pages deploy deploy --project-name=wszhyy
if %errorlevel% neq 0 (
    echo [错误] Cloudflare Pages 部署失败！
    pause
    exit /b 1
)
echo [OK] Cloudflare Pages 部署成功
echo.

echo ========================================
echo   部署完成！
echo   最新版本: v%VERSION%
echo   访问地址: https://wszhyy.pages.dev
echo ========================================
pause
