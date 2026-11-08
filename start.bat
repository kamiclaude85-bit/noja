@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing Noja for the first time...
  call npm install --omit=dev
)
node src\index.js
pause
