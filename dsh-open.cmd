@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo dsh-open: node is not on PATH
  exit /b 1
)
node "%~dp0cli.mjs" %*
exit /b %ERRORLEVEL%
