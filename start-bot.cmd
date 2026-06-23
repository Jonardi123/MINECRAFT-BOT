@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node.js 22 or newer from https://nodejs.org/ and reopen CMD.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found on PATH.
  echo Reinstall Node.js 22 or newer and make sure "Add to PATH" is enabled.
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

call npm run check
if errorlevel 1 exit /b 1

call npm start
