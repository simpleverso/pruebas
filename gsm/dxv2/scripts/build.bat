@echo off
REM Rebuild dxv2\build\translator.wasm from scripts\database.js + scripts\rules.js.
REM Re-run this any time you edit those two files.
setlocal

REM Move into the project root (parent of this scripts\ directory) so paths
REM like build\, node_modules\, scripts\compile_build.js all resolve
REM correctly regardless of where the script was invoked from.
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
    echo error: 'node' is not on your PATH. Install Node.js ^(^>=18^) and try again. 1>&2
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo error: 'npm' is not on your PATH. Install Node.js ^(which ships with npm^) and try again. 1>&2
    exit /b 1
)

REM Install dependencies the first time, or whenever node_modules is missing.
if not exist "node_modules" (
    echo ==^> installing dependencies ^(first run^)
    call npm install --no-audit --no-fund
    if errorlevel 1 exit /b %errorlevel%
)

echo ==^> building translator.wasm
call node scripts\compile_build.js
if errorlevel 1 exit /b %errorlevel%

echo.
echo Build complete. Output: build\translator.wasm

endlocal
