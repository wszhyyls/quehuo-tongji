@echo off
chcp 65001 >nul
title 卸载二次校验自启任务
set "TASK_NAME=QuehuoSecondCheck"

echo.
echo 正在停止并删除二次校验计划任务...
schtasks /End /TN "%TASK_NAME%" >nul 2>&1
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

echo.
echo 已卸载完成。
pause
