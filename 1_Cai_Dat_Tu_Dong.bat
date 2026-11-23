@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Iris Water — Automatic Environment Setup
cls

echo ===============================================================================
echo   IRIS WATER — WASTEWATER MONITORING ENVIRONMENT SETUP
echo ===============================================================================
echo.
echo [*] Checking Python installation...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Python is not installed or not in PATH.
    echo         Please install Python 3.11 from https://www.python.org/downloads/
    echo         Ensure "[x] Add python.exe to PATH" is checked during installation.
    echo.
    pause
    exit /b 1
)

python --version

if not exist ".venv" (
    echo.
    echo [*] Creating Python 3.11 virtual environment (.venv)...
    python -m venv .venv
)

echo.
echo [*] Installing required dependencies (FastAPI, OpenCV, Ultralytics, ONNX Runtime)...
echo.

.\.venv\Scripts\python.exe -m pip install --upgrade pip >nul 2>&1
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

echo.
echo ===============================================================================
echo  [OK] Environment setup completed.
echo       Run 2_Chay_He_Thong.bat to launch the monitoring system.
echo ===============================================================================
echo.
pause
