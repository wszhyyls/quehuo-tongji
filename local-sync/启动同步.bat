@echo off
chcp 65001 >nul
title 缺货统计 - 数据同步
cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════╗
echo ║  缺货统计系统 - 数据同步 v1.0   ║
echo ╚══════════════════════════════════╝
echo.
echo  [1] 快速同步 (跳过SPFXB，避免冲突)
echo  [2] 完整同步 (含SPFXB刷新)
echo  [3] 持续自动同步 (每60秒，Ctrl+C停止)
echo  [4] 仅同步商品
echo  [5] 仅同步库存
echo  [0] 退出
echo.
set /p choice="请选择 [0-5]: "

if "%choice%"=="1" node sync.mjs --quick
if "%choice%"=="2" node sync.mjs --full
if "%choice%"=="3" node sync.mjs --watch
if "%choice%"=="4" node sync.mjs --products
if "%choice%"=="5" node sync.mjs --inventory
if "%choice%"=="0" exit

echo.
echo 按任意键退出...
pause >nul
