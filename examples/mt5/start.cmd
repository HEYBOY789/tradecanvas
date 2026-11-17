@echo off
setlocal
cd /d "%~dp0"
set "MT5_CHART_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if not exist "%MT5_CHART_PYTHON%" set "MT5_CHART_PYTHON=python"
if exist "%~dp0.venv\Scripts\python.exe" set "MT5_CHART_PYTHON=%~dp0.venv\Scripts\python.exe"
"%MT5_CHART_PYTHON%" -X utf8 "%~dp0bridge.py" --open %*
if errorlevel 1 pause
