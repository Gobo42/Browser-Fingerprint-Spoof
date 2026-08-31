# Windows wrapper for capture-fingerprint.js
# Usage: .\capture.ps1 [-OutputPath fingerprint.json]

param(
    [string]$OutputPath = "fingerprint.json"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is required but was not found on PATH. Install it from https://nodejs.org/ and re-run."
    exit 1
}

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..."
    npm install
    npx playwright install chrome
}

node src/capture-fingerprint.js $OutputPath
