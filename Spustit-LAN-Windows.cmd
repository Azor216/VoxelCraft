@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Pro LAN je potreba Node.js 20 nebo novejsi.
  echo Stahni ho z https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules\ws\package.json (
  echo Instaluji LAN komponenty...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
set OPEN_BROWSER=1
node server.js
if errorlevel 1 pause
