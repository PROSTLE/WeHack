@echo off
rem ===========================================================================
rem  NexaFiles launcher
rem
rem  Double-click this file to start the application.
rem
rem  Why it exists rather than just "npm start":
rem
rem    Electron reads ELECTRON_RUN_AS_NODE from the environment. When that
rem    variable is set - and several editors, terminals and agent shells set it
rem    for their own tooling - the electron binary starts as plain Node instead
rem    of as Electron. require('electron') then hands back no `app`, and main.js
rem    dies on its first line of work with:
rem
rem      TypeError: Cannot read properties of undefined (reading 'whenReady')
rem
rem    Clearing that variable is the first thing this script does. The test
rem    runner clears it too, for the same reason.
rem
rem  Starting NexaFiles while it is already running is safe: the application
rem  holds a single-instance lock, so the second launch simply brings the
rem  existing window forward and exits.
rem
rem  Usage:
rem    start.bat              launch, leaving no console window behind
rem    start.bat --console    launch with the application log in this window
rem    start.bat --help       this text
rem ===========================================================================

setlocal EnableExtensions
title NexaFiles launcher
cd /d "%~dp0"

rem -- the whole point of this file -------------------------------------------
set "ELECTRON_RUN_AS_NODE="

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
set "KEEPCONSOLE="

for %%A in (%*) do (
    if /I "%%~A"=="--console" set "KEEPCONSOLE=1"
    if /I "%%~A"=="-c"        set "KEEPCONSOLE=1"
    if /I "%%~A"=="--help"    goto :help
    if /I "%%~A"=="-h"        goto :help
)

if not exist "%ELECTRON%" goto :missingelectron

:launch
rem  The path ends in "." rather than a backslash on purpose: a trailing
rem  backslash immediately before the closing quote escapes that quote, and the
rem  argument arrives mangled.
if defined KEEPCONSOLE goto :attached

start "" "%ELECTRON%" "%~dp0."
exit /b 0

:attached
echo Starting NexaFiles. Its log appears below.
echo Closing this window closes the application, so leave it open.
echo.
"%ELECTRON%" "%~dp0."
set "CODE=%ERRORLEVEL%"
echo.
echo NexaFiles has closed (exit code %CODE%).
pause
exit /b %CODE%

:missingelectron
echo Electron is not installed in this folder.
echo.
if exist "%~dp0node_modules" (
    echo   node_modules exists, but node_modules\electron\dist\electron.exe does not.
) else (
    echo   node_modules is missing entirely.
)
echo.
set "INSTALL="
set /p "INSTALL=Run npm install now? [Y/N] "
if /I not "%INSTALL%"=="Y" goto :noinstall

echo.
call npm install
if errorlevel 1 goto :installfailed
if not exist "%ELECTRON%" goto :installfailed
echo.
goto :launch

:noinstall
echo.
echo Nothing was started. Run "npm install" in this folder, then try again.
pause
exit /b 1

:installfailed
echo.
echo The install did not produce a working Electron. Nothing was started.
pause
exit /b 1

:help
echo.
echo   start.bat              Launch NexaFiles. No console window is left behind.
echo   start.bat --console    Launch with the application log shown in this window.
echo   start.bat --help       This text.
echo.
echo   The script clears ELECTRON_RUN_AS_NODE before launching. With that
echo   variable set, Electron runs as plain Node and NexaFiles cannot start.
echo.
echo   Note: "start" is also a built-in command, so from a terminal type
echo   .\start.bat rather than start.
echo.
pause
exit /b 0
