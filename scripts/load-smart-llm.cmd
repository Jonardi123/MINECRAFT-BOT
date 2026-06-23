@echo off
setlocal

set "LMS=%USERPROFILE%\.lmstudio\bin\lms.exe"
set "MODEL=tildeopen-30b-enlv-unsloth-instruct"

if not exist "%LMS%" (
  echo LM Studio CLI was not found at "%LMS%".
  echo Open LM Studio once, then try again.
  exit /b 1
)

echo Unloading the tiny 1B model if it is loaded...
"%LMS%" unload "gemma-3-1b-it-qat" >nul 2>nul

"%LMS%" ps | findstr /i "%MODEL%" >nul 2>nul
if not errorlevel 1 (
  echo %MODEL% is already loaded.
  echo.
  "%LMS%" status
  echo.
  echo Smart LLM is ready. Now run: npm start
  exit /b 0
)

echo Loading %MODEL% with Windows-friendly settings...
"%LMS%" load "%MODEL%" --identifier "%MODEL%" -c 4096 --parallel 1 --ttl 3600 -y
if errorlevel 1 (
  echo.
  echo Could not load %MODEL%.
  echo Try closing other apps or load the model manually in LM Studio with 4096 context and parallel 1.
  exit /b 1
)

echo.
"%LMS%" status
echo.
echo Smart LLM is ready. Now run: npm start
