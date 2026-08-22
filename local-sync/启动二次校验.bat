@echo off
chcp 65001 >nul
title 缺货统计 - 二次校验（后台）
cd /d "%~dp0"

echo.
echo ==========================================
echo   二次校验 - 后台持续运行
echo   每 60 秒检查一次已到货商品库存
echo   关闭窗口或 Ctrl+C 停止
echo ==========================================
echo.

node second-check.mjs --watch 60000