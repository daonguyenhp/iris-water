@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Iris Water — Smart Wastewater Basin Monitoring System
cls

if not exist ".venv\Scripts\python.exe" (
    echo [*] First-time run detected. Launching automatic environment setup...
    echo.
    call "1_Cai_Dat_Tu_Dong.bat"
    if not exist ".venv\Scripts\python.exe" (
        echo [ERROR] Environment setup failed. Cannot start server.
        pause
        exit /b 1
    )
    cls
)

echo ===============================================================================
echo      IRIS WATER — SMART WASTEWATER TREATMENT MONITORING SYSTEM
echo ===============================================================================
echo  [*] Status: Starting Vision Engine and Web Server...
echo  [*] Home & Operator Guide: http://localhost:8000/
echo  [*] Live Monitoring Console: http://localhost:8000/app
echo ===============================================================================
echo.
echo  Press [Ctrl + C] to stop the server safely.
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8000"

"%~dp0.venv\Scripts\python.exe" "%~dp0main.py" --no-gui

echo.
echo [Server stopped]
pause
