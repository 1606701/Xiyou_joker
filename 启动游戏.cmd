@echo off
chcp 65001 >nul
title Xiyouji Poker - Server
cd /d "%~dp0"

rem Make sure Node.js is findable (edit the path below if installed elsewhere)
set "PATH=C:\Program Files\nodejs;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install it first: https://nodejs.org/
  pause
  exit /b 1
)

rem Auto-install dependencies on first run (only once)
if not exist "node_modules" (
  echo First run: installing dependencies, please wait...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] Dependency install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

echo Starting server, the LAN access URLs will be shown below...
node server.js

echo.
echo Server stopped.
pause
