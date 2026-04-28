@echo off
echo Setting up VS environment ...

set "INCLUDE=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.44.35207\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared"
set "LIB=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.44.35207\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64"

echo Environment set ...

set "NPM_CLI=%APPDATA%\npm\node_modules\npm\bin\npm-cli.js"
if not exist "%NPM_CLI%" (
    set "NPM_CLI=%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js"
)

if "%~1"=="" (
    set "COMMAND=dev"
) else (
    set "COMMAND=%~1"
)

set "PROJECT_DIR=%~dp0"

if exist "%~dp0%COMMAND%" (
    set "PROJECT_DIR=%~dp0%COMMAND%"
    if "%~2"=="" (
        set "COMMAND=dev"
    ) else (
        set "COMMAND=%~2"
    )
)

echo Starting %PROJECT_DIR% ...
cd /d "%PROJECT_DIR%"

if exist "package.json" (
    if /i "%COMMAND%"=="dev" (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 1422 -State Listen -ErrorAction SilentlyContinue) { Write-Host 'Warning: port 1422 is already in use. Stop that process or change the Tauri/Vite port before continuing.' -ForegroundColor Yellow }"
        if exist "%NPM_CLI%" (
            node "%NPM_CLI%" run tauri dev
        ) else (
            npm run tauri dev
        )
    ) else if /i "%COMMAND%"=="build" (
        npm run tauri build
    ) else if /i "%COMMAND%"=="frontend" (
        npm run build
    ) else if /i "%COMMAND%"=="check" (
        npm run build
        if errorlevel 1 exit /b 1
        cd /d "%PROJECT_DIR%src-tauri"
        cargo check
    ) else (
        echo Error: Unknown command "%COMMAND%"
        echo.
        echo Usage:
        echo   dev.bat
        echo   dev.bat dev
        echo   dev.bat build
        echo   dev.bat frontend
        echo   dev.bat check
        echo   dev.bat ^<project-folder^> [dev^|build^|frontend^|check]
        pause
        exit /b 1
    )
) else if exist "Cargo.toml" (
    if /i "%COMMAND%"=="dev" (
        cargo run
    ) else if /i "%COMMAND%"=="build" (
        cargo build
    ) else if /i "%COMMAND%"=="check" (
        cargo check
    ) else (
        echo Error: Unknown command "%COMMAND%"
        pause
        exit /b 1
    )
) else (
    echo Error: Unknown project type, no package.json or Cargo.toml found
    pause
    exit /b 1
)
