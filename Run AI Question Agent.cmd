@echo off
rem Opens the Word-workbook agent. Double-click this file.
setlocal

set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\pythonw.exe"

if not exist "%PY%" set "PY=%HERE%.venv\Scripts\python.exe"

if not exist "%PY%" (
    echo.
    echo   The project's Python environment is missing.
    echo   Expected it at:
    echo     %HERE%.venv
    echo.
    pause
    exit /b 1
)

cd /d "%HERE%"

start "" "%PY%" -m docx_agent.app

endlocal
