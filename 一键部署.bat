@echo off
chcp 65001 >nul
echo ========================================
echo   缺货统计系统 - 一键部署
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] 正在部署 Edge Function...
call npx wrangler deploy supabase/functions/query-shortage-data/index.ts --force
if %errorlevel% neq 0 (
    echo 部署失败！
    pause
    exit /b 1
)
echo.

echo [2/3] 正在部署前端页面到 Cloudflare Pages...
call npx wrangler pages deploy deploy/ --project-name=缺货统计系统
if %errorlevel% neq 0 (
    echo 部署失败！
    pause
    exit /b 1
)
echo.

echo ========================================
echo   部署完成！
echo ========================================
pause
