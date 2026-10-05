@echo off
chcp 65001 >nul
cd /d "%~dp0"
title CS2 现役职业选手全球分布
echo ================================================
echo   CS2 现役职业选手全球分布
echo ================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js，请先安装：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
node --version
echo.
echo 正在启动本地服务器（浏览器会自动打开；关掉这个窗口即停止）...
echo.
node scripts\serve.mjs
echo.
echo 服务器已停止。
pause
