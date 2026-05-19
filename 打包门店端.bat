@echo off
chcp 65001 >nul
title WSZH-ShortageStore 打包工具

echo ========================================
echo   WSZH-ShortageStore v3.17 打包工具
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] 检查 Node.js 环境...
node --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装！
    echo 下载地址：https://nodejs.org/
    pause
    exit /b 1
)
echo        Node.js 已安装

echo.
echo [2/3] 安装依赖...
if not exist "node_modules" (
    echo        正在安装依赖（首次需要几分钟）...
    call npm install
) else (
    echo        依赖已安装
)

echo.
echo [3/3] 开始打包 Windows 便携版...
echo        打包完成后文件位置：
echo        %~dp0dist\win-unpacked\
echo.

REM 设置国内镜像加速下载
echo        配置国内镜像...
set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/

echo        开始打包（首次需要下载 Electron，约 5-10 分钟）...
echo.

call npm run build:win

if exist "dist\WSZH-ShortageStore-3.17.0.exe" (
    echo.
    echo ========================================
    echo   打包成功！
    echo ========================================
    echo 文件位置：
    echo   便携版: dist\WSZH-ShortageStore-3.17.0.exe
    echo   解压版: dist\win-unpacked\WSZH-ShortageStore.exe
    echo.
    echo 是否打开输出目录？(Y/N)
    set /p open=
    if /i "%open%"=="Y" explorer dist
) else (
    echo.
    echo [错误] 打包失败，请检查上方错误信息
    pause
)

echo.
echo 按任意键退出...
pause >nul
