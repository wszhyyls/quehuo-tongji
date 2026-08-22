@echo off
chcp 65001 >nul
title 安装二次校验 - 开机自启后台服务
cd /d "%~dp0"

echo.
echo ══════════════════════════════════════════
echo   安装二次校验为 Windows 计划任务
echo   开机自启 + 后台静默运行
echo ══════════════════════════════════════════
echo.

set "TASK_NAME=QuehuoSecondCheck"
set "SCRIPT_PATH=%~dp0second-check.mjs"

echo 脚本路径: %SCRIPT_PATH%
echo 任务名称: %TASK_NAME%
echo.

echo [1] 正在删除旧任务（如存在）...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

echo [2] 正在创建计划任务...
schtasks /Create /TN "%TASK_NAME%" /TR "node \"%SCRIPT_PATH%\" --watch 60000" /SC ONLOGON /RL LIMITED /F

echo [3] 正在立即启动任务...
schtasks /Run /TN "%TASK_NAME%"

echo.
echo ══════════════════════════════════════════
echo   安装完成！
echo   二次校验已设置为开机自动运行，每60秒检查一次
echo ══════════════════════════════════════════
echo.
echo 管理命令：
echo   停止:  schtasks /End /TN "%TASK_NAME%"
echo   删除:  schtasks /Delete /TN "%TASK_NAME%" /F
echo   手动运行:  schtasks /Run /TN "%TASK_NAME%"
echo.
pause
