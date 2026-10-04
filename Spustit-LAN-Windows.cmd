@echo off
setlocal
title Voxel Frontier LAN
set "APPDIR=%~dp0"
if not exist "%APPDIR%server.js" (
  set "APPDIR=%LOCALAPPDATA%\VoxelFrontierLAN"
  echo Pripravuji Voxel Frontier LAN...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $app=$env:LOCALAPPDATA+'\VoxelFrontierLAN'; $zip=$env:TEMP+'\voxel-frontier-'+$PID+'.zip'; $unpack=$env:TEMP+'\voxel-frontier-'+$PID; New-Item -ItemType Directory -Force -Path $app | Out-Null; Invoke-WebRequest 'https://github.com/Azor216/VoxelCraft/archive/refs/heads/master.zip' -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force; Copy-Item -LiteralPath ($unpack+'\VoxelCraft-master\index.html'),($unpack+'\VoxelCraft-master\server.js'),($unpack+'\VoxelCraft-master\package.json'),($unpack+'\VoxelCraft-master\package-lock.json') -Destination $app -Force; Remove-Item -LiteralPath $zip -Force; Remove-Item -LiteralPath $unpack -Recurse -Force"
  if errorlevel 1 (
    echo Nepodarilo se stahnout LAN server. Zkontroluj internetove pripojeni.
    pause
    exit /b 1
  )
)
cd /d "%APPDIR%"
where node >nul 2>nul
if errorlevel 1 (
  echo Pro LAN je potreba Node.js 20 nebo novejsi.
  echo Oteviram stranku pro stazeni Node.js...
  start "" "https://nodejs.org/"
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
