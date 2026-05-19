@echo off
chcp 65001 >nul
echo ========================================
echo   推送到 GitHub
echo ========================================
echo.

cd /d "%~dp0"

echo [1/4] 初始化 Git 仓库...
git init
git config user.name "众和医药"
git config user.email "admin@zhongheyiyao.com"

echo [2/4] 添加所有文件...
git add .
git status

echo.
echo 请确认以上文件列表，按任意键继续...
pause

echo [3/4] 创建初始提交...
git commit -m "Initial commit - 缺货统计系统 v3.17.1"

echo.
echo [4/4] 推送到 GitHub
echo 请在下方输入你创建的仓库地址
echo 例如：https://github.com/你的用户名/quehuo-tool.git
echo.
set /p REPO_URL="请输入仓库地址: "

git remote add origin %REPO_URL%
git branch -M main
git push -u origin main

echo.
echo ========================================
echo   完成！
echo ========================================
pause
