@echo off
rem One-time setup. Double-click this once after unzipping, before the
rem first run. It needs an internet connection and a few minutes.
setlocal

set "HERE=%~dp0"
cd /d "%HERE%"

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYLAUNCH=py -3"
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        set "PYLAUNCH=python"
    ) else (
        echo.
        echo   Python was not found on this computer.
        echo   Install it from https://www.python.org/downloads/
        echo   ^(tick "Add python.exe to PATH" during install^),
        echo   then run this file again.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo   Setting up the AI Question Agent - this only happens once.
echo.

if not exist "%HERE%.venv" (
    echo   Creating a Python environment...
    %PYLAUNCH% -m venv "%HERE%.venv"
)

echo   Installing what it needs...
"%HERE%.venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
"%HERE%.venv\Scripts\python.exe" -m pip install -r "%HERE%requirements.txt"

if %errorlevel% neq 0 (
    echo.
    echo   Something went wrong installing the required packages -
    echo   scroll up for the error. Setup did not finish.
    echo.
    pause
    exit /b 1
)

echo.
echo   Optional: a browser of its own, for the "A browser of its own"
echo   option in the app ^(not needed for "My Chrome, already signed
echo   in", which is the default^). This is a one-off download.
echo.
"%HERE%.venv\Scripts\python.exe" -m playwright install chromium

echo.
echo   Setup finished. Double-click "Run AI Question Agent.cmd" to
echo   start the app.
echo.
pause

endlocal
