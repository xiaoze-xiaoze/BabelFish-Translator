@echo off
echo Setting up VS environment ...

set "INCLUDE=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.44.35207\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared"
set "LIB=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.44.35207\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64"

echo Environment set ...

if "%~1"=="" (
    echo.
    echo Usage: dev.bat ^<project^>
    echo Example: dev.bat Tauri002
    echo Example: dev.bat mcp-beaver
    echo.
    echo Available projects:
    for /d %%d in (*) do echo   %%d
    pause
    exit /b 1
)

if not exist "%~dp0%~1" (
    echo Error: Project "%~1" not found
    pause
    exit /b 1
)

echo Starting %~1 ...
cd /d "%~dp0%~1"

if exist "package.json" (
    npm run tauri dev
) else if exist "Cargo.toml" (
    cargo build
) else (
    echo Error: Unknown project type, no package.json or Cargo.toml found
    pause
    exit /b 1
)
