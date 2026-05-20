@echo off
chcp 65001 >nul
echo ========================================
echo   缺货统计系统 - 推送到 GitHub
echo ========================================
echo.

cd /d "%~dp0"

REM 检查是否已初始化 Git 仓库
if not exist ".git" (
    echo [准备] 首次使用，正在初始化 Git 仓库...
    git init
    git config user.name "众和医药"
    git config user.email "admin@zhongheyiyao.com"
    echo 请在下方输入你的仓库地址
    echo 例如：https://github.com/wszhyyls/quehuo-tongji.git
    echo.
    set /p REPO_URL="请输入仓库地址: "
    git remote add origin %REPO_URL%
    git branch -M main
) else (
    echo [检测] Git 仓库已初始化
)

REM 检查远程仓库是否配置
git remote -v | findstr "origin" >nul
if %errorlevel% neq 0 (
    echo.
    echo [警告] 未配置远程仓库，请输入仓库地址
    set /p REPO_URL="仓库地址: "
    git remote add origin %REPO_URL%
    git branch -M main
)

echo.
echo [1/3] 暂存所有文件...
git add .
git status

echo.
echo [2/3] 提交更改...
for /f "tokens=2 delims=: " %%a in ('findstr /C:"version" package.json') do set VERSION=%%a
set VERSION=%VERSION:"=%
echo 当前版本: v%VERSION%
git commit -m "Update - 缺货统计系统 v%VERSION%"

echo.
echo [3/3] 推送到 GitHub...
git push -u origin main --force

echo.
echo ========================================
echo   完成！
echo ========================================
pause
