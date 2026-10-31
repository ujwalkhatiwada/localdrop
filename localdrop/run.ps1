# LocalDrop Windows PowerShell QuickStart Script
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "    LocalDrop - Local Network File Transfer      " -ForegroundColor Yellow
Write-Host "=================================================" -ForegroundColor Cyan

# Check Python installation
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Python is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Please install Python 3.10+ from python.org"
    Exit 1
}

# Create virtual environment if missing
if (-not (Test-Path ".venv")) {
    Write-Host "[*] Creating virtual environment (.venv)..." -ForegroundColor Green
    python -m venv .venv
}

# Activate virtualenv
& .venv\Scripts\Activate.ps1

Write-Host "[*] Installing required dependencies..." -ForegroundColor Green
pip install -q fastapi "uvicorn[standard]" python-multipart qrcode[pil] vobject httpx pytest

Write-Host "[*] Starting LocalDrop with explicit LAN access..." -ForegroundColor Cyan
python -m localdrop.app.main --lan --port 8000
