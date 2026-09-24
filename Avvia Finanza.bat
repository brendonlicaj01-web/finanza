@echo off
rem Windows: doppio clic su questo file per avviare Finanza.
setlocal
cd /d "%~dp0"
title Finanza
set "URL=http://localhost:3210"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js non e' installato. Scaricalo da https://nodejs.org ^(versione LTS^) e riprova.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

rem Se l'app e' gia' in esecuzione, basta aprire il browser.
curl -s -o nul "%URL%" >nul 2>&1
if not errorlevel 1 (
  echo Finanza e' gia' avviata: apro %URL%
  start "" "%URL%"
  exit /b 0
)

rem Installa le dipendenze al primo avvio o quando sono cambiate.
set "NEEDS_INSTALL=0"
if not exist node_modules set "NEEDS_INSTALL=1"
if exist node_modules (
  fc /b package-lock.json node_modules\.finanza-lock >nul 2>&1 || set "NEEDS_INSTALL=1"
)
if "%NEEDS_INSTALL%"=="1" (
  echo Installo le dipendenze ^(solo la prima volta o dopo un aggiornamento^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Installazione non riuscita.
    pause
    exit /b 1
  )
  copy /y package-lock.json node_modules\.finanza-lock >nul
)

echo.
echo Finanza si sta avviando su %URL%
echo Lascia aperta questa finestra mentre usi l'app; chiudila per fermarla.
echo.
call npm run dev
pause
